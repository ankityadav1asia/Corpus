package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// OpenAIConfig is a server that speaks the OpenAI REST dialect — the usual way to run open-source
// models (Ollama, vLLM, LM Studio, llama.cpp server, Groq, Together, OpenRouter, …).
type OpenAIConfig struct {
	BaseURL   string
	APIKey    string // optional: local servers usually need none
	Model     string
	FastModel string
	Client    *http.Client
}

const (
	openAITimeout    = 180 * time.Second
	openAIAttempts   = 3
	openAIEmbedBatch = 64
)

type openAI struct{ cfg OpenAIConfig }

func (o openAI) client() *http.Client {
	if o.cfg.Client != nil {
		return o.cfg.Client
	}
	return &http.Client{Timeout: openAITimeout}
}

func (o openAI) post(ctx context.Context, path string, payload any, label string) (*http.Response, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	url := strings.TrimRight(o.cfg.BaseURL, "/") + path
	return withRetry(ctx, openAIAttempts, func() (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(encoded))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		if o.cfg.APIKey != "" {
			req.Header.Set("Authorization", "Bearer "+o.cfg.APIKey)
		}
		res, err := o.client().Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, &Error{Message: "Request aborted"}
			}
			return nil, &Error{Message: label + " (network)", Retryable: true}
		}
		if res.StatusCode >= 300 {
			// Never include the body: it can echo the prompt.
			io.Copy(io.Discard, io.LimitReader(res.Body, 64*1024))
			res.Body.Close()
			retryAfter, _ := strconv.ParseFloat(res.Header.Get("Retry-After"), 64)
			return nil, &Error{Message: fmt.Sprintf("%s (%d)", label, res.StatusCode), Status: res.StatusCode, Retryable: res.StatusCode == 429 || res.StatusCode >= 500, RetryAfter: retryAfter}
		}
		return res, nil
	})
}

func messages(system string, turns []Turn) []map[string]string {
	list := []map[string]string{{"role": "system", "content": system}}
	for _, turn := range turns {
		list = append(list, map[string]string{"role": turn.Role, "content": turn.Content})
	}
	return list
}

func (o openAI) completion(ctx context.Context, body map[string]any) (string, error) {
	res, err := o.post(ctx, "/chat/completions", body, "Model request failed")
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var parsed struct {
		Choices []struct {
			Message struct {
				Content *string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return "", &Error{Message: "Model request failed", Retryable: true}
	}
	if len(parsed.Choices) == 0 || parsed.Choices[0].Message.Content == nil {
		return "", nil
	}
	return StripThinking(*parsed.Choices[0].Message.Content), nil
}

// openAIChat is the chat half of an OpenAI-compatible provider.
type openAIChat struct{ openAI }

func (o openAIChat) ChatModel() string { return o.cfg.Model }

func (o openAIChat) StreamChat(ctx context.Context, system string, turns []Turn, _ bool, emit func(string) error) error {
	res, err := o.post(ctx, "/chat/completions", map[string]any{"model": o.cfg.Model, "messages": messages(system, turns), "temperature": 0.2, "stream": true}, "Model request failed")
	if err != nil {
		return err
	}
	defer res.Body.Close()
	filter := &ThinkFilter{}
	err = readSSE(res.Body, func(data string) error {
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content *string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(data), &chunk) != nil || len(chunk.Choices) == 0 || chunk.Choices[0].Delta.Content == nil {
			return nil // keep-alive comments and malformed lines
		}
		if visible := filter.Push(*chunk.Choices[0].Delta.Content); visible != "" {
			return emit(visible)
		}
		return nil
	}, func() error {
		if ctx.Err() != nil {
			return &Error{Message: "Request aborted"}
		}
		return &Error{Message: "Model stream failed"}
	})
	if err != nil {
		return err
	}
	if rest := filter.Flush(); rest != "" {
		return emit(rest)
	}
	return nil
}

func (o openAIChat) Complete(ctx context.Context, input Completion) (string, error) {
	model := o.cfg.Model
	if input.Fast && o.cfg.FastModel != "" {
		model = o.cfg.FastModel
	}
	body := map[string]any{"model": model, "messages": messages(input.System, []Turn{{Role: "user", Content: input.Prompt}}), "temperature": input.Temperature}
	if !input.JSON {
		return o.completion(ctx, body)
	}
	withFormat := map[string]any{"response_format": map[string]string{"type": "json_object"}}
	for k, v := range body {
		withFormat[k] = v
	}
	text, err := o.completion(ctx, withFormat)
	// Some servers do not support JSON mode; the parsers are lenient, so ask again without it.
	if vendor, ok := AsError(err); ok && (vendor.Status == 400 || vendor.Status == 422) {
		return o.completion(ctx, body)
	}
	return text, err
}

// openAIEmbeddings is the embedding half.
type openAIEmbeddings struct{ openAI }

func (o openAIEmbeddings) EmbeddingModel() string { return "openai-compatible/" + o.cfg.Model }

// fitEmbedding zero-pads smaller vectors to 3072 dimensions, which keeps cosine similarity
// unchanged; larger ones are rejected.
func fitEmbedding(values []float64, model string) ([]float64, error) {
	if len(values) == 0 {
		return nil, &Error{Message: fmt.Sprintf("Embedding model %s returned an empty vector", model)}
	}
	if len(values) > EmbeddingDimensions {
		return nil, &Error{Message: fmt.Sprintf("Embedding model %s returns %d dimensions; at most %d are supported.", model, len(values), EmbeddingDimensions)}
	}
	padded := make([]float64, EmbeddingDimensions)
	copy(padded, values)
	return padded, nil
}

func (o openAIEmbeddings) embed(ctx context.Context, texts []string) ([][]float64, error) {
	out := make([][]float64, 0, len(texts))
	for i := 0; i < len(texts); i += openAIEmbedBatch {
		batch := texts[i:min(i+openAIEmbedBatch, len(texts))]
		res, err := o.post(ctx, "/embeddings", map[string]any{"model": o.cfg.Model, "input": batch, "encoding_format": "float"}, "Embedding request failed")
		if err != nil {
			return nil, err
		}
		var parsed struct {
			Data []struct {
				Embedding []float64 `json:"embedding"`
				Index     int       `json:"index"`
			} `json:"data"`
		}
		decodeErr := json.NewDecoder(res.Body).Decode(&parsed)
		res.Body.Close()
		if decodeErr != nil {
			return nil, &Error{Message: "Embedding request failed", Retryable: true}
		}
		sort.SliceStable(parsed.Data, func(a, b int) bool { return parsed.Data[a].Index < parsed.Data[b].Index })
		if len(parsed.Data) != len(batch) {
			return nil, &Error{Message: fmt.Sprintf("Embedding batch returned %d vectors for %d inputs", len(parsed.Data), len(batch))}
		}
		for _, row := range parsed.Data {
			vector, err := fitEmbedding(row.Embedding, o.cfg.Model)
			if err != nil {
				return nil, err
			}
			out = append(out, vector)
		}
	}
	return out, nil
}

func (o openAIEmbeddings) EmbedQueries(ctx context.Context, texts []string) ([][]float64, error) {
	return o.embed(ctx, texts)
}

func (o openAIEmbeddings) EmbedDocuments(ctx context.Context, texts []string) ([][]float64, error) {
	return o.embed(ctx, texts)
}

// chatPart and embeddingPart let one provider combine separately configured back ends.
type chatPart interface {
	ChatModel() string
	StreamChat(ctx context.Context, system string, turns []Turn, fast bool, emit func(string) error) error
	Complete(ctx context.Context, input Completion) (string, error)
}

type embeddingPart interface {
	EmbeddingModel() string
	EmbedQueries(ctx context.Context, texts []string) ([][]float64, error)
	EmbedDocuments(ctx context.Context, texts []string) ([][]float64, error)
}

type combined struct {
	chatPart
	embeddingPart
}

// Combine builds one Provider from a chat back end and an embedding back end.
func Combine(chat, embeddings Provider) Provider { return combined{chat, embeddings} }

// NewOpenAIChat and NewOpenAIEmbeddings are the two halves of an OpenAI-compatible server; pair
// them with Combine (or with a Gemini half).
func NewOpenAIChat(cfg OpenAIConfig) Provider { return combined{openAIChat{openAI{cfg}}, nil} }

func NewOpenAIEmbeddings(cfg OpenAIConfig) Provider {
	return combined{nil, openAIEmbeddings{openAI{cfg}}}
}

// ThinkFilter removes <think>…</think> reasoning from streamed text, including tags split across
// chunks (DeepSeek-R1, Qwen3 and other open reasoning models).
type ThinkFilter struct {
	inside  bool
	pending string
}

const (
	thinkOpen  = "<think>"
	thinkClose = "</think>"
)

func (f *ThinkFilter) Push(chunk string) string {
	text := f.pending + chunk
	f.pending = ""
	var visible strings.Builder
	for text != "" {
		tag := thinkOpen
		if f.inside {
			tag = thinkClose
		}
		if at := strings.Index(text, tag); at != -1 {
			if !f.inside {
				visible.WriteString(text[:at])
			}
			text = text[at+len(tag):]
			f.inside = !f.inside
			continue
		}
		// Keep a possible partial tag at the end for the next chunk.
		keep := 0
		for length := min(len(tag)-1, len(text)); length > 0; length-- {
			if strings.HasPrefix(tag, text[len(text)-length:]) {
				keep = length
				break
			}
		}
		if !f.inside {
			visible.WriteString(text[:len(text)-keep])
		}
		f.pending = text[len(text)-keep:]
		text = ""
	}
	return visible.String()
}

func (f *ThinkFilter) Flush() string {
	rest := ""
	if !f.inside {
		rest = f.pending
	}
	f.pending = ""
	return rest
}

// StripThinking removes reasoning from a complete reply.
func StripThinking(text string) string {
	filter := &ThinkFilter{}
	return strings.TrimSpace(filter.Push(text) + filter.Flush())
}

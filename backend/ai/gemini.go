package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// GeminiConfig names the Gemini models; the API key comes from GOOGLE_API_KEY / GEMINI_API_KEY.
type GeminiConfig struct {
	APIKey         string
	ChatModel      string
	EmbeddingModel string
	FastModel      string // "" uses the chat model with thinking off
	BaseURL        string // tests point this at a fake server
	Client         *http.Client
}

const (
	geminiBaseURL      = "https://generativelanguage.googleapis.com/v1beta"
	geminiAttempts     = 4
	geminiEmbedBatch   = 100
	geminiEmbedWorkers = 3
	geminiChatTemp     = 0.2
)

type gemini struct {
	cfg GeminiConfig
	// Models that reject a thinking setting (some open models) are asked without it.
	thinkingUnsupported sync.Map
}

// NewGemini returns a Provider backed by the Gemini REST API.
func NewGemini(cfg GeminiConfig) Provider {
	if cfg.BaseURL == "" {
		cfg.BaseURL = geminiBaseURL
	}
	if cfg.Client == nil {
		cfg.Client = &http.Client{}
	}
	return &gemini{cfg: cfg}
}

func (g *gemini) ChatModel() string      { return g.cfg.ChatModel }
func (g *gemini) EmbeddingModel() string { return g.cfg.EmbeddingModel }

// thinkingOff: Gemini 3 models take a thinking level, 2.x models a budget.
var gemini3 = regexp.MustCompile(`(?i)^gemini-3`)

func thinkingOff(model string) map[string]any {
	if gemini3.MatchString(model) {
		return map[string]any{"thinkingLevel": "low"}
	}
	return map[string]any{"thinkingBudget": 0}
}

type part struct {
	Text    string `json:"text,omitempty"`
	Thought bool   `json:"thought,omitempty"`
}

type content struct {
	Role  string `json:"role,omitempty"`
	Parts []part `json:"parts"`
}

type candidateResponse struct {
	Candidates []struct {
		Content content `json:"content"`
	} `json:"candidates"`
	UsageMetadata *geminiUsage `json:"usageMetadata"`
}

// answerText joins the answer parts; reasoning parts marked thought are never shown or parsed.
func answerText(r candidateResponse) string {
	if len(r.Candidates) == 0 {
		return ""
	}
	var b strings.Builder
	for _, p := range r.Candidates[0].Content.Parts {
		if !p.Thought {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

// geminiError maps a failed response, reading Google's RetryInfo and QuotaFailure details.
func geminiError(label string, status int, body []byte) *Error {
	var parsed struct {
		Error struct {
			Message string            `json:"message"`
			Details []json.RawMessage `json:"details"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &parsed)
	err := &Error{Message: fmt.Sprintf("%s (%d)", label, status), Status: status, Retryable: retryableStatus(status)}
	for _, raw := range parsed.Error.Details {
		var detail struct {
			Type       string `json:"@type"`
			RetryDelay string `json:"retryDelay"`
			Violations []struct {
				QuotaID string `json:"quotaId"`
			} `json:"violations"`
		}
		if json.Unmarshal(raw, &detail) != nil {
			continue
		}
		if strings.HasSuffix(detail.Type, "RetryInfo") {
			if seconds, convErr := strconv.ParseFloat(strings.TrimSuffix(detail.RetryDelay, "s"), 64); convErr == nil && seconds >= 0 {
				err.RetryAfter = seconds
			}
		}
		for _, violation := range detail.Violations {
			if strings.Contains(strings.ToLower(violation.QuotaID), "perday") {
				err.DailyQuota = status == 429
			}
		}
	}
	if err.DailyQuota {
		err.Retryable = false
	}
	return err
}

// rejectsThinking: a 400 whose message mentions thinking means the model does not take the setting.
func rejectsThinking(err error, body []byte) bool {
	vendor, ok := AsError(err)
	return ok && vendor.Status == 400 && strings.Contains(strings.ToLower(string(body)), "thinking")
}

// post sends a JSON request; on failure it returns the vendor error and the response body.
func (g *gemini) post(ctx context.Context, path string, payload any, label string) (*http.Response, []byte, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.cfg.BaseURL+path, bytes.NewReader(encoded))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", g.cfg.APIKey)
	res, err := g.cfg.Client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, nil, &Error{Message: "Request aborted"}
		}
		return nil, nil, &Error{Message: label + " (network)", Retryable: true}
	}
	if res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 64*1024))
		res.Body.Close()
		return nil, body, geminiError(label, res.StatusCode, body)
	}
	return res, nil, nil
}

func (g *gemini) generationConfig(model string, base map[string]any, off bool) map[string]any {
	config := map[string]any{}
	for k, v := range base {
		config[k] = v
	}
	if off {
		config["thinkingConfig"] = thinkingOff(model)
	}
	return config
}

// withThinkingChoice runs a request with thinking off when asked, falling back once to the
// model's default when the model rejects the setting.
func (g *gemini) withThinkingChoice(model string, fast bool, run func(off bool) (*http.Response, []byte, error)) (*http.Response, error) {
	_, unsupported := g.thinkingUnsupported.Load(model)
	off := fast && !unsupported
	res, body, err := run(off)
	if err != nil && off && rejectsThinking(err, body) {
		g.thinkingUnsupported.Store(model, true)
		res, _, err = run(false)
	}
	return res, err
}

func (g *gemini) embed(ctx context.Context, texts []string, task string) ([][]float64, error) {
	if len(texts) == 0 {
		return [][]float64{}, nil
	}
	batches := [][]string{}
	for i := 0; i < len(texts); i += geminiEmbedBatch {
		batches = append(batches, texts[i:min(i+geminiEmbedBatch, len(texts))])
	}
	results := make([][][]float64, len(batches))
	errs := make([]error, len(batches))
	jobs := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < min(geminiEmbedWorkers, len(batches)); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				results[index], errs[index] = g.embedBatch(ctx, batches[index], task)
			}
		}()
	}
	for index := range batches {
		jobs <- index
	}
	close(jobs)
	wg.Wait()
	out := make([][]float64, 0, len(texts))
	for index, batch := range results {
		if errs[index] != nil {
			return nil, errs[index]
		}
		out = append(out, batch...)
	}
	return out, nil
}

func (g *gemini) embedBatch(ctx context.Context, texts []string, task string) ([][]float64, error) {
	model := "models/" + g.cfg.EmbeddingModel
	requests := make([]map[string]any, len(texts))
	for i, text := range texts {
		requests[i] = map[string]any{"model": model, "content": content{Role: "user", Parts: []part{{Text: text}}}, "taskType": task}
	}
	return withRetry(ctx, geminiAttempts, func() ([][]float64, error) {
		res, _, err := g.post(ctx, "/"+model+":batchEmbedContents", map[string]any{"requests": requests}, "Gemini request failed")
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		var parsed struct {
			Embeddings []struct {
				Values []float64 `json:"values"`
			} `json:"embeddings"`
		}
		if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
			return nil, &Error{Message: "Gemini request failed", Retryable: true}
		}
		if len(parsed.Embeddings) != len(texts) {
			return nil, &Error{Message: fmt.Sprintf("Embedding batch returned %d vectors for %d inputs", len(parsed.Embeddings), len(texts))}
		}
		vectors := make([][]float64, len(texts))
		for i, embedding := range parsed.Embeddings {
			if err := checkEmbedding(embedding.Values); err != nil {
				return nil, err
			}
			vectors[i] = embedding.Values
		}
		// The embedding API does not count tokens.
		record(ctx, Usage{Model: g.cfg.EmbeddingModel, Kind: "embed", InputTokens: EstimateTokens(texts...), Estimated: true})
		return vectors, nil
	})
}

func (g *gemini) EmbedQueries(ctx context.Context, texts []string) ([][]float64, error) {
	return g.embed(ctx, texts, "RETRIEVAL_QUERY")
}

func (g *gemini) EmbedDocuments(ctx context.Context, texts []string) ([][]float64, error) {
	return g.embed(ctx, texts, "RETRIEVAL_DOCUMENT")
}

func toContents(turns []Turn) []content {
	contents := make([]content, len(turns))
	for i, turn := range turns {
		role := "user"
		if turn.Role == "assistant" {
			role = "model"
		}
		contents[i] = content{Role: role, Parts: []part{{Text: turn.Content}}}
	}
	return contents
}

func (g *gemini) StreamChat(ctx context.Context, system string, turns []Turn, fast bool, emit func(string) error) error {
	model := g.cfg.ChatModel
	start := func(off bool) (*http.Response, []byte, error) {
		return g.post(ctx, "/models/"+model+":streamGenerateContent?alt=sse", map[string]any{
			"systemInstruction": content{Parts: []part{{Text: system}}},
			"contents":          toContents(turns),
			"generationConfig":  g.generationConfig(model, map[string]any{"temperature": geminiChatTemp}, off),
		}, "Gemini request failed")
	}
	// Only the initial request is retried; a stream that fails midway is surfaced to the caller.
	res, err := withRetry(ctx, geminiAttempts, func() (*http.Response, error) { return g.withThinkingChoice(model, fast, start) })
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var answer strings.Builder
	var usage *geminiUsage
	err = readSSE(res.Body, func(data string) error {
		var chunk candidateResponse
		if json.Unmarshal([]byte(data), &chunk) != nil {
			return nil
		}
		if chunk.UsageMetadata != nil {
			usage = chunk.UsageMetadata // the last chunk carries the totals
		}
		if text := answerText(chunk); text != "" {
			answer.WriteString(text)
			return emit(text)
		}
		return nil
	}, func() error {
		if ctx.Err() != nil {
			return &Error{Message: "Request aborted"}
		}
		return &Error{Message: "Gemini request failed", Retryable: false}
	})
	if err == nil {
		prompt := []string{system}
		for _, turn := range turns {
			prompt = append(prompt, turn.Content)
		}
		recordGemini(ctx, model, usage, prompt, answer.String())
	}
	return err
}

func (g *gemini) Complete(ctx context.Context, input Completion) (string, error) {
	model := g.cfg.ChatModel
	if input.Fast && g.cfg.FastModel != "" {
		model = g.cfg.FastModel
	}
	base := map[string]any{"temperature": input.Temperature}
	if input.JSON {
		base["responseMimeType"] = "application/json"
	}
	run := func(off bool) (*http.Response, []byte, error) {
		return g.post(ctx, "/models/"+model+":generateContent", map[string]any{
			"systemInstruction": content{Parts: []part{{Text: input.System}}},
			"contents":          []content{{Role: "user", Parts: []part{{Text: input.Prompt}}}},
			"generationConfig":  g.generationConfig(model, base, off),
		}, "Gemini request failed")
	}
	return withRetry(ctx, geminiAttempts, func() (string, error) {
		res, err := g.withThinkingChoice(model, input.Fast, run)
		if err != nil {
			return "", err
		}
		defer res.Body.Close()
		var parsed candidateResponse
		if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
			return "", &Error{Message: "Gemini request failed", Retryable: true}
		}
		text := answerText(parsed)
		recordGemini(ctx, model, parsed.UsageMetadata, []string{input.System, input.Prompt}, text)
		return text, nil
	})
}

// readSSE calls onData with each `data:` payload of a server-sent event stream; broken streams
// end with failed().
func readSSE(body io.Reader, onData func(string) error, failed func() error) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			return nil
		}
		if err := onData(data); err != nil {
			return err
		}
	}
	if scanner.Err() != nil {
		return failed()
	}
	return nil
}

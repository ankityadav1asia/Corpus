package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// roundTrip answers requests in-process (no sockets), recording what was sent.
type roundTrip func(*http.Request) *http.Response

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r), nil }

func reply(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}
}

func fakeGemini(t *testing.T, handle func(path string, body map[string]any) *http.Response) Provider {
	t.Helper()
	client := &http.Client{Transport: roundTrip(func(r *http.Request) *http.Response {
		if r.Header.Get("x-goog-api-key") != "key-0123456789abcdefghij" {
			t.Errorf("missing API key header")
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		return handle(r.URL.Path+"?"+r.URL.RawQuery, body)
	})}
	return NewGemini(GeminiConfig{APIKey: "key-0123456789abcdefghij", ChatModel: "gemini-2.5-flash", EmbeddingModel: "gemini-embedding-001", BaseURL: "https://fake", Client: client})
}

func TestGeminiCompletionDropsThoughtsAndRetriesWithoutThinking(t *testing.T) {
	calls := 0
	provider := fakeGemini(t, func(path string, body map[string]any) *http.Response {
		calls++
		config := body["generationConfig"].(map[string]any)
		if _, off := config["thinkingConfig"]; off {
			return reply(400, `{"error":{"code":400,"message":"Thinking budget is not supported for this model."}}`)
		}
		if config["responseMimeType"] != "application/json" || !strings.HasSuffix(strings.Split(path, "?")[0], ":generateContent") {
			t.Errorf("request = %s %v", path, body)
		}
		return reply(200, `{"candidates":[{"content":{"parts":[{"text":"hidden reasoning","thought":true},{"text":"[1,2]"}]}}]}`)
	})
	text, err := provider.Complete(context.Background(), Completion{System: "s", Prompt: "p", JSON: true, Fast: true})
	if err != nil || text != "[1,2]" || calls != 2 {
		t.Fatalf("text %q err %v calls %d", text, err, calls)
	}
	// The model is remembered: the next fast call goes without the thinking setting at once.
	if _, err := provider.Complete(context.Background(), Completion{System: "s", Prompt: "p", JSON: true, Fast: true}); err != nil || calls != 3 {
		t.Fatalf("second call: %v, calls %d", err, calls)
	}
}

func TestGeminiStreamsAnswerText(t *testing.T) {
	provider := fakeGemini(t, func(path string, body map[string]any) *http.Response {
		if !strings.Contains(path, ":streamGenerateContent?alt=sse") {
			t.Errorf("path %s", path)
		}
		contents := body["contents"].([]any)
		if contents[1].(map[string]any)["role"] != "model" {
			t.Errorf("assistant turns are sent as model: %v", contents)
		}
		return reply(200, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hel\"}]}}]}\n\n"+
			"data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ignored\",\"thought\":true},{\"text\":\"lo\"}]}}]}\n\n")
	})
	var pieces []string
	err := provider.StreamChat(context.Background(), "system", []Turn{{Role: "user", Content: "q"}, {Role: "assistant", Content: "a"}, {Role: "user", Content: "q2"}}, false, func(text string) error {
		pieces = append(pieces, text)
		return nil
	})
	if err != nil || strings.Join(pieces, "|") != "Hel|lo" {
		t.Fatalf("pieces %v err %v", pieces, err)
	}
}

func TestGeminiErrorsCarryRetryHintsAndDailyQuotas(t *testing.T) {
	provider := fakeGemini(t, func(string, map[string]any) *http.Response {
		return reply(429, `{"error":{"code":429,"message":"quota","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"37s"}]}}`)
	})
	_, err := provider.Complete(context.Background(), Completion{System: "s", Prompt: "p"})
	vendor, ok := AsError(err)
	if !ok || !vendor.DailyQuota || vendor.Retryable || vendor.RetryAfter != 37 || vendor.Status != 429 || strings.Contains(vendor.Message, "quota") {
		t.Fatalf("error = %+v", vendor)
	}
	if UserMessage(vendor) != DailyQuotaMessage {
		t.Fatalf("message = %q", UserMessage(vendor))
	}
}

func TestGeminiEmbeddingsAreBatchedAndChecked(t *testing.T) {
	provider := fakeGemini(t, func(path string, body map[string]any) *http.Response {
		requests := body["requests"].([]any)
		if requests[0].(map[string]any)["taskType"] != "RETRIEVAL_QUERY" {
			t.Errorf("task type %v", requests[0])
		}
		vector := make([]float64, EmbeddingDimensions)
		embeddings := make([]map[string]any, len(requests))
		for i := range requests {
			embeddings[i] = map[string]any{"values": vector}
		}
		encoded, _ := json.Marshal(map[string]any{"embeddings": embeddings})
		return reply(200, string(encoded))
	})
	vectors, err := provider.EmbedQueries(context.Background(), make([]string, 150))
	if err != nil || len(vectors) != 150 || len(vectors[149]) != EmbeddingDimensions {
		t.Fatalf("vectors %d err %v", len(vectors), err)
	}
	short := fakeGemini(t, func(string, map[string]any) *http.Response {
		return reply(200, `{"embeddings":[{"values":[1,2,3]}]}`)
	})
	if _, err := short.EmbedQueries(context.Background(), []string{"x"}); err == nil || !strings.Contains(err.Error(), "3 dimensions") {
		t.Fatalf("a short vector must fail loudly: %v", err)
	}
}

func TestConfigReadsTheSameVariablesAsTypeScript(t *testing.T) {
	env := func(values map[string]string) getenv { return func(name string) string { return values[name] } }
	if _, err := build(env(map[string]string{})); err == nil || !strings.Contains(err.Error(), "GOOGLE_API_KEY") {
		t.Fatalf("no key: %v", err)
	}
	if _, err := build(env(map[string]string{"GOOGLE_API_KEY": "your-key-goes-here-1234567"})); err == nil {
		t.Fatal("a placeholder key is not a key")
	}
	provider, err := build(env(map[string]string{"GEMINI_API_KEY": "key-0123456789abcdefghij", "GEMINI_CHAT_MODEL": "gemini-2.5-pro"}))
	if err != nil || provider.ChatModel() != "gemini-2.5-pro" || provider.EmbeddingModel() != "gemini-embedding-001" {
		t.Fatalf("gemini: %v %v", provider, err)
	}
	mixed, err := build(env(map[string]string{"GOOGLE_API_KEY": "key-0123456789abcdefghij", "CHAT_PROVIDER": "openai-compatible", "OPENAI_COMPATIBLE_BASE_URL": "http://localhost:11434/v1", "OPENAI_COMPATIBLE_CHAT_MODEL": "qwen3"}))
	if err != nil || mixed.ChatModel() != "qwen3" || mixed.EmbeddingModel() != "gemini-embedding-001" {
		t.Fatalf("mixed: %v", err)
	}
	if _, err := build(env(map[string]string{"CHAT_PROVIDER": "openai-compatible", "OPENAI_COMPATIBLE_CHAT_MODEL": "qwen3", "OPENAI_COMPATIBLE_BASE_URL": "ftp://x"})); err == nil {
		t.Fatal("an ftp base URL is refused")
	}
	for values, want := range map[string]string{"": "llm", "none": "none", "cohere": "error", "auto+key": "cohere"} {
		vars := map[string]string{"RERANKER": values}
		if values == "auto+key" {
			vars = map[string]string{"COHERE_API_KEY": "k"}
		}
		config, err := rerankerConfig(env(vars))
		got := config.Kind
		if err != nil {
			got = "error"
		}
		if got != want {
			t.Fatalf("RERANKER=%q → %s, want %s", values, got, want)
		}
	}
}

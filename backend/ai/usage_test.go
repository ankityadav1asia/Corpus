package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func recording(t *testing.T) *[]Usage {
	t.Helper()
	var got []Usage
	previous := Recorder
	Recorder = func(_ context.Context, u Usage) { got = append(got, u) }
	t.Cleanup(func() { Recorder = previous })
	return &got
}

func TestModelCallsAreMeteredToTheScope(t *testing.T) {
	got := recording(t)
	provider := fakeGemini(t, func(path string, body map[string]any) *http.Response {
		switch {
		case strings.Contains(path, ":streamGenerateContent"):
			return reply(200, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hi\"}]}}]}\n\n"+
				"data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"!\"}]}}],\"usageMetadata\":{\"promptTokenCount\":40,\"candidatesTokenCount\":2,\"totalTokenCount\":50}}\n\n")
		case strings.Contains(path, ":batchEmbedContents"):
			return reply(200, `{"embeddings":[{"values":`+vector()+`}]}`)
		}
		return reply(200, `{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`) // no usageMetadata
	})
	scoped := WithScope(context.Background(), Scope{WorkspaceID: "w1", UserID: "u1", Feature: "chat"})

	if err := provider.StreamChat(scoped, "sys", []Turn{{Role: "user", Content: "q"}}, true, func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Complete(scoped, Completion{System: "12345678", Prompt: "1234"}); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.EmbedQueries(scoped, []string{"abcdefgh"}); err != nil {
		t.Fatal(err)
	}
	// Outside a workspace nothing is recorded.
	if _, err := provider.Complete(context.Background(), Completion{System: "s", Prompt: "p"}); err != nil {
		t.Fatal(err)
	}

	want := []Usage{
		{Scope: Scope{"w1", "u1", "chat"}, Model: "gemini-2.5-flash", Kind: "generate", InputTokens: 40, OutputTokens: 10},
		{Scope: Scope{"w1", "u1", "chat"}, Model: "gemini-2.5-flash", Kind: "generate", InputTokens: 3, OutputTokens: 1, Estimated: true},
		{Scope: Scope{"w1", "u1", "chat"}, Model: "gemini-embedding-001", Kind: "embed", InputTokens: 2, Estimated: true},
	}
	if len(*got) != len(want) {
		t.Fatalf("recorded %+v", *got)
	}
	for i := range want {
		if (*got)[i] != want[i] {
			t.Errorf("call %d = %+v, want %+v", i, (*got)[i], want[i])
		}
	}
}

func TestOpenAICompatibleUsageIsReadOrEstimated(t *testing.T) {
	got := recording(t)
	client := &http.Client{Transport: roundTrip(func(r *http.Request) *http.Response {
		if strings.HasSuffix(r.URL.Path, "/embeddings") {
			return reply(200, `{"data":[{"embedding":[0.1,0.2],"index":0}],"usage":{"prompt_tokens":7}}`)
		}
		return reply(200, `{"choices":[{"message":{"content":"<think>x</think>Answer"}}],"usage":{"prompt_tokens":12,"completion_tokens":5}}`)
	})}
	cfg := OpenAIConfig{BaseURL: "http://fake/v1", Model: "llama", Client: client}
	scoped := WithScope(context.Background(), Scope{WorkspaceID: "w1", Feature: "followups"})
	if text, err := NewOpenAIChat(cfg).Complete(scoped, Completion{System: "s", Prompt: "p"}); err != nil || text != "Answer" {
		t.Fatalf("text %q err %v", text, err)
	}
	if _, err := NewOpenAIEmbeddings(cfg).EmbedQueries(scoped, []string{"q"}); err != nil {
		t.Fatal(err)
	}
	if len(*got) != 2 || (*got)[0].InputTokens != 12 || (*got)[0].OutputTokens != 5 || (*got)[0].Estimated ||
		(*got)[1].Model != "openai-compatible/llama" || (*got)[1].InputTokens != 7 || (*got)[1].Kind != "embed" {
		t.Fatalf("recorded %+v", *got)
	}
}

func vector() string {
	encoded, _ := json.Marshal(make([]float64, EmbeddingDimensions))
	return string(encoded)
}

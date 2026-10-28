package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// fakeClaude answers Messages API calls in-process, recording each request body and its beta header.
func fakeClaude(t *testing.T, reply func(body map[string]any) *http.Response) (Provider, *[]map[string]any, *[]string) {
	t.Helper()
	var bodies []map[string]any
	var betas []string
	client := &http.Client{Transport: roundTrip(func(r *http.Request) *http.Response {
		if r.Header.Get("X-Api-Key") != "sk-ant-test" || r.URL.Path != "/v1/messages" {
			t.Errorf("request %s %s key %q", r.Method, r.URL.Path, r.Header.Get("X-Api-Key"))
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		bodies = append(bodies, body)
		betas = append(betas, r.Header.Get("Anthropic-Beta"))
		res := reply(body)
		res.Header.Set("Content-Type", map[bool]string{true: "text/event-stream", false: "application/json"}[body["stream"] == true])
		return res
	})}
	return NewAnthropicChat(AnthropicConfig{APIKey: "sk-ant-test", Model: "claude-opus-5-5", FastModel: "claude-haiku-5-5", BaseURL: "https://fake", Client: client}), &bodies, &betas
}

func message(text, stop string) string {
	return `{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":` + quote(text) +
		`}],"stop_reason":"` + stop + `","usage":{"input_tokens":20,"cache_creation_input_tokens":0,"cache_read_input_tokens":80,"output_tokens":6}}`
}

func quote(s string) string { encoded, _ := json.Marshal(s); return string(encoded) }

func sse(events ...string) string {
	var b strings.Builder
	for _, event := range events {
		var head struct{ Type string }
		_ = json.Unmarshal([]byte(event), &head)
		b.WriteString("event: " + head.Type + "\ndata: " + event + "\n\n")
	}
	return b.String()
}

func TestClaudeCompletionsUseEffortCachingAndFallbacks(t *testing.T) {
	got := recording(t)
	provider, bodies, betas := fakeClaude(t, func(map[string]any) *http.Response { return reply(200, message("[1,2]", "end_turn")) })
	scoped := WithScope(context.Background(), Scope{WorkspaceID: "w1", Feature: "chat"})

	text, err := provider.Complete(scoped, Completion{System: "Grade passages.", Prompt: "p", JSON: true, Temperature: 0.3})
	if err != nil || text != "[1,2]" {
		t.Fatalf("text %q err %v", text, err)
	}
	if _, err := provider.Complete(scoped, Completion{System: "s", Prompt: "p", Fast: true}); err != nil {
		t.Fatal(err)
	}
	full, fast := (*bodies)[0], (*bodies)[1]
	system := full["system"].([]any)[0].(map[string]any)
	if full["model"] != "claude-opus-5-5" || full["output_config"].(map[string]any)["effort"] != "medium" || full["fallbacks"] != "default" ||
		system["cache_control"].(map[string]any)["type"] != "ephemeral" || (*betas)[0] != "server-side-fallback-2026-07-01" {
		t.Fatalf("request = %v (beta %q)", full, (*betas)[0])
	}
	if _, sent := full["temperature"]; sent {
		t.Fatalf("Claude takes no sampling settings: %v", full)
	}
	// The fast model (Haiku) has no server-side fallback, so none is asked for.
	if fast["model"] != "claude-haiku-5-5" || fast["output_config"].(map[string]any)["effort"] != "low" || fast["fallbacks"] != nil || (*betas)[1] != "" {
		t.Fatalf("fast request = %v (beta %q)", fast, (*betas)[1])
	}
	if len(*got) != 2 || (*got)[0].InputTokens != 100 || (*got)[0].OutputTokens != 6 || (*got)[0].Estimated {
		t.Fatalf("usage = %+v", *got)
	}
}

func TestClaudeStreamsTextAndReportsRefusalsAndErrors(t *testing.T) {
	recording(t)
	refuse := false
	provider, bodies, _ := fakeClaude(t, func(body map[string]any) *http.Response {
		if body["stream"] != true {
			return reply(400, `{"type":"error","error":{"type":"invalid_request_error","message":"echo of the prompt"}}`)
		}
		stop := "end_turn"
		if refuse {
			stop = "refusal"
		}
		return reply(200, sse(
			`{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":12,"output_tokens":1}}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`,
			`{"type":"content_block_stop","index":0}`,
			`{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
			`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Bees "}}`,
			`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"pollinate [1]."}}`,
			`{"type":"content_block_stop","index":1}`,
			`{"type":"message_delta","delta":{"stop_reason":"`+stop+`"},"usage":{"output_tokens":9}}`,
			`{"type":"message_stop"}`,
		))
	})
	var pieces []string
	collect := func(text string) error { pieces = append(pieces, text); return nil }
	turns := []Turn{{Role: "user", Content: "q"}, {Role: "assistant", Content: "a"}, {Role: "user", Content: "q2"}}
	if err := provider.StreamChat(context.Background(), "Answer from sources.", turns, true, collect); err != nil || strings.Join(pieces, "|") != "Bees |pollinate [1]." {
		t.Fatalf("pieces %v err %v", pieces, err)
	}
	if roles := (*bodies)[0]["messages"].([]any); len(roles) != 3 || roles[1].(map[string]any)["role"] != "assistant" {
		t.Fatalf("messages = %v", roles)
	}
	refuse = true
	if err := provider.StreamChat(context.Background(), "s", turns, false, collect); err == nil || err.Error() != RefusalMessage {
		t.Fatalf("refusal: %v", err)
	}
	_, err := provider.Complete(context.Background(), Completion{System: "s", Prompt: "p"})
	vendor, ok := AsError(err)
	if !ok || vendor.Status != 400 || vendor.Retryable || strings.Contains(err.Error(), "echo") {
		t.Fatalf("error = %v", err)
	}
}

func TestConfigChoosesClaudeForChat(t *testing.T) {
	env := map[string]string{"CHAT_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "sk-ant-x", "GOOGLE_API_KEY": "key-0123456789abcdefghij"}
	get := func(name string) string { return env[name] }
	provider, err := build(get)
	if err != nil || provider.ChatModel() != "claude-opus-5-5" || provider.EmbeddingModel() != "gemini-embedding-001" {
		t.Fatalf("provider %v err %v", provider, err)
	}
	env["ANTHROPIC_CHAT_MODEL"] = "claude-sonnet-5-5"
	if provider, _ := build(get); provider.ChatModel() != "claude-sonnet-5-5" {
		t.Fatalf("model = %s", provider.ChatModel())
	}
	delete(env, "ANTHROPIC_API_KEY")
	if _, err := build(get); err == nil || !strings.Contains(err.Error(), "ANTHROPIC_API_KEY") {
		t.Fatalf("missing key: %v", err)
	}
}

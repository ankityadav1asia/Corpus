package ai

import (
	"context"
	"math"
)

// AI usage metering, as server/ai/usage.ts: every model call reports its tokens, billed to the
// workspace, member and feature in the request context (WithScope). The API sets Recorder to store
// them; without a scope or a recorder nothing is recorded.

// Scope is who a model call works for.
type Scope struct {
	WorkspaceID, UserID, Feature string
}

// Usage is one model call.
type Usage struct {
	Scope
	Model                     string
	Kind                      string // "generate" or "embed"
	InputTokens, OutputTokens int
	// Estimated: the vendor did not count, the tokens were estimated from the text.
	Estimated bool
}

type scopeKey struct{}

// WithScope attributes the model calls made with ctx.
func WithScope(ctx context.Context, scope Scope) context.Context {
	return context.WithValue(ctx, scopeKey{}, scope)
}

// Recorder stores usage; set once by the API. It must not fail the call: errors are its own to log.
var Recorder func(ctx context.Context, usage Usage)

func record(ctx context.Context, usage Usage) {
	scope, ok := ctx.Value(scopeKey{}).(Scope)
	if !ok || scope.WorkspaceID == "" || Recorder == nil {
		return
	}
	usage.Scope = scope
	usage.InputTokens, usage.OutputTokens = max(0, usage.InputTokens), max(0, usage.OutputTokens)
	Recorder(ctx, usage)
}

// EstimateTokens is about four characters per token, for vendors that do not count.
func EstimateTokens(texts ...string) int {
	total := 0
	for _, text := range texts {
		total += len([]rune(text))
	}
	return int(math.Ceil(float64(total) / 4))
}

// geminiUsage is a response's usageMetadata. Thinking tokens are billed as output, so output is
// everything but the prompt.
type geminiUsage struct {
	PromptTokenCount     *int `json:"promptTokenCount"`
	CandidatesTokenCount int  `json:"candidatesTokenCount"`
	TotalTokenCount      int  `json:"totalTokenCount"`
}

func recordGemini(ctx context.Context, model string, usage *geminiUsage, prompt []string, answer string) {
	if usage == nil || usage.PromptTokenCount == nil {
		record(ctx, Usage{Model: model, Kind: "generate", InputTokens: EstimateTokens(prompt...), OutputTokens: EstimateTokens(answer), Estimated: true})
		return
	}
	output := usage.CandidatesTokenCount
	if usage.TotalTokenCount > 0 {
		output = usage.TotalTokenCount - *usage.PromptTokenCount
	}
	record(ctx, Usage{Model: model, Kind: "generate", InputTokens: *usage.PromptTokenCount, OutputTokens: output})
}

// openAIUsage is the usage object of OpenAI-compatible responses.
type openAIUsage struct {
	PromptTokens     *int `json:"prompt_tokens"`
	CompletionTokens int  `json:"completion_tokens"`
}

func recordOpenAI(ctx context.Context, model string, usage *openAIUsage, prompt []string, answer string) {
	if usage == nil || usage.PromptTokens == nil {
		record(ctx, Usage{Model: model, Kind: "generate", InputTokens: EstimateTokens(prompt...), OutputTokens: EstimateTokens(answer), Estimated: true})
		return
	}
	record(ctx, Usage{Model: model, Kind: "generate", InputTokens: *usage.PromptTokens, OutputTokens: usage.CompletionTokens})
}

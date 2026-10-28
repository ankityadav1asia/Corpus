package ai

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// Claude (Anthropic Messages API) for answers and helper calls, as server/ai/anthropic.ts.
// Embeddings come from another provider (Combine). Claude's current models always think and take no
// sampling settings, so speed is set with effort: fast calls run at low effort, deep answers at
// medium. The system prompt is cached.

// AnthropicConfig configures the chat half.
type AnthropicConfig struct {
	APIKey    string
	Model     string
	FastModel string // a cheaper model for helper calls; "" uses Model at low effort
	BaseURL   string // tests
	Client    *http.Client
}

const anthropicMaxTokens = 16000

// RefusalMessage is returned when the model (and its fallback) declined the request.
const RefusalMessage = "The model declined to answer this request."

// Models that accept server-side refusal fallbacks in their "default" form.
var fallbackModels = regexp.MustCompile(`^claude-(opus-5|opus-5-5|sonnet-5-5|fable-5-1)$`)

type anthropicChat struct {
	cfg    AnthropicConfig
	client anthropic.Client
}

// NewAnthropicChat is the chat half of a provider; pair it with an embedding half via Combine.
func NewAnthropicChat(cfg AnthropicConfig) Provider {
	opts := []option.RequestOption{option.WithAPIKey(cfg.APIKey)}
	if cfg.BaseURL != "" {
		opts = append(opts, option.WithBaseURL(cfg.BaseURL))
	}
	if cfg.Client != nil {
		opts = append(opts, option.WithHTTPClient(cfg.Client))
	}
	return combined{anthropicChat{cfg: cfg, client: anthropic.NewClient(opts...)}, nil}
}

func (a anthropicChat) ChatModel() string { return a.cfg.Model }

func (a anthropicChat) params(model, system string, turns []Turn, fast bool) anthropic.BetaMessageNewParams {
	messages := make([]anthropic.BetaMessageParam, len(turns))
	for i, turn := range turns {
		role := anthropic.BetaMessageParamRoleUser
		if turn.Role == "assistant" {
			role = anthropic.BetaMessageParamRoleAssistant
		}
		messages[i] = anthropic.BetaMessageParam{Role: role, Content: []anthropic.BetaContentBlockParamUnion{anthropic.NewBetaTextBlock(turn.Content)}}
	}
	effort := anthropic.BetaOutputConfigEffortMedium
	if fast {
		effort = anthropic.BetaOutputConfigEffortLow
	}
	params := anthropic.BetaMessageNewParams{
		Model:        anthropic.Model(model),
		MaxTokens:    anthropicMaxTokens,
		System:       []anthropic.BetaTextBlockParam{{Text: system, CacheControl: anthropic.NewBetaCacheControlEphemeralParam()}},
		Messages:     messages,
		OutputConfig: anthropic.BetaOutputConfigParam{Effort: effort},
	}
	// A declined request is answered by Anthropic's recommended fallback model in the same call.
	if fallbackModels.MatchString(model) {
		params.Betas = []anthropic.AnthropicBeta{anthropic.AnthropicBetaServerSideFallback2026_07_01}
		params.Fallbacks = anthropic.BetaFallbacksParamUnion{OfDefault: "default"}
	}
	return params
}

// anthropicError maps an SDK error to a provider error without the vendor's message.
func anthropicError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return &Error{Message: "Request aborted"}
	}
	var apiErr *anthropic.Error
	if errors.As(err, &apiErr) {
		status := apiErr.StatusCode
		var retryAfter float64
		if apiErr.Response != nil {
			retryAfter, _ = strconv.ParseFloat(apiErr.Response.Header.Get("Retry-After"), 64)
		}
		return &Error{Message: fmt.Sprintf("Claude request failed (%d)", status), Status: status, Retryable: status == 429 || status >= 500, RetryAfter: retryAfter}
	}
	return &Error{Message: "Claude request failed (network)", Retryable: true}
}

func recordAnthropic(ctx context.Context, message *anthropic.BetaMessage) {
	usage := message.Usage
	// Cached prompt tokens are still prompt tokens (billed at a discount).
	input := usage.InputTokens + usage.CacheCreationInputTokens + usage.CacheReadInputTokens
	record(ctx, Usage{Model: string(message.Model), Kind: "generate", InputTokens: int(input), OutputTokens: int(usage.OutputTokens)})
}

func (a anthropicChat) StreamChat(ctx context.Context, system string, turns []Turn, fast bool, emit func(string) error) error {
	stream := a.client.Beta.Messages.NewStreaming(ctx, a.params(a.cfg.Model, system, turns, fast))
	defer stream.Close()
	var message anthropic.BetaMessage
	for stream.Next() {
		event := stream.Current()
		if err := message.Accumulate(event); err != nil {
			return &Error{Message: "Claude stream failed"}
		}
		if event.Type == "content_block_delta" {
			if delta := event.AsContentBlockDelta().Delta; delta.Type == "text_delta" && delta.Text != "" {
				if err := emit(delta.Text); err != nil {
					return err
				}
			}
		}
	}
	if err := stream.Err(); err != nil {
		return anthropicError(ctx, err)
	}
	recordAnthropic(ctx, &message)
	if message.StopReason == anthropic.BetaStopReasonRefusal {
		return &Error{Message: RefusalMessage}
	}
	return nil
}

func (a anthropicChat) Complete(ctx context.Context, input Completion) (string, error) {
	model := a.cfg.Model
	if input.Fast && a.cfg.FastModel != "" {
		model = a.cfg.FastModel
	}
	message, err := a.client.Beta.Messages.New(ctx, a.params(model, input.System, []Turn{{Role: "user", Content: input.Prompt}}, input.Fast))
	if err != nil {
		return "", anthropicError(ctx, err)
	}
	recordAnthropic(ctx, message)
	if message.StopReason == anthropic.BetaStopReasonRefusal {
		return "", &Error{Message: RefusalMessage}
	}
	var text strings.Builder
	for _, block := range message.Content {
		if block.Type == "text" {
			text.WriteString(block.Text)
		}
	}
	return text.String(), nil
}

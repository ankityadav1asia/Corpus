// Package ai talks to the model vendors over their REST APIs: Gemini, and any server that speaks
// the OpenAI dialect (Ollama, vLLM, Groq, …). It is server/ai/{provider,gemini,openai-compatible}.ts
// in Go; the pipeline depends on the Provider interface, never on a vendor.
package ai

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"time"
)

// EmbeddingDimensions is the width of app.chunks.embedding (vector(3072)).
const EmbeddingDimensions = 3072

// Turn is one message of a conversation sent to the model.
type Turn struct {
	Role    string // "user" or "assistant"
	Content string
}

// Completion is a non-streaming request: query planning, re-ranking, judging, suggestions.
type Completion struct {
	System      string
	Prompt      string
	JSON        bool
	Temperature float64
	// Fast: a short helper call; use the fast model when one is configured and skip thinking.
	Fast bool
}

// Provider is everything the RAG pipeline needs from a model vendor.
type Provider interface {
	ChatModel() string
	EmbeddingModel() string
	// EmbedQueries returns one vector per text, in input order (RETRIEVAL_QUERY task type).
	EmbedQueries(ctx context.Context, texts []string) ([][]float64, error)
	// EmbedDocuments embeds passages (RETRIEVAL_DOCUMENT task type), e.g. a HyDE passage.
	EmbedDocuments(ctx context.Context, texts []string) ([][]float64, error)
	// StreamChat calls emit with each piece of answer text. turns start with a user turn and
	// alternate roles. fast skips the model's thinking phase so the first words arrive sooner.
	StreamChat(ctx context.Context, system string, turns []Turn, fast bool, emit func(string) error) error
	Complete(ctx context.Context, input Completion) (string, error)
}

// Error is a vendor failure. Its message never contains the vendor's text (which can echo prompts).
type Error struct {
	Message    string
	Status     int // 0 for network failures
	Retryable  bool
	RetryAfter float64 // seconds the vendor asked to wait, 0 when it did not say
	DailyQuota bool    // a per-day quota is used up: retrying within minutes cannot help
}

func (e *Error) Error() string { return e.Message }

// AsError returns the vendor error inside err, if any.
func AsError(err error) (*Error, bool) {
	var target *Error
	ok := errors.As(err, &target)
	return target, ok
}

// DailyQuotaMessage is shown when the model's daily quota is used up.
const DailyQuotaMessage = "The AI provider's daily quota for this model has been reached. It resets once a day — try again later, or use an API key with billing enabled."

// UserMessage is what people are told about a vendor failure (aiErrorMessage).
func UserMessage(err *Error) string {
	if err.DailyQuota {
		return DailyQuotaMessage
	}
	if err.Status == 429 {
		return "The AI service is rate-limiting requests. Please try again in a minute."
	}
	return "The AI service could not respond right now. Please try again shortly."
}

// maxInlineRetryWait: longer requested waits (per-minute quotas) are left to the caller.
const maxInlineRetryWait = 5.0

// withRetry retries rate limits and transient errors with exponential backoff and jitter.
func withRetry[T any](ctx context.Context, attempts int, run func() (T, error)) (T, error) {
	for attempt := 1; ; attempt++ {
		value, err := run()
		if err == nil {
			return value, nil
		}
		vendor, ok := AsError(err)
		if !ok || !vendor.Retryable || attempt >= attempts || ctx.Err() != nil || vendor.RetryAfter > maxInlineRetryWait {
			return value, err
		}
		wait := math.Max(float64(int(1)<<attempt)*250+rand.Float64()*250, vendor.RetryAfter*1000)
		select {
		case <-ctx.Done():
			return value, &Error{Message: "Request aborted"}
		case <-time.After(time.Duration(wait) * time.Millisecond):
		}
	}
}

func retryableStatus(status int) bool {
	return status == 429 || status == 500 || status == 502 || status == 503 || status == 504
}

func checkEmbedding(values []float64) error {
	if len(values) != EmbeddingDimensions {
		return &Error{Message: fmt.Sprintf("Embedding model returned %d dimensions; expected %d. Check GEMINI_EMBEDDING_MODEL.", len(values), EmbeddingDimensions)}
	}
	return nil
}

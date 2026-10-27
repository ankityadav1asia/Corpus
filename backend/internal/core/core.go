// Package core runs the Rust RAG core (core/, built to WebAssembly) inside the Go process with
// wazero: no cgo, no extra service, the same binary everywhere. Build the module first:
//
//	npm run core:build    (cargo build --target wasm32-unknown-unknown, copied next to this file)
package core

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

//go:embed corpus_core.wasm
var module []byte

// Core is safe for concurrent use: calls are serialised on one module instance, which is
// enough for these microsecond-scale functions.
type Core struct {
	mu       sync.Mutex
	runtime  wazero.Runtime
	instance api.Module
	alloc    api.Function
	dealloc  api.Function
	invoke   api.Function
}

// New compiles and instantiates the embedded module.
func New(ctx context.Context) (*Core, error) {
	runtime := wazero.NewRuntime(ctx)
	instance, err := runtime.InstantiateWithConfig(ctx, module, wazero.NewModuleConfig().WithName("corpus_core"))
	if err != nil {
		_ = runtime.Close(ctx)
		return nil, fmt.Errorf("instantiate corpus core: %w", err)
	}
	c := &Core{runtime: runtime, instance: instance, alloc: instance.ExportedFunction("alloc"), dealloc: instance.ExportedFunction("dealloc"), invoke: instance.ExportedFunction("invoke")}
	if c.alloc == nil || c.dealloc == nil || c.invoke == nil {
		_ = runtime.Close(ctx)
		return nil, errors.New("corpus core module lacks alloc, dealloc or invoke")
	}
	return c, nil
}

func (c *Core) Close(ctx context.Context) error { return c.runtime.Close(ctx) }

// Call runs one core function with JSON arguments and decodes its result into out.
func (c *Core) Call(ctx context.Context, function string, args any, out any) error {
	raw, err := c.CallRaw(ctx, function, args)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// CallRaw returns the result as raw JSON.
func (c *Core) CallRaw(ctx context.Context, function string, args any) (json.RawMessage, error) {
	request, err := json.Marshal(map[string]any{"fn": function, "args": args})
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	response, err := c.roundTrip(ctx, request)
	if err != nil {
		return nil, err
	}
	var envelope struct {
		OK    json.RawMessage `json:"ok"`
		Error *string         `json:"error"`
	}
	if err := json.Unmarshal(response, &envelope); err != nil {
		return nil, fmt.Errorf("corpus core %s: unreadable response: %w", function, err)
	}
	if envelope.Error != nil {
		return nil, fmt.Errorf("corpus core %s: %s", function, *envelope.Error)
	}
	return envelope.OK, nil
}

func (c *Core) roundTrip(ctx context.Context, request []byte) ([]byte, error) {
	size := uint64(len(request))
	allocated, err := c.alloc.Call(ctx, size)
	if err != nil {
		return nil, fmt.Errorf("corpus core alloc: %w", err)
	}
	pointer := allocated[0]
	if !c.instance.Memory().Write(uint32(pointer), request) {
		return nil, errors.New("corpus core: request out of memory range")
	}
	packed, err := c.invoke.Call(ctx, pointer, size)
	// invoke reads the request but does not free it.
	_, _ = c.dealloc.Call(ctx, pointer, size)
	if err != nil {
		return nil, fmt.Errorf("corpus core invoke: %w", err)
	}
	outPointer, outLen := uint32(packed[0]>>32), uint32(packed[0])
	view, ok := c.instance.Memory().Read(outPointer, outLen)
	if !ok {
		return nil, errors.New("corpus core: response out of memory range")
	}
	response := append([]byte(nil), view...)
	_, _ = c.dealloc.Call(ctx, uint64(outPointer), uint64(outLen))
	return response, nil
}

// ── Typed helpers ────────────────────────────────────────────────────────

// SearchHit is a retrieved passage (server/repositories/documents.ts SearchHit).
type SearchHit struct {
	ChunkID      string   `json:"chunkId"`
	DocumentID   string   `json:"documentId"`
	CollectionID string   `json:"collectionId"`
	Content      string   `json:"content"`
	Title        string   `json:"title"`
	Source       string   `json:"source"`
	SourceType   string   `json:"sourceType"`
	Similarity   *float64 `json:"similarity"`
}

type GuardrailSettings struct {
	Enabled       bool    `json:"enabled"`
	MinRelevance  float64 `json:"minRelevance"`
	MinSimilarity float64 `json:"minSimilarity"`
}

type GuardrailInput struct {
	Settings       GuardrailSettings `json:"settings"`
	CandidateCount int               `json:"candidateCount"`
	BestRelevance  *float64          `json:"bestRelevance"`
	BestSimilarity *float64          `json:"bestSimilarity"`
}

type GuardrailResult struct {
	Pass      bool     `json:"pass"`
	Basis     string   `json:"basis"`
	Score     *float64 `json:"score"`
	Threshold *float64 `json:"threshold"`
}

// InsufficientContextMessage is the exact reply when the guardrail withholds an answer.
const InsufficientContextMessage = "Insufficient context in knowledge base."

func (c *Core) SplitText(ctx context.Context, text string, chunkSize, chunkOverlap int) ([]string, error) {
	var chunks []string
	err := c.Call(ctx, "split_text", map[string]any{"text": text, "chunkSize": chunkSize, "chunkOverlap": chunkOverlap}, &chunks)
	return chunks, err
}

func (c *Core) FuseRankedLists(ctx context.Context, lists [][]SearchHit, limit int) ([]SearchHit, error) {
	var fused []SearchHit
	err := c.Call(ctx, "fuse_ranked_lists", map[string]any{"lists": lists, "limit": limit}, &fused)
	return fused, err
}

// CheckGuardrail returns the decision and the research step that describes it.
func (c *Core) CheckGuardrail(ctx context.Context, input GuardrailInput) (GuardrailResult, string, error) {
	var out struct {
		Result      GuardrailResult `json:"result"`
		Description string          `json:"description"`
	}
	err := c.Call(ctx, "check_guardrail", input, &out)
	return out.Result, out.Description, err
}

func (c *Core) EscapeSourceText(ctx context.Context, value string) (string, error) {
	var escaped string
	err := c.Call(ctx, "escape_source_text", map[string]any{"value": value}, &escaped)
	return escaped, err
}

func (c *Core) BuildUserPrompt(ctx context.Context, question string, hits []SearchHit) (string, error) {
	var prompt string
	err := c.Call(ctx, "build_user_prompt", map[string]any{"question": question, "hits": hits}, &prompt)
	return prompt, err
}

// Version is the core crate's version.
func (c *Core) Version(ctx context.Context) (string, error) {
	var version string
	err := c.Call(ctx, "version", nil, &version)
	return version, err
}

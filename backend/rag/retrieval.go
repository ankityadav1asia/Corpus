package rag

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/ankityadav1asia/Corpus/backend/ai"
	"github.com/ankityadav1asia/Corpus/backend/jsstr"
	"github.com/ankityadav1asia/Corpus/backend/logx"
)

// The retrieval pipeline (server/rag/retrieval.ts), as stages the chat handler streams progress
// between: plan → search (vector + full-text per query, HyDE) → fuse (RRF) → re-rank → guardrail.

// StageTimeout is the longest a helper stage may hold up an answer; past it the pipeline carries
// on without it and says so in the steps.
const StageTimeout = 8 * time.Second

// Scope is the workspace and, optionally, one notebook ("" = every notebook).
type Scope struct {
	WorkspaceID  string
	CollectionID string
}

// Searcher runs the two searches (implemented by *store.Store).
type Searcher interface {
	VectorSearch(ctx context.Context, scope Scope, embedding []float64, embeddingModel string, limit int) ([]Hit, error)
	KeywordSearch(ctx context.Context, scope Scope, query string, limit int) ([]Hit, error)
}

// RetrievalSettings are the workspace's retrieval knobs.
type RetrievalSettings struct {
	Rerank          bool
	CandidatePool   int
	TopK            int
	MultiQueryCount int
	StepBack        bool
	Hyde            bool
}

// PlainPlan searches the question as asked (standard mode).
func PlainPlan(question string) QueryPlan { return QueryPlan{Question: question, Variants: []string{}} }

// PlanRetrieval expands the question in deep mode; standard mode searches it as asked.
func PlanRetrieval(ctx context.Context, provider ai.Provider, question string, history []ai.Turn, mode string, settings RetrievalSettings) QueryPlan {
	if mode != "deep" {
		return PlainPlan(question)
	}
	ctx, cancel := context.WithTimeout(ctx, StageTimeout)
	defer cancel()
	return PlanQueries(ctx, provider, question, history, TransformOptions{MultiQueryCount: settings.MultiQueryCount, StepBack: settings.StepBack, Hyde: settings.Hyde})
}

// SearchQueries is the question, its variations and the step-back question.
func SearchQueries(plan QueryPlan) []string {
	queries := append([]string{plan.Question}, plan.Variants...)
	if plan.StepBack != "" {
		queries = append(queries, plan.StepBack)
	}
	return queries
}

// QueryCache keeps query embeddings for an hour (500 at most), keyed by model and the
// lower-cased question, so asking again (or a suggested follow-up) skips the embedding call.
type QueryCache struct {
	mu      sync.Mutex
	entries map[string]cacheEntry
	order   []string
}

type cacheEntry struct {
	vector  []float64
	expires time.Time
}

const (
	cacheEntries = 500
	cacheTTL     = time.Hour
)

func cacheKey(model, text string) string { return model + "\n" + strings.ToLower(jsstr.Trim(text)) }

// Embed returns one vector per query, embedding only the ones not cached (in one request).
func (c *QueryCache) Embed(ctx context.Context, provider ai.Provider, queries []string) ([][]float64, error) {
	now := time.Now()
	vectors := make([][]float64, len(queries))
	missing := []string{}
	c.mu.Lock()
	if c.entries == nil {
		c.entries = map[string]cacheEntry{}
	}
	for i, query := range queries {
		key := cacheKey(provider.EmbeddingModel(), query)
		if entry, ok := c.entries[key]; ok && entry.expires.After(now) {
			vectors[i] = entry.vector
			c.touch(key)
		} else {
			missing = append(missing, query)
		}
	}
	c.mu.Unlock()
	if len(missing) == 0 {
		return vectors, nil
	}
	fresh, err := provider.EmbedQueries(ctx, missing)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	next := 0
	for i, query := range queries {
		if vectors[i] != nil {
			continue
		}
		vectors[i] = fresh[next]
		next++
		key := cacheKey(provider.EmbeddingModel(), query)
		c.entries[key] = cacheEntry{vector: vectors[i], expires: now.Add(cacheTTL)}
		c.touch(key)
		for len(c.order) > cacheEntries {
			delete(c.entries, c.order[0])
			c.order = c.order[1:]
		}
	}
	return vectors, nil
}

func (c *QueryCache) touch(key string) {
	for i, existing := range c.order {
		if existing == key {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
	c.order = append(c.order, key)
}

// SearchCandidates runs every search in parallel and fuses the results to pool candidates.
func SearchCandidates(ctx context.Context, provider ai.Provider, cache *QueryCache, searcher Searcher, scope Scope, plan QueryPlan, pool int) ([]Hit, int, error) {
	queries := SearchQueries(plan)
	var queryVectors [][]float64
	var hydeVector []float64
	var embedErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		queryVectors, embedErr = cache.Embed(ctx, provider, queries)
	}()
	go func() {
		defer wg.Done()
		if plan.Hypothetical == "" {
			return
		}
		vectors, err := provider.EmbedDocuments(ctx, []string{plan.Hypothetical})
		if err != nil || len(vectors) == 0 {
			logx.Warn("HyDE embedding failed; continuing without it", logx.Fields{"error": fmt.Sprint(err)})
			return
		}
		hydeVector = vectors[0]
	}()
	wg.Wait()
	if embedErr != nil {
		return nil, 0, embedErr
	}

	perSearch := max(pool, 10)
	type search func() ([]Hit, error)
	searches := []search{}
	for i, query := range queries {
		vector, text := queryVectors[i], query
		searches = append(searches,
			func() ([]Hit, error) {
				return searcher.VectorSearch(ctx, scope, vector, provider.EmbeddingModel(), perSearch)
			},
			func() ([]Hit, error) { return searcher.KeywordSearch(ctx, scope, text, perSearch) })
	}
	if hydeVector != nil {
		searches = append(searches, func() ([]Hit, error) {
			return searcher.VectorSearch(ctx, scope, hydeVector, provider.EmbeddingModel(), perSearch)
		})
	}
	lists := make([][]Hit, len(searches))
	errs := make([]error, len(searches))
	var group sync.WaitGroup
	for i, run := range searches {
		group.Add(1)
		go func() {
			defer group.Done()
			lists[i], errs[i] = run()
		}()
	}
	group.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, 0, err
		}
	}
	return FuseRankedLists(lists, pool, RRFK), len(lists), nil
}

// RerankOutcome is the re-ranked hits and how they were ranked.
type RerankOutcome struct {
	Hits   []RankedHit
	Method string // cohere, llm or none
	Failed bool
}

// RerankCandidates keeps the topK most relevant candidates, or falls back to fusion order when
// re-ranking is off, unavailable or fails.
func RerankCandidates(ctx context.Context, reranker Reranker, question string, candidates []Hit, topK int, enabled bool) RerankOutcome {
	fallback := func(method string, failed bool) RerankOutcome {
		kept := candidates
		if topK < len(kept) {
			kept = kept[:topK]
		}
		hits := make([]RankedHit, len(kept))
		for i, hit := range kept {
			hits[i] = RankedHit{Hit: hit}
		}
		return RerankOutcome{Hits: hits, Method: method, Failed: failed}
	}
	if !enabled || reranker == nil || len(candidates) == 0 {
		return fallback("none", false)
	}
	stageCtx, cancel := context.WithTimeout(ctx, StageTimeout)
	defer cancel()
	offered := make([]RerankCandidate, len(candidates))
	byID := map[string]Hit{}
	for i, hit := range candidates {
		offered[i] = RerankCandidate{ID: hit.ChunkID, Text: hit.Content}
		byID[hit.ChunkID] = hit
	}
	results, err := reranker.Rerank(stageCtx, question, offered, topK)
	if err != nil {
		logx.Warn("Re-ranking failed; using fusion order", logx.Fields{"reranker": reranker.Name(), "error": err.Error()})
		return fallback(reranker.Name(), true)
	}
	hits := []RankedHit{}
	for _, result := range results {
		if hit, ok := byID[result.ID]; ok {
			score := result.Score
			hits = append(hits, RankedHit{Hit: hit, Relevance: &score})
		}
	}
	if len(hits) == 0 {
		return fallback(reranker.Name(), true)
	}
	return RerankOutcome{Hits: hits, Method: reranker.Name()}
}

// Step is one line of "How this answer was researched".
type Step struct {
	Label  string `json:"label"`
	Detail string `json:"detail"`
}

func quote(value string) string { return "“" + value + "”" }

func truncate(value string, max int) string {
	if jsstr.Len(value) > max {
		return jsstr.TrimEnd(jsstr.Prefix(value, max)) + "…"
	}
	return value
}

func plural(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, word)
	}
	return fmt.Sprintf("%d %ss", n, word)
}

// DescribeRetrieval is the human-readable account of what the pipeline did.
func DescribeRetrieval(mode string, plan QueryPlan, candidateCount, searches int, rerank RerankOutcome, guardrail GuardrailResult) []Step {
	steps := []Step{}
	if mode == "deep" {
		detail := "Unavailable — searched the question as asked"
		if len(plan.Variants) > 0 {
			quoted := make([]string, len(plan.Variants))
			for i, v := range plan.Variants {
				quoted[i] = quote(v)
			}
			detail = strings.Join(quoted, " · ")
		}
		steps = append(steps, Step{"Query expansion", detail})
		if plan.StepBack != "" {
			steps = append(steps, Step{"Step-back question", quote(plan.StepBack)})
		}
		if plan.Hypothetical != "" {
			steps = append(steps, Step{"Hypothetical answer (HyDE)", truncate(plan.Hypothetical, 220)})
		}
	}
	steps = append(steps, Step{"Retrieved", fmt.Sprintf("%s from %d searches (vector + full-text, fused with RRF)", plural(candidateCount, "candidate passage"), searches)})
	if rerank.Method != "none" {
		name := "Cohere"
		if rerank.Method == "llm" {
			name = "Gemini"
		}
		detail := fmt.Sprintf("Kept the top %d of %d with the %s re-ranker", len(rerank.Hits), candidateCount, name)
		if rerank.Failed {
			detail = fmt.Sprintf("%s re-ranker unavailable — kept the top %d by fusion order", name, len(rerank.Hits))
		}
		steps = append(steps, Step{"Re-ranked", detail})
	}
	return append(steps, Step{"Relevance check", DescribeGuardrail(guardrail)})
}

// Citation is a numbered source of an answer.
type Citation struct {
	Index      int      `json:"index"`
	ChunkID    string   `json:"chunkId"`
	DocumentID string   `json:"documentId"`
	Title      string   `json:"title"`
	Source     string   `json:"source"`
	SourceType string   `json:"sourceType"`
	Excerpt    string   `json:"excerpt"`
	Similarity *float64 `json:"similarity"`
	Relevance  *float64 `json:"relevance"`
}

// ToCitations numbers the hits for the answer and the client.
func ToCitations(hits []RankedHit) []Citation {
	citations := make([]Citation, len(hits))
	for i, hit := range hits {
		var similarity *float64
		if hit.Similarity != nil {
			value := round3(*hit.Similarity)
			similarity = &value
		}
		citations[i] = Citation{Index: i + 1, ChunkID: hit.ChunkID, DocumentID: hit.DocumentID, Title: hit.Title, Source: hit.Source, SourceType: hit.SourceType,
			Excerpt: truncate(hit.Content, 280), Similarity: similarity, Relevance: hit.Relevance}
	}
	return citations
}

// Passages turns hits into what the answer prompt needs.
func Passages(hits []RankedHit) []Passage {
	passages := make([]Passage, len(hits))
	for i, hit := range hits {
		passages[i] = Passage{Title: hit.Title, Source: hit.Source, Content: hit.Content}
	}
	return passages
}

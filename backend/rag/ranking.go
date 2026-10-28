package rag

import (
	"fmt"
	"math"
	"math/big"
	"sort"
	"strings"
)

// Hit is a passage found by vector or keyword search.
type Hit struct {
	ChunkID      string   `json:"chunkId"`
	DocumentID   string   `json:"documentId"`
	CollectionID string   `json:"collectionId"`
	Content      string   `json:"content"`
	Title        string   `json:"title"`
	Source       string   `json:"source"`
	SourceType   string   `json:"sourceType"`
	Similarity   *float64 `json:"similarity"` // cosine similarity, vector search only
}

// RankedHit is a hit after re-ranking, with the re-ranker's 0–1 relevance (nil when not re-ranked).
type RankedHit struct {
	Hit
	Relevance *float64 `json:"relevance"`
}

// RRFK is the constant of Reciprocal Rank Fusion.
const RRFK = 60

// FuseRankedLists is Reciprocal Rank Fusion: score(d) = Σ 1 / (k + rank). Rank-based, so cosine
// similarity and ts_rank need no normalisation. Keeps the best similarity seen per chunk; ties
// are broken by chunk id.
func FuseRankedLists(lists [][]Hit, limit, k int) []Hit {
	type entry struct {
		hit   Hit
		score float64
		order int
	}
	fused := map[string]*entry{}
	order := 0
	for _, list := range lists {
		for index, hit := range list {
			increment := 1 / float64(k+index+1)
			current, ok := fused[hit.ChunkID]
			if !ok {
				copied := hit
				fused[hit.ChunkID] = &entry{hit: copied, score: increment, order: order}
				order++
				continue
			}
			current.score += increment
			if hit.Similarity != nil && (current.hit.Similarity == nil || *hit.Similarity > *current.hit.Similarity) {
				similarity := *hit.Similarity
				current.hit.Similarity = &similarity
			}
		}
	}
	entries := make([]*entry, 0, len(fused))
	for _, e := range fused {
		entries = append(entries, e)
	}
	sort.SliceStable(entries, func(a, b int) bool {
		if entries[a].score != entries[b].score {
			return entries[a].score > entries[b].score
		}
		return compareUTF16(entries[a].hit.ChunkID, entries[b].hit.ChunkID) < 0
	})
	if limit < len(entries) {
		entries = entries[:max(limit, 0)]
	}
	out := make([]Hit, len(entries))
	for i, e := range entries {
		out[i] = e.hit
	}
	return out
}

// compareUTF16 orders like JavaScript's localeCompare does for the ASCII ids used here (UUIDs).
func compareUTF16(a, b string) int { return strings.Compare(a, b) }

// ── Guardrail ────────────────────────────────────────────────────────────

// GuardrailSettings are the workspace's relevance thresholds.
type GuardrailSettings struct {
	Enabled       bool
	MinRelevance  float64
	MinSimilarity float64
}

// GuardrailResult says whether the best passage is relevant enough to answer from.
type GuardrailResult struct {
	Pass      bool
	Basis     string // relevance, similarity, no_candidates, unscored, disabled
	Score     *float64
	Threshold *float64
}

// CheckGuardrail: re-ranker relevance is preferred, cosine similarity is the fallback; fusion
// scores are rank-based and never used as a relevance signal.
func CheckGuardrail(settings GuardrailSettings, candidateCount int, bestRelevance, bestSimilarity *float64) GuardrailResult {
	switch {
	case !settings.Enabled:
		return GuardrailResult{Pass: true, Basis: "disabled"}
	case candidateCount == 0:
		return GuardrailResult{Pass: false, Basis: "no_candidates"}
	case bestRelevance != nil:
		threshold := settings.MinRelevance
		return GuardrailResult{Pass: *bestRelevance >= threshold, Basis: "relevance", Score: bestRelevance, Threshold: &threshold}
	case bestSimilarity != nil:
		threshold := settings.MinSimilarity
		return GuardrailResult{Pass: *bestSimilarity >= threshold, Basis: "similarity", Score: bestSimilarity, Threshold: &threshold}
	}
	// Only keyword matches and no re-ranker: there is no calibrated score to judge by.
	return GuardrailResult{Pass: true, Basis: "unscored"}
}

// toFixed2 is JavaScript's Number.prototype.toFixed(2) for the scores shown in the steps.
func toFixed2(value *float64) string {
	if value == nil {
		return "—"
	}
	return jsToFixed(*value, 2)
}

// jsToFixed is Number.prototype.toFixed: n / 10^digits closest to the exact binary value, the
// larger n on a tie (Go's %f rounds ties to even, so 0.125 would give 0.12 instead of 0.13).
func jsToFixed(value float64, digits int) string {
	if value < 0 {
		return "-" + jsToFixed(-value, digits)
	}
	exact := new(big.Rat).SetFloat64(value)
	scale := new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil))
	scaled := new(big.Rat).Mul(exact, scale)
	half := new(big.Rat).Add(scaled, big.NewRat(1, 2))
	n := new(big.Int).Quo(half.Num(), half.Denom())
	text := n.String()
	if digits == 0 {
		return text
	}
	for len(text) <= digits {
		text = "0" + text
	}
	return text[:len(text)-digits] + "." + text[len(text)-digits:]
}

// DescribeGuardrail is the research-step text shown under an answer.
func DescribeGuardrail(r GuardrailResult) string {
	switch r.Basis {
	case "disabled":
		return "Relevance guardrail is turned off for this workspace"
	case "no_candidates":
		return "No passages matched the question — answer withheld"
	case "unscored":
		return "Only keyword matches were found; no relevance score available"
	case "relevance":
		if r.Pass {
			return fmt.Sprintf("Best re-ranker relevance %s ≥ threshold %s", toFixed2(r.Score), toFixed2(r.Threshold))
		}
		return fmt.Sprintf("Best re-ranker relevance %s < threshold %s — answer withheld", toFixed2(r.Score), toFixed2(r.Threshold))
	}
	if r.Pass {
		return fmt.Sprintf("Best similarity %s ≥ threshold %s", toFixed2(r.Score), toFixed2(r.Threshold))
	}
	return fmt.Sprintf("Best similarity %s < threshold %s — answer withheld", toFixed2(r.Score), toFixed2(r.Threshold))
}

// best is the largest non-nil value.
func best(values []*float64) *float64 {
	var top *float64
	for _, v := range values {
		if v != nil && (top == nil || *v > *top) {
			top = v
		}
	}
	return top
}

// EvaluateRelevance runs the guardrail over the re-ranked hits.
func EvaluateRelevance(settings GuardrailSettings, candidateCount int, hits []RankedHit) GuardrailResult {
	relevance := make([]*float64, len(hits))
	similarity := make([]*float64, len(hits))
	for i := range hits {
		relevance[i], similarity[i] = hits[i].Relevance, hits[i].Similarity
	}
	return CheckGuardrail(settings, candidateCount, best(relevance), best(similarity))
}

// round3 is Math.round(value * 1000) / 1000.
func round3(value float64) float64 { return math.Floor(value*1000+0.5) / 1000 }

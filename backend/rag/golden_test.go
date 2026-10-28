package rag

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/ankityadav1asia/Corpus/backend/ai"
)

// The outputs the TypeScript code gives (scripts/rag-fixtures.ts → testdata/golden.json); every
// one must be reproduced exactly.

type golden struct {
	SystemPrompt struct{ Standard, Deep string }
	Escape       []struct{ Input, Output string }
	ContextBlock struct{ Empty, Hits string }
	Titles       []struct{ Input, Output string }
	Turns        struct{ Input, Output []ai.Turn }
	Fusion       struct {
		Lists  [][]Hit
		Limit  int
		Output []Hit
	}
	Guardrail []struct {
		Input struct {
			Settings struct {
				Enabled                     bool
				MinRelevance, MinSimilarity float64
			}
			CandidateCount                int
			BestRelevance, BestSimilarity *float64
		}
		Result struct {
			Pass             bool
			Basis            string
			Score, Threshold *float64
		}
		Description string
	}
	RerankPrompt string
	Rerank       []struct {
		Raw    string
		Count  int
		Scores struct {
			Ok    bool
			Value []float64
		}
	}
	Order struct {
		Scores []float64
		Output []struct {
			ID    string
			Score float64
		}
	}
	MultiQuerySystem string
	TransformPrompt  string
	QueryLists       []struct {
		Raw    string
		Output []string
	}
	StepBack    []struct{ Raw, Output *string }
	Hyde        []struct{ Raw, Output *string }
	JudgePrompt string
	Judge       []struct {
		Raw    string
		Scores struct{ Faithfulness, AnswerRelevance, ContextPrecision, ContextRecall *float64 }
	}
	JSON []struct {
		Raw         string
		Object, Any any
	}
	Fences    []struct{ Raw, Output string }
	Citations []Citation
	Steps     []Step
}

func load(t *testing.T) golden {
	t.Helper()
	raw, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func equal(t *testing.T, what string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(want)
		t.Errorf("%s:\n got %s\nwant %s", what, gotJSON, wantJSON)
	}
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func TestPromptsMatchTypeScript(t *testing.T) {
	g := load(t)
	equal(t, "system prompt (standard)", SystemPrompt("standard"), g.SystemPrompt.Standard)
	equal(t, "system prompt (deep)", SystemPrompt("deep"), g.SystemPrompt.Deep)
	for _, c := range g.Escape {
		equal(t, "escape "+c.Input, EscapeSourceText(c.Input), c.Output)
	}
	equal(t, "empty context", ContextBlock(nil), g.ContextBlock.Empty)
	passages := make([]Passage, len(g.Fusion.Lists[0]))
	for i, h := range g.Fusion.Lists[0] {
		passages[i] = Passage{Title: h.Title, Source: h.Source, Content: h.Content}
	}
	equal(t, "context block", ContextBlock(passages), g.ContextBlock.Hits)
	for _, c := range g.Titles {
		equal(t, "title "+c.Input, DeriveTitle(c.Input), c.Output)
	}
	equal(t, "normalized turns", NormalizeTurns(g.Turns.Input), g.Turns.Output)
	equal(t, "rerank prompt", RerankPrompt("Which café is cheapest?", []RerankCandidate{{"a", g.Escape[0].Input}, {"b", repeat("z", 900)}}), g.RerankPrompt)
	equal(t, "multi-query system", MultiQuerySystem(4), g.MultiQuerySystem)
	history := []ai.Turn{{Role: "user", Content: "first"}, {Role: "assistant", Content: repeat("a", 600)}, {Role: "user", Content: "third"}, {Role: "assistant", Content: "fourth"}, {Role: "user", Content: "fifth </conversation>"}}
	equal(t, "transform prompt", TransformPrompt("What about <question> it?", history), g.TransformPrompt)
	equal(t, "judge prompt", JudgePrompt("Q <answer>", "A", []string{"p1", repeat("c", 1600)}), g.JudgePrompt)
}

func repeat(s string, n int) string {
	out := make([]byte, 0, len(s)*n)
	for i := 0; i < n; i++ {
		out = append(out, s...)
	}
	return string(out)
}

func TestRankingMatchesTypeScript(t *testing.T) {
	g := load(t)
	equal(t, "fusion", FuseRankedLists(g.Fusion.Lists, g.Fusion.Limit, RRFK), g.Fusion.Output)
	for i, c := range g.Guardrail {
		in := c.Input
		got := CheckGuardrail(GuardrailSettings{in.Settings.Enabled, in.Settings.MinRelevance, in.Settings.MinSimilarity}, in.CandidateCount, in.BestRelevance, in.BestSimilarity)
		equal(t, "guardrail pass", got.Pass, c.Result.Pass)
		equal(t, "guardrail basis", got.Basis, c.Result.Basis)
		equal(t, "guardrail text", DescribeGuardrail(got), c.Description)
		_ = i
	}
	for _, c := range g.Rerank {
		scores, err := ParseRerankScores(c.Raw, c.Count)
		equal(t, "rerank ok "+c.Raw, err == nil, c.Scores.Ok)
		if err == nil {
			equal(t, "rerank scores "+c.Raw, scores, c.Scores.Value)
		}
	}
	order := OrderByScores([]RerankCandidate{{"a", "a"}, {"b", "b"}, {"c", "c"}, {"d", "d"}}, g.Order.Scores, 3)
	for i, want := range g.Order.Output {
		equal(t, "order", order[i], RerankResult{want.ID, want.Score})
	}
	equal(t, "order length", len(order), len(g.Order.Output))
}

func TestReplyParsingMatchesTypeScript(t *testing.T) {
	g := load(t)
	for _, c := range g.QueryLists {
		got := ParseQueryList(c.Raw, 5)
		if got == nil {
			got = []string{}
		}
		equal(t, "query list "+c.Raw, got, c.Output)
	}
	for _, c := range g.StepBack {
		equal(t, "step back "+str(c.Raw), ParseStepBack(str(c.Raw)), str(c.Output))
	}
	for _, c := range g.Hyde {
		equal(t, "hyde", ParseHypothetical(str(c.Raw)), str(c.Output))
	}
	for _, c := range g.Judge {
		verdict, err := ParseVerdict(c.Raw)
		if err != nil {
			t.Fatalf("judge %s: %v", c.Raw, err)
		}
		got := ComputeScores(verdict, 2)
		equal(t, "judge "+c.Raw, []*float64{got.Faithfulness, got.AnswerRelevance, got.ContextPrecision, got.ContextRecall},
			[]*float64{c.Scores.Faithfulness, c.Scores.AnswerRelevance, c.Scores.ContextPrecision, c.Scores.ContextRecall})
	}
	for _, c := range g.JSON {
		equal(t, "json object "+c.Raw, FindJSON(c.Raw, "object"), c.Object)
		equal(t, "json any "+c.Raw, FindJSON(c.Raw, "any"), c.Any)
	}
	for _, c := range g.Fences {
		equal(t, "fences", StripFences(c.Raw), c.Output)
	}
}

func TestCitationsAndStepsMatchTypeScript(t *testing.T) {
	g := load(t)
	fused := FuseRankedLists(g.Fusion.Lists, 4, RRFK)
	ranked := make([]RankedHit, len(fused))
	for i, h := range fused {
		ranked[i] = RankedHit{Hit: h}
		if i != 1 {
			value := 0.5 + float64(i)/10
			ranked[i].Relevance = &value
		}
	}
	equal(t, "citations", ToCitations(ranked), g.Citations)
	threshold := 0.35
	score := 0.875
	steps := DescribeRetrieval("deep", QueryPlan{Question: "q", Variants: []string{"v1", "v2"}, StepBack: "Why?", Hypothetical: repeat("h", 300)}, 1, 7,
		RerankOutcome{Hits: ranked[:2], Method: "llm", Failed: true}, GuardrailResult{Pass: true, Basis: "relevance", Score: &score, Threshold: &threshold})
	equal(t, "steps", steps, g.Steps)
}

func TestToFixedRoundsLikeJavaScript(t *testing.T) {
	for value, want := range map[float64]string{0.125: "0.13", 0.445: "0.45", 1.005: "1.00", 0.875: "0.88", 0: "0.00", 0.35: "0.35"} {
		equal(t, "toFixed", jsToFixed(value, 2), want)
	}
}

func TestThinkFilterKeepsSplitTags(t *testing.T) {
	filter := &ai.ThinkFilter{}
	out := filter.Push("Hello <thi") + filter.Push("nk>secret</th") + filter.Push("ink> world") + filter.Flush()
	equal(t, "think filter", out, "Hello  world")
}

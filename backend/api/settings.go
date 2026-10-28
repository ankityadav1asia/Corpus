package api

import (
	"encoding/json"
	"fmt"
	"math"

	"github.com/ankityadav1asia/Corpus/backend/apperr"
)

// Workspace settings, as lib/contracts/workspaces.ts defines them: stored as JSON, always read
// through the defaults, and changed one group at a time.

type RetrievalSettings struct {
	Rerank          bool `json:"rerank"`
	CandidatePool   int  `json:"candidatePool"`
	TopK            int  `json:"topK"`
	MultiQueryCount int  `json:"multiQueryCount"`
	StepBack        bool `json:"stepBack"`
	Hyde            bool `json:"hyde"`
}

type GuardrailSettings struct {
	Enabled       bool    `json:"enabled"`
	MinRelevance  float64 `json:"minRelevance"`
	MinSimilarity float64 `json:"minSimilarity"`
}

type EvaluationSettings struct {
	Enabled    bool    `json:"enabled"`
	SampleRate float64 `json:"sampleRate"`
}

type WorkspaceSettings struct {
	Retrieval  RetrievalSettings  `json:"retrieval"`
	Guardrail  GuardrailSettings  `json:"guardrail"`
	Evaluation EvaluationSettings `json:"evaluation"`
}

func defaultSettings() WorkspaceSettings {
	return WorkspaceSettings{
		Retrieval:  RetrievalSettings{Rerank: true, CandidatePool: 20, TopK: 5, MultiQueryCount: 4, StepBack: true, Hyde: true},
		Guardrail:  GuardrailSettings{Enabled: true, MinRelevance: 0.35, MinSimilarity: 0.45},
		Evaluation: EvaluationSettings{Enabled: true, SampleRate: 1},
	}
}

// field is one setting: its JSON name and how to check and apply a value to it.
type field struct {
	name  string
	apply func(s *WorkspaceSettings, value any) string // "" when applied, else zod's message
}

func boolField(name string, target func(*WorkspaceSettings) *bool) field {
	return field{name, func(s *WorkspaceSettings, value any) string {
		b, ok := value.(bool)
		if !ok {
			return "Invalid input: expected boolean, received " + jsonType(value)
		}
		*target(s) = b
		return ""
	}}
}

func intField(name string, min, max int, target func(*WorkspaceSettings) *int) field {
	return field{name, func(s *WorkspaceSettings, value any) string {
		n, ok := value.(float64)
		if !ok {
			return "Invalid input: expected number, received " + jsonType(value)
		}
		if n != math.Trunc(n) {
			return "Invalid input: expected int, received number"
		}
		if message := bounds(n, float64(min), float64(max)); message != "" {
			return message
		}
		*target(s) = int(n)
		return ""
	}}
}

func numberField(name string, min, max float64, target func(*WorkspaceSettings) *float64) field {
	return field{name, func(s *WorkspaceSettings, value any) string {
		n, ok := value.(float64)
		if !ok {
			return "Invalid input: expected number, received " + jsonType(value)
		}
		if message := bounds(n, min, max); message != "" {
			return message
		}
		*target(s) = n
		return ""
	}}
}

func bounds(n, min, max float64) string {
	if n < min {
		return fmt.Sprintf("Too small: expected number to be >=%v", min)
	}
	if n > max {
		return fmt.Sprintf("Too big: expected number to be <=%v", max)
	}
	return ""
}

var settingsGroups = []struct {
	name   string
	fields []field
}{
	{"retrieval", []field{
		boolField("rerank", func(s *WorkspaceSettings) *bool { return &s.Retrieval.Rerank }),
		intField("candidatePool", 5, 50, func(s *WorkspaceSettings) *int { return &s.Retrieval.CandidatePool }),
		intField("topK", 1, 10, func(s *WorkspaceSettings) *int { return &s.Retrieval.TopK }),
		intField("multiQueryCount", 3, 5, func(s *WorkspaceSettings) *int { return &s.Retrieval.MultiQueryCount }),
		boolField("stepBack", func(s *WorkspaceSettings) *bool { return &s.Retrieval.StepBack }),
		boolField("hyde", func(s *WorkspaceSettings) *bool { return &s.Retrieval.Hyde }),
	}},
	{"guardrail", []field{
		boolField("enabled", func(s *WorkspaceSettings) *bool { return &s.Guardrail.Enabled }),
		numberField("minRelevance", 0, 1, func(s *WorkspaceSettings) *float64 { return &s.Guardrail.MinRelevance }),
		numberField("minSimilarity", 0, 1, func(s *WorkspaceSettings) *float64 { return &s.Guardrail.MinSimilarity }),
	}},
	{"evaluation", []field{
		boolField("enabled", func(s *WorkspaceSettings) *bool { return &s.Evaluation.Enabled }),
		numberField("sampleRate", 0, 1, func(s *WorkspaceSettings) *float64 { return &s.Evaluation.SampleRate }),
	}},
}

// applySettings applies a (partial) settings object onto base. Unknown keys are ignored, as zod
// does; every invalid value is reported with its path.
func applySettings(base WorkspaceSettings, input map[string]any, pathPrefix string) (WorkspaceSettings, []apperr.Issue) {
	var issues []apperr.Issue
	for _, group := range settingsGroups {
		raw, present := input[group.name]
		if !present || raw == nil {
			if present && raw == nil {
				issues = append(issues, apperr.Issue{Path: pathPrefix + group.name, Message: "Invalid input: expected object, received null"})
			}
			continue
		}
		values, ok := raw.(map[string]any)
		if !ok {
			issues = append(issues, apperr.Issue{Path: pathPrefix + group.name, Message: "Invalid input: expected object, received " + jsonType(raw)})
			continue
		}
		for _, f := range group.fields {
			value, present := values[f.name]
			if !present {
				continue
			}
			if message := f.apply(&base, value); message != "" {
				issues = append(issues, apperr.Issue{Path: pathPrefix + group.name + "." + f.name, Message: message})
			}
		}
	}
	return base, issues
}

// knownSettings keeps only the groups and fields the schema knows, as zod's parse does.
func knownSettings(input map[string]any) map[string]any {
	out := map[string]any{}
	for _, group := range settingsGroups {
		values, ok := input[group.name].(map[string]any)
		if !ok {
			continue
		}
		kept := map[string]any{}
		for _, f := range group.fields {
			if value, present := values[f.name]; present {
				kept[f.name] = value
			}
		}
		out[group.name] = kept
	}
	return out
}

// parseStoredSettings is parseSettings: stored values over the defaults, or the defaults alone
// when what is stored no longer validates.
func parseStoredSettings(raw []byte) WorkspaceSettings {
	var stored map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &stored) != nil || stored == nil {
		return defaultSettings()
	}
	settings, issues := applySettings(defaultSettings(), stored, "")
	if len(issues) > 0 {
		return defaultSettings()
	}
	return settings
}

func jsonType(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "unknown"
}

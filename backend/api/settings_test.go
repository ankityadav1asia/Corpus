package api

import (
	"encoding/json"
	"testing"
)

func TestStoredSettingsFallBackToDefaults(t *testing.T) {
	if got := parseStoredSettings(nil); got != defaultSettings() {
		t.Fatalf("nil → %+v", got)
	}
	if got := parseStoredSettings([]byte(`{"retrieval":{"topK":99}}`)); got != defaultSettings() {
		t.Fatalf("an invalid stored value uses the defaults: %+v", got)
	}
	got := parseStoredSettings([]byte(`{"retrieval":{"topK":3},"guardrail":{"enabled":false},"unknown":1}`))
	want := defaultSettings()
	want.Retrieval.TopK, want.Guardrail.Enabled = 3, false
	if got != want {
		t.Fatalf("got %+v", got)
	}
}

func TestSettingsPatchValidation(t *testing.T) {
	cases := map[string]string{
		`{"retrieval":{"topK":50}}`:            "retrieval.topK: Too big: expected number to be <=10",
		`{"retrieval":{"candidatePool":4}}`:    "retrieval.candidatePool: Too small: expected number to be >=5",
		`{"retrieval":{"topK":2.5}}`:           "retrieval.topK: Invalid input: expected int, received number",
		`{"guardrail":{"minRelevance":"0.5"}}`: "guardrail.minRelevance: Invalid input: expected number, received string",
		`{"evaluation":{"enabled":1}}`:         "evaluation.enabled: Invalid input: expected boolean, received number",
		`{"evaluation":null}`:                  "evaluation: Invalid input: expected object, received null",
	}
	for input, want := range cases {
		var patch map[string]any
		if err := json.Unmarshal([]byte(input), &patch); err != nil {
			t.Fatal(err)
		}
		_, issues := applySettings(defaultSettings(), patch, "")
		if len(issues) != 1 || issues[0].Path+": "+issues[0].Message != want {
			t.Fatalf("%s → %+v, want %q", input, issues, want)
		}
	}
	var patch map[string]any
	_ = json.Unmarshal([]byte(`{"guardrail":{"minSimilarity":0.6,"extra":true}}`), &patch)
	merged, issues := applySettings(defaultSettings(), patch, "")
	if len(issues) != 0 || merged.Guardrail.MinSimilarity != 0.6 || merged.Guardrail.MinRelevance != 0.35 {
		t.Fatalf("merge = %+v %v", merged, issues)
	}
	if kept := knownSettings(patch); len(kept["guardrail"].(map[string]any)) != 1 {
		t.Fatalf("unknown keys are not recorded: %v", kept)
	}
}

func TestEmailValidation(t *testing.T) {
	for _, ok := range []string{"a@b.co", "first.last+tag@example.com", "o'neil@sub.example.org"} {
		if !validEmail(ok) {
			t.Fatalf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"", "no-at", ".a@b.co", "a..b@c.co", "a@b", "a@-b.co"} {
		if validEmail(bad) {
			t.Fatalf("%q should be invalid", bad)
		}
	}
}

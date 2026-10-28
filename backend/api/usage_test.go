package api

import (
	"context"
	"testing"
	"time"

	"github.com/ankityadav1asia/Corpus/backend/ai"
)

func TestUsageSummaryForAdmins(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	ada := e.user(unique("ada") + "@example.com")
	vic := e.user(unique("vic") + "@example.com")
	team, notebook := e.team(ada, "Metered")
	e.join(team, vic, "viewer")
	e.document(ada.in(team), notebook, "Bees", "Bees pollinate flowers.")

	// Model calls go through the recorder the server installed, as the providers' calls do.
	scoped := ai.WithScope(ctx, ai.Scope{WorkspaceID: team, UserID: vic.id, Feature: "chat"})
	ai.Recorder(scoped, ai.Usage{Scope: ai.Scope{WorkspaceID: team, UserID: vic.id, Feature: "chat"}, Model: "gemini-x", Kind: "generate", InputTokens: 100, OutputTokens: 20})
	ai.Recorder(scoped, ai.Usage{Scope: ai.Scope{WorkspaceID: team, UserID: ada.id, Feature: "generate_report"}, Model: "gemini-x", Kind: "generate", InputTokens: 300, OutputTokens: 200})
	ai.Recorder(scoped, ai.Usage{Scope: ai.Scope{WorkspaceID: team, Feature: "ingest_document"}, Model: "gemini-embedding-001", Kind: "embed", InputTokens: 50, Estimated: true})
	// Older than the window, and another workspace: not counted.
	if err := e.db.Exec(ctx, `INSERT INTO app.ai_usage (workspace_id, feature, model, kind, input_tokens, output_tokens, created_at) VALUES ($1, 'chat', 'gemini-x', 'generate', 999, 0, now() - interval '40 days')`, team); err != nil {
		t.Fatal(err)
	}
	ai.Recorder(scoped, ai.Usage{Scope: ai.Scope{WorkspaceID: ada.workspaceID, Feature: "chat"}, Model: "gemini-x", Kind: "generate", InputTokens: 7})
	if err := e.db.Exec(ctx, `INSERT INTO app.query_logs (workspace_id, owner_id, mode, query, latency_ms, chunks_retrieved, status) VALUES ($1, $2, 'standard', 'q', 10, 1, 'ok'), ($1, $2, 'deep', 'q', 10, 0, 'error')`, team, vic.id); err != nil {
		t.Fatal(err)
	}

	w, body := e.do(&ada, call{path: "/api/usage", workspace: team})
	e.expect(w, 200)
	totals := body["totals"].(map[string]any)
	if body["days"] != 30.0 || totals["calls"] != 3.0 || totals["inputTokens"] != 450.0 || totals["outputTokens"] != 220.0 ||
		totals["estimatedCalls"] != 1.0 || totals["questions"] != 2.0 || totals["failedAnswers"] != 1.0 || totals["activeMembers"] != 2.0 {
		t.Fatalf("totals = %v", totals)
	}
	daily := body["daily"].([]any)
	today := daily[len(daily)-1].(map[string]any)
	if len(daily) != 30 || today["date"] != time.Now().UTC().Format("2006-01-02") || today["inputTokens"] != 450.0 || today["questions"] != 2.0 {
		t.Fatalf("daily = %v", daily[len(daily)-1])
	}
	if first := body["byFeature"].([]any)[0].(map[string]any); first["feature"] != "generate_report" || first["outputTokens"] != 200.0 {
		t.Fatalf("byFeature = %v", body["byFeature"])
	}
	members := body["byMember"].([]any)
	if len(members) != 3 || members[0].(map[string]any)["email"] != ada.email || members[2].(map[string]any)["userId"] != nil {
		t.Fatalf("byMember = %v", members)
	}
	if storage := body["storage"].(map[string]any); storage["documents"] != 1.0 || storage["chunks"] != 1.0 || storage["notebooks"] != 1.0 {
		t.Fatalf("storage = %v", storage)
	}

	w, body = e.do(&ada, call{path: "/api/usage?days=365", workspace: team})
	e.expect(w, 200)
	if body["totals"].(map[string]any)["inputTokens"] != 1449.0 || len(body["daily"].([]any)) != 365 {
		t.Fatalf("a year: %v", body["totals"])
	}
	for _, bad := range []string{"0", "366", "seven"} {
		w, _ = e.do(&ada, call{path: "/api/usage?days=" + bad, workspace: team})
		e.expect(w, 400)
	}
	w, _ = e.do(&vic, call{path: "/api/usage", workspace: team})
	e.expect(w, 403)
}

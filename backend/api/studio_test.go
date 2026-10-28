package api

import (
	"context"
	"fmt"
	"testing"

	"github.com/ankityadav1asia/Corpus/backend/ai"
	"github.com/ankityadav1asia/Corpus/backend/apperr"
	"github.com/ankityadav1asia/Corpus/backend/rag"
)

// in returns the actor acting in another workspace (for e.document and e.do).
func (a actor) in(workspaceID string) actor {
	a.workspaceID = workspaceID
	return a
}

func (e *env) queuedJob(jobType, key, id string) bool {
	e.t.Helper()
	count, err := e.db.QueryString(context.Background(), `SELECT count(*)::text FROM app.jobs WHERE type = $1 AND payload->>$2 = $3`, jobType, key, id)
	if err != nil {
		e.t.Fatal(err)
	}
	return count == "1"
}

func TestReportsAreQueuedReadAndDeleted(t *testing.T) {
	e := setup(t)
	e.useFakeAI(t)
	alice := e.user(unique("alice") + "@example.com")
	vera := e.user(unique("vera") + "@example.com")
	eddie := e.user(unique("eddie") + "@example.com")
	bob := e.user(unique("bob") + "@example.com")
	team, notebook := e.team(alice, "Studio")
	e.join(team, vera, "viewer")
	e.join(team, eddie, "editor")
	e.document(alice.in(team), notebook, "Bees", "Bees pollinate flowers.")
	empty, err := e.db.QueryString(context.Background(), `INSERT INTO app.collections (workspace_id, name, created_by) VALUES ($1, 'Empty', $2) RETURNING id::text`, team, alice.id)
	if err != nil {
		t.Fatal(err)
	}

	w, body := e.do(&vera, call{method: "POST", path: "/api/reports", workspace: team, body: fmt.Sprintf(`{"template":"executive_summary","collectionIds":[%q],"format":"json"}`, notebook)})
	e.expect(w, 202)
	report := body["report"].(map[string]any)
	if report["status"] != "queued" || report["title"] != "Executive summary — 1 document" || report["format"] != "markdown" || report["createdByEmail"] != vera.email {
		t.Fatalf("report = %v", report)
	}
	id := report["id"].(string)
	if !e.queuedJob("generate_report", "reportId", id) {
		t.Fatal("no generate_report job")
	}

	w, body = e.do(&vera, call{method: "POST", path: "/api/reports", workspace: team, body: fmt.Sprintf(`{"template":"slide_outline","title":"  Deck  ","collectionIds":[%q],"format":"json","instructions":"Short."}`, notebook)})
	e.expect(w, 202)
	if deck := body["report"].(map[string]any); deck["format"] != "json" || deck["title"] != "Deck" {
		t.Fatalf("slide outline = %v", deck)
	}

	for _, bad := range []struct{ body, path, message string }{
		{`{"template":"executive_summary"}`, "", noSourcesMessage},
		{fmt.Sprintf(`{"template":"memo","collectionIds":[%q]}`, notebook), "template", `Invalid option: expected one of "executive_summary"|"comparison_table"|"slide_outline"`},
		{`{"template":"executive_summary","collectionIds":["nope"]}`, "collectionIds.0", "Invalid GUID"},
		{`{"template":"executive_summary","documentIds":"x"}`, "documentIds", "Invalid input: expected array, received string"},
	} {
		w, body = e.do(&vera, call{method: "POST", path: "/api/reports", workspace: team, body: bad.body})
		e.expect(w, 400)
		issues := body["error"].(map[string]any)["details"].([]any)
		if first := issues[0].(map[string]any); first["path"] != bad.path || first["message"] != bad.message {
			t.Fatalf("%s: issues = %v", bad.body, issues)
		}
	}
	w, body = e.do(&vera, call{method: "POST", path: "/api/reports", workspace: team, body: fmt.Sprintf(`{"template":"executive_summary","collectionIds":[%q]}`, empty)})
	e.expect(w, 400)
	if message(body) != "The selection has no indexed documents yet." {
		t.Fatalf("empty notebook: %v", body)
	}
	w, _ = e.do(&vera, call{method: "POST", path: "/api/reports", workspace: team, body: fmt.Sprintf(`{"template":"executive_summary","collectionIds":[%q]}`, notebookOf(e, bob))})
	e.expect(w, 404)

	w, body = e.do(&eddie, call{path: "/api/reports/" + id, workspace: team})
	e.expect(w, 200)
	detail := body["report"].(map[string]any)
	if detail["title"] != report["title"] || detail["output"] != nil || detail["instructions"] != nil || len(detail["sources"].([]any)) != 0 {
		t.Fatalf("detail = %v", detail)
	}
	if _, leaked := detail["createdBy"]; leaked {
		t.Fatalf("createdBy is internal: %v", detail)
	}
	w, body = e.do(&eddie, call{path: "/api/reports", workspace: team})
	e.expect(w, 200)
	if list := body["reports"].([]any); len(list) != 2 || list[1].(map[string]any)["id"] != id {
		t.Fatalf("list = %v", list)
	}
	w, _ = e.do(&bob, call{path: "/api/reports/" + id})
	e.expect(w, 404)
	w, _ = e.do(&bob, call{path: "/api/reports/" + id, workspace: team})
	e.expect(w, 404) // not a member

	w, _ = e.do(&eddie, call{method: "DELETE", path: "/api/reports/" + id, workspace: team})
	e.expect(w, 403)
	w, _ = e.do(&alice, call{method: "DELETE", path: "/api/reports/" + id, workspace: team})
	e.expect(w, 200)
	w, _ = e.do(&alice, call{path: "/api/reports/" + id, workspace: team})
	e.expect(w, 404)
	audits, _ := e.db.QueryString(context.Background(), `SELECT string_agg(action, ',' ORDER BY created_at, action) FROM app.audit_events WHERE workspace_id = $1 AND target_type = 'report'`, team)
	if audits != "report.created,report.created,report.deleted" {
		t.Fatalf("audit = %q", audits)
	}
}

func TestStudioNeedsTheAIConfiguredAndIsClosedToGuests(t *testing.T) {
	e := setup(t)
	previous := models
	models = func() (ai.Provider, rag.Reranker, error) {
		return nil, nil, apperr.NotConfigured("Server is missing required configuration: GEMINI_API_KEY")
	}
	t.Cleanup(func() { models = previous })
	alice := e.user(unique("alice") + "@example.com")
	notebook := notebookOf(e, alice)
	w, _ := e.do(&alice, call{method: "POST", path: "/api/reports", body: fmt.Sprintf(`{"template":"executive_summary","collectionIds":[%q]}`, notebook)})
	e.expect(w, 503)

	guest := e.user(unique("guest") + "@demo.invalid")
	e.join(alice.workspaceID, guest, "viewer")
	w, _ = e.do(&guest, call{method: "POST", path: "/api/reports", workspace: alice.workspaceID, body: fmt.Sprintf(`{"template":"executive_summary","collectionIds":[%q]}`, notebook)})
	e.expect(w, 403)
	w, _ = e.do(&guest, call{path: "/api/reports", workspace: alice.workspaceID})
	e.expect(w, 200)
}

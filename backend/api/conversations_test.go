package api

// Conversations, feedback, notifications and analytics against a real database: the scenarios
// tests/http.test.ts and tests/platform-http.test.ts covered for the TypeScript routes.

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

// conversation stores a thread with one question and one answer for owner in workspaceID.
func (e *env) conversation(owner actor, workspaceID, title, question, answer string) (conversationID, questionID, answerID string) {
	e.t.Helper()
	ctx := context.Background()
	var err error
	if conversationID, err = e.db.QueryString(ctx, `INSERT INTO app.conversations (workspace_id, owner_id, title) VALUES ($1, $2, $3) RETURNING id::text`, workspaceID, owner.id, title); err != nil {
		e.t.Fatal(err)
	}
	if questionID, err = e.db.QueryString(ctx, `INSERT INTO app.messages (conversation_id, role, content) VALUES ($1, 'user', $2) RETURNING id::text`, conversationID, question); err != nil {
		e.t.Fatal(err)
	}
	citations := `[{"index":1,"chunkId":null,"documentId":null,"title":"hours.txt","source":"hours.txt","sourceType":"file","excerpt":"Open at dusk","similarity":0.8,"relevance":null}]`
	if answerID, err = e.db.QueryString(ctx, `INSERT INTO app.messages (conversation_id, role, content, citations) VALUES ($1, 'assistant', $2, $3::jsonb) RETURNING id::text`, conversationID, answer, citations); err != nil {
		e.t.Fatal(err)
	}
	return conversationID, questionID, answerID
}

func TestConversationsArePrivateRenamedPinnedAndSearched(t *testing.T) {
	e := setup(t)
	ed := e.user(unique("ed") + "@example.com")
	ada := e.user(unique("ada") + "@example.com")
	team, _ := e.team(ada, "Chats")
	e.join(team, ed, "editor")
	ed.workspaceID, ada.workspaceID = team, team
	id, _, answer := e.conversation(ed, team, "Opening hours", "When does it open?", "At dusk [1].")
	newer, _, _ := e.conversation(ed, team, "Newer thread", "Unrelated", "Something else.")

	w, body := e.do(&ed, call{path: "/api/conversations/" + id})
	e.expect(w, 200)
	messages := body["messages"].([]any)
	if body["conversation"].(map[string]any)["title"] != "Opening hours" || len(messages) != 2 {
		t.Fatalf("detail = %v", body)
	}
	reply := messages[1].(map[string]any)
	if reply["id"] != answer || reply["role"] != "assistant" || reply["evaluation"] != nil || reply["feedback"] != nil || reply["followups"] != nil ||
		reply["citations"].([]any)[0].(map[string]any)["title"] != "hours.txt" || len(reply["steps"].([]any)) != 0 {
		t.Fatalf("answer = %v", reply)
	}
	w, _ = e.do(&ada, call{path: "/api/conversations/" + id})
	e.expect(w, 404) // conversations are private to their author, admins included
	w, _ = e.do(&ed, call{path: "/api/conversations/not-a-uuid"})
	e.expect(w, 400)

	// Pinned first, then the most recent.
	w, _ = e.do(&ed, call{method: "PATCH", path: "/api/conversations/" + id, body: `{"pinned":true}`})
	e.expect(w, 200)
	w, body = e.do(&ed, call{path: "/api/conversations"})
	e.expect(w, 200)
	list := body["conversations"].([]any)
	if len(list) != 2 || list[0].(map[string]any)["id"] != id || list[0].(map[string]any)["pinned"] != true || list[1].(map[string]any)["id"] != newer {
		t.Fatalf("list = %v", list)
	}
	w, _ = e.do(&ada, call{method: "PATCH", path: "/api/conversations/" + id, body: `{"pinned":true}`})
	e.expect(w, 404)
	for _, bad := range []string{`{}`, `{"title":""}`, `{"pinned":"yes"}`, `{"title":"` + strings.Repeat("x", 201) + `"}`} {
		w, body = e.do(&ed, call{method: "PATCH", path: "/api/conversations/" + id, body: bad})
		e.expect(w, 400)
		if code(body) != "VALIDATION_FAILED" {
			t.Fatalf("%s → %v", bad, body)
		}
	}
	w, body = e.do(&ed, call{method: "PATCH", path: "/api/conversations/" + id, body: `{"title":"  Hours  "}`})
	e.expect(w, 200)
	if body["conversation"].(map[string]any)["title"] != "Hours" {
		t.Fatalf("renamed = %v", body)
	}

	// Search matches titles and message text literally, and only the caller's chats.
	search := func(who actor, q string) []any {
		w, body := e.do(&who, call{path: "/api/conversations?q=" + url.QueryEscape(q)})
		e.expect(w, 200)
		return body["conversations"].([]any)
	}
	if found := search(ed, "dusk"); len(found) != 1 || found[0].(map[string]any)["id"] != id {
		t.Fatalf("search = %v", found)
	}
	if found := search(ed, "100%"); len(found) != 0 {
		t.Fatalf("%% is literal: %v", found)
	}
	if found := search(ada, "dusk"); len(found) != 0 {
		t.Fatalf("chats stay private: %v", found)
	}
	w, _ = e.do(&ed, call{path: "/api/conversations?q=" + strings.Repeat("x", 201)})
	e.expect(w, 400)

	w, _ = e.do(&ada, call{method: "DELETE", path: "/api/conversations/" + newer})
	e.expect(w, 404)
	w, _ = e.do(&ed, call{method: "DELETE", path: "/api/conversations/" + newer})
	e.expect(w, 200)
	w, _ = e.do(&ed, call{path: "/api/conversations/" + newer})
	e.expect(w, 404)
}

func TestBranchingCopiesTheThreadUpToAMessage(t *testing.T) {
	e := setup(t)
	alice := e.user(unique("alice") + "@example.com")
	bob := e.user(unique("bob") + "@example.com")
	id, question, _ := e.conversation(alice, alice.workspaceID, "Original", "First question", "First answer")
	branchPath := "/api/conversations/" + id + "/branch"

	w, body := e.do(&alice, call{method: "POST", path: branchPath, body: fmt.Sprintf(`{"messageId":%q}`, question)})
	e.expect(w, 201)
	branch := body["conversationId"].(string)
	w, body = e.do(&alice, call{path: "/api/conversations/" + branch})
	e.expect(w, 200)
	detail := body["conversation"].(map[string]any)
	if detail["title"] != "↳ Original" || detail["parentId"] != id || len(body["messages"].([]any)) != 1 {
		t.Fatalf("branch = %v", body)
	}
	w, _ = e.do(&bob, call{method: "POST", path: branchPath, workspace: alice.workspaceID, body: fmt.Sprintf(`{"messageId":%q}`, question)})
	e.expect(w, 404)
	w, _ = e.do(&bob, call{method: "POST", path: branchPath, body: fmt.Sprintf(`{"messageId":%q}`, question)})
	e.expect(w, 404)
	w, body = e.do(&alice, call{method: "POST", path: branchPath, body: `{"messageId":"nope"}`})
	e.expect(w, 400)
	if code(body) != "VALIDATION_FAILED" {
		t.Fatalf("body = %v", body)
	}
}

func TestAnswerFeedback(t *testing.T) {
	e := setup(t)
	ed := e.user(unique("ed") + "@example.com")
	ada := e.user(unique("ada") + "@example.com")
	team, _ := e.team(ada, "Feedback")
	e.join(team, ed, "editor")
	ed.workspaceID, ada.workspaceID = team, team
	id, question, answer := e.conversation(ed, team, "Opening hours", "When does it open?", "At dusk [1].")
	path := "/api/messages/" + answer + "/feedback"

	w, body := e.do(&ed, call{method: "PUT", path: path, body: `{"rating":-1,"comment":"  Missing the closing time  "}`})
	e.expect(w, 200)
	if fb := body["feedback"].(map[string]any); fb["rating"] != -1.0 || fb["comment"] != "Missing the closing time" {
		t.Fatalf("feedback = %v", body)
	}
	w, body = e.do(&ed, call{path: "/api/conversations/" + id})
	e.expect(w, 200)
	if fb := body["messages"].([]any)[1].(map[string]any)["feedback"].(map[string]any); fb["rating"] != -1.0 || fb["comment"] != "Missing the closing time" {
		t.Fatalf("stored feedback = %v", fb)
	}
	w, body = e.do(&ed, call{method: "PUT", path: path, body: `{"rating":1,"comment":"   "}`})
	e.expect(w, 200)
	if fb := body["feedback"].(map[string]any); fb["rating"] != 1.0 || fb["comment"] != nil {
		t.Fatalf("an empty comment is none: %v", body)
	}
	w, body = e.do(&ed, call{method: "PUT", path: path, body: `{"rating":0}`})
	e.expect(w, 200)
	if body["feedback"] != nil {
		t.Fatalf("cleared = %v", body)
	}
	w, _ = e.do(&ed, call{method: "PUT", path: path, body: `{"rating":2}`})
	e.expect(w, 400)
	w, _ = e.do(&ada, call{method: "PUT", path: path, body: `{"rating":1}`})
	e.expect(w, 404) // other people's answers
	w, _ = e.do(&ed, call{method: "PUT", path: "/api/messages/" + question + "/feedback", body: `{"rating":1}`})
	e.expect(w, 404) // questions cannot be rated
}

func TestNotificationsListAndRead(t *testing.T) {
	e := setup(t)
	val := e.user(unique("val") + "@example.com")
	ada := e.user(unique("ada") + "@example.com")
	team, _ := e.team(ada, "Team")
	e.join(team, val, "viewer")
	ctx := context.Background()
	for _, title := range []string{"First", "Second"} {
		if err := e.db.Exec(ctx, `INSERT INTO app.notifications (user_id, workspace_id, kind, title, link) VALUES ($1, $2, 'document_ready', $3, '{"tab":"sources"}')`, val.id, team, title); err != nil {
			t.Fatal(err)
		}
	}
	gone, _ := e.team(ada, "Left behind")
	if err := e.db.Exec(ctx, `INSERT INTO app.notifications (user_id, workspace_id, kind, title) VALUES ($1, $2, 'report_ready', 'Hidden')`, val.id, gone); err != nil {
		t.Fatal(err)
	}

	w, body := e.do(&val, call{path: "/api/notifications", noWorkspace: true})
	e.expect(w, 200)
	items := body["items"].([]any)
	if body["unread"] != 2.0 || len(items) != 2 || items[0].(map[string]any)["workspaceName"] != "Team" || items[0].(map[string]any)["link"].(map[string]any)["tab"] != "sources" {
		t.Fatalf("notifications = %v", body) // a workspace the person is not in stays hidden
	}
	first := items[1].(map[string]any)["id"].(string)
	w, body = e.do(&val, call{method: "POST", path: "/api/notifications/read", noWorkspace: true, body: fmt.Sprintf(`{"ids":[%q]}`, first)})
	e.expect(w, 200)
	if body["updated"] != 1.0 {
		t.Fatalf("read = %v", body)
	}
	w, body = e.do(&val, call{method: "POST", path: "/api/notifications/read", noWorkspace: true, body: `{"all":true}`})
	e.expect(w, 200)
	// "All" includes the hidden one from the workspace they are not in, as the TypeScript route did.
	if body["updated"] != 2.0 {
		t.Fatalf("read all = %v", body)
	}
	w, body = e.do(&val, call{path: "/api/notifications", noWorkspace: true})
	e.expect(w, 200)
	if body["unread"] != 0.0 || body["items"].([]any)[0].(map[string]any)["readAt"] == nil {
		t.Fatalf("after reading = %v", body)
	}
	for _, bad := range []string{`{}`, `{"ids":["x"]}`, `{"ids":"x"}`, `{"all":"yes"}`} {
		w, body = e.do(&val, call{method: "POST", path: "/api/notifications/read", noWorkspace: true, body: bad})
		e.expect(w, 400)
		if code(body) != "VALIDATION_FAILED" {
			t.Fatalf("%s → %v", bad, body)
		}
	}
	w, _ = e.do(nil, call{path: "/api/notifications"})
	e.expect(w, 401)
}

func TestAnalyticsScopes(t *testing.T) {
	e := setup(t)
	alice := e.user(unique("alice") + "@example.com")
	vera := e.user(unique("vera") + "@example.com")
	team, _ := e.team(alice, "Usage")
	e.join(team, vera, "viewer")
	ctx := context.Background()
	for _, row := range []struct {
		owner        actor
		mode, status string
		latencyMs    int
	}{{alice, "standard", "ok", 400}, {alice, "deep", "ok", 1200}, {vera, "standard", "insufficient_context", 300}, {vera, "standard", "error", 50}} {
		if err := e.db.Exec(ctx, `INSERT INTO app.query_logs (workspace_id, owner_id, mode, query, latency_ms, chunks_retrieved, status) VALUES ($1, $2, $3, 'q', $4, 3, $5)`,
			team, row.owner.id, row.mode, row.latencyMs, row.status); err != nil {
			t.Fatal(err)
		}
	}
	alice.workspaceID, vera.workspaceID = team, team

	w, body := e.do(&alice, call{path: "/api/analytics"})
	e.expect(w, 200)
	totals := body["totals"].(map[string]any)
	if body["scope"] != "me" || totals["queries"] != 2.0 || totals["avgLatencyMs"] != 800.0 || body["byMode"].(map[string]any)["deep"] != 1.0 || len(body["recent"].([]any)) != 2 {
		t.Fatalf("mine = %v", body)
	}
	w, body = e.do(&alice, call{path: "/api/analytics?scope=workspace"})
	e.expect(w, 200)
	totals = body["totals"].(map[string]any)
	if body["scope"] != "workspace" || totals["queries"] != 4.0 || totals["errors"] != 1.0 || totals["insufficient"] != 1.0 {
		t.Fatalf("workspace = %v", body)
	}
	w, _ = e.do(&vera, call{path: "/api/analytics?scope=workspace"})
	e.expect(w, 403)
	w, body = e.do(&vera, call{path: "/api/analytics"})
	e.expect(w, 200)
	if body["totals"].(map[string]any)["avgLatencyMs"] != nil {
		t.Fatalf("no successful questions means no average: %v", body)
	}
	w, _ = e.do(&alice, call{path: "/api/analytics?scope=everyone"})
	e.expect(w, 400)
}

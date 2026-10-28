package api

// Workspace administration against a real database: the scenarios tests/http.test.ts,
// tests/demo-http.test.ts and tests/platform-http.test.ts covered for the TypeScript routes.

import (
	"context"
	"fmt"
	"testing"
)

// team creates a team workspace owned by owner and returns its id and its default notebook.
func (e *env) team(owner actor, name string) (string, string) {
	e.t.Helper()
	w, body := e.do(&owner, call{method: "POST", path: "/api/workspaces", body: fmt.Sprintf(`{"name":%q}`, name)})
	e.expect(w, 201)
	id := body["workspace"].(map[string]any)["id"].(string)
	notebook, err := e.db.QueryString(context.Background(), `SELECT id::text FROM app.collections WHERE workspace_id = $1`, id)
	if err != nil {
		e.t.Fatal(err)
	}
	return id, notebook
}

func (e *env) join(workspaceID string, who actor, role string) {
	e.t.Helper()
	if err := e.db.Exec(context.Background(), `INSERT INTO app.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)`, workspaceID, who.id, role); err != nil {
		e.t.Fatal(err)
	}
}

func message(body map[string]any) string {
	if errBody, ok := body["error"].(map[string]any); ok {
		text, _ := errBody["message"].(string)
		return text
	}
	return ""
}

func TestMembersAddInviteAndList(t *testing.T) {
	e := setup(t)
	bob := e.user(unique("bob") + "@example.com")
	veraEmail := unique("vera") + "@example.com"
	vera := e.user(veraEmail)
	eddie := e.user(unique("eddie") + "@example.com")
	team, _ := e.team(bob, "Bob’s team")
	path := "/api/workspaces/" + team + "/members"

	w, body := e.do(&bob, call{method: "POST", path: path, noWorkspace: true, body: fmt.Sprintf(`{"email":%q,"role":"viewer"}`, " "+upper(veraEmail)+" ")})
	e.expect(w, 201)
	if body["status"] != "added" {
		t.Fatalf("body = %v", body)
	}
	w, _ = e.do(&bob, call{method: "POST", path: path, noWorkspace: true, body: fmt.Sprintf(`{"email":%q,"role":"editor"}`, veraEmail)})
	e.expect(w, 409)
	invitee := unique("future") + "@example.com"
	w, body = e.do(&bob, call{method: "POST", path: path, noWorkspace: true, body: fmt.Sprintf(`{"email":%q,"role":"editor"}`, invitee)})
	e.expect(w, 201)
	if body["status"] != "invited" {
		t.Fatalf("body = %v", body)
	}
	vera.workspaceID = ""
	w, _ = e.do(&vera, call{method: "POST", path: path, noWorkspace: true, body: `{"email":"x@example.com","role":"admin"}`})
	e.expect(w, 403)
	w, _ = e.do(&bob, call{method: "POST", path: "/api/workspaces/" + bob.workspaceID + "/members", noWorkspace: true, body: fmt.Sprintf(`{"email":%q,"role":"viewer"}`, veraEmail)})
	e.expect(w, 400) // personal workspaces cannot be shared

	for _, bad := range []string{`{"email":"not-an-email","role":"viewer"}`, `{"email":"a@b.co","role":"owner"}`, `{"role":"viewer"}`} {
		w, body = e.do(&bob, call{method: "POST", path: path, noWorkspace: true, body: bad})
		e.expect(w, 400)
		if code(body) != "VALIDATION_FAILED" {
			t.Fatalf("%s → %v", bad, body)
		}
	}

	w, body = e.do(&bob, call{path: path, noWorkspace: true})
	e.expect(w, 200)
	if members, invites := body["members"].([]any), body["invites"].([]any); len(members) != 2 || len(invites) != 1 || invites[0].(map[string]any)["email"] != invitee {
		t.Fatalf("admin view = %v", body)
	}
	w, body = e.do(&vera, call{path: path, noWorkspace: true})
	e.expect(w, 200)
	if invites := body["invites"].([]any); len(invites) != 0 {
		t.Fatalf("pending invitations are for admins only: %v", invites)
	}
	w, _ = e.do(&eddie, call{path: path, noWorkspace: true})
	e.expect(w, 404)

	added, err := e.db.QueryString(context.Background(), `SELECT count(*)::text FROM app.notifications WHERE user_id = $1 AND kind = 'member_added'`, vera.id)
	if err != nil || added != "1" {
		t.Fatalf("member_added notifications = %q %v", added, err)
	}

	// Revoking an invitation.
	w, _ = e.do(&vera, call{method: "DELETE", path: "/api/workspaces/" + team + "/invites?email=" + invitee, noWorkspace: true})
	e.expect(w, 403)
	w, _ = e.do(&bob, call{method: "DELETE", path: "/api/workspaces/" + team + "/invites?email=" + invitee, noWorkspace: true})
	e.expect(w, 200)
	w, _ = e.do(&bob, call{method: "DELETE", path: "/api/workspaces/" + team + "/invites?email=" + invitee, noWorkspace: true})
	e.expect(w, 404)
}

func upper(s string) string {
	out := []rune(s)
	for i, r := range out {
		if r >= 'a' && r <= 'z' {
			out[i] = r - 32
		}
	}
	return string(out)
}

func TestMemberRolesLastAdminAndLeaving(t *testing.T) {
	e := setup(t)
	bob := e.user(unique("bob") + "@example.com")
	vera := e.user(unique("vera") + "@example.com")
	team, _ := e.team(bob, "Roles")
	e.join(team, vera, "viewer")
	member := func(id string) string { return "/api/workspaces/" + team + "/members/" + id }

	w, body := e.do(&bob, call{method: "PATCH", path: member(bob.id), noWorkspace: true, body: `{"role":"viewer"}`})
	e.expect(w, 409)
	if message(body) != "A workspace needs at least one admin. Promote someone else first." {
		t.Fatalf("body = %v", body)
	}
	w, _ = e.do(&vera, call{method: "PATCH", path: member(vera.id), noWorkspace: true, body: `{"role":"admin"}`})
	e.expect(w, 403)
	w, _ = e.do(&bob, call{method: "PATCH", path: member(vera.id), noWorkspace: true, body: `{"role":"editor"}`})
	e.expect(w, 200)
	w, _ = e.do(&bob, call{method: "PATCH", path: member("not-a-uuid"), noWorkspace: true, body: `{"role":"editor"}`})
	e.expect(w, 400)
	w, _ = e.do(&bob, call{method: "DELETE", path: member(bob.id), noWorkspace: true})
	e.expect(w, 409)
	w, _ = e.do(&vera, call{method: "DELETE", path: member(vera.id), noWorkspace: true})
	e.expect(w, 200) // members can leave
	w, _ = e.do(&vera, call{path: "/api/collections", workspace: team})
	e.expect(w, 404)
	w, _ = e.do(&bob, call{method: "DELETE", path: member(vera.id), noWorkspace: true})
	e.expect(w, 404)
	w, _ = e.do(&bob, call{method: "DELETE", path: "/api/workspaces/" + bob.workspaceID + "/members/" + bob.id, noWorkspace: true})
	e.expect(w, 400) // nobody leaves their personal workspace
}

func TestWorkspaceSettingsAndDeletion(t *testing.T) {
	e := setup(t)
	bob := e.user(unique("bob") + "@example.com")
	eddie := e.user(unique("eddie") + "@example.com")
	team, _ := e.team(bob, "Settings")
	e.join(team, eddie, "editor")
	path := "/api/workspaces/" + team

	w, body := e.do(&bob, call{path: path, noWorkspace: true})
	e.expect(w, 200)
	settings := body["workspace"].(map[string]any)["settings"].(map[string]any)
	if settings["retrieval"].(map[string]any)["topK"] != 5.0 || settings["guardrail"].(map[string]any)["minSimilarity"] != 0.45 {
		t.Fatalf("defaults = %v", settings)
	}

	w, body = e.do(&bob, call{method: "PATCH", path: path, noWorkspace: true, body: `{"name":"Renamed","settings":{"guardrail":{"minRelevance":0.5},"retrieval":{"topK":3}}}`})
	e.expect(w, 200)
	detail := body["workspace"].(map[string]any)
	settings = detail["settings"].(map[string]any)
	if detail["name"] != "Renamed" || settings["guardrail"].(map[string]any)["minRelevance"] != 0.5 ||
		settings["guardrail"].(map[string]any)["minSimilarity"] != 0.45 || settings["retrieval"].(map[string]any)["topK"] != 3.0 {
		t.Fatalf("detail = %v", detail)
	}

	for _, bad := range []string{`{"settings":{"retrieval":{"topK":50}}}`, `{"settings":{"guardrail":{"enabled":"yes"}}}`, `{}`, `{"name":""}`} {
		w, body = e.do(&bob, call{method: "PATCH", path: path, noWorkspace: true, body: bad})
		e.expect(w, 400)
		if code(body) != "VALIDATION_FAILED" {
			t.Fatalf("%s → %v", bad, body)
		}
	}
	w, _ = e.do(&eddie, call{method: "PATCH", path: path, noWorkspace: true, body: `{"name":"Mine now"}`})
	e.expect(w, 403)
	w, _ = e.do(&bob, call{method: "PATCH", path: path, noWorkspace: true, body: `{"name":"x"}`, origin: "https://evil.example"})
	e.expect(w, 403)

	w, _ = e.do(&bob, call{method: "DELETE", path: "/api/workspaces/" + bob.workspaceID, noWorkspace: true})
	e.expect(w, 400)
	w, _ = e.do(&eddie, call{method: "DELETE", path: path, noWorkspace: true})
	e.expect(w, 403)
	w, _ = e.do(&bob, call{method: "DELETE", path: path, noWorkspace: true})
	e.expect(w, 200)
	w, _ = e.do(&bob, call{path: path, noWorkspace: true})
	e.expect(w, 404)
}

func TestNotebookRenameDeleteAndRoles(t *testing.T) {
	e := setup(t)
	alice := e.user(unique("alice") + "@example.com")
	vera := e.user(unique("vera") + "@example.com")
	eddie := e.user(unique("eddie") + "@example.com")
	bob := e.user(unique("bob") + "@example.com")
	team, notebook := e.team(alice, "Notebooks")
	e.join(team, vera, "viewer")
	e.join(team, eddie, "editor")
	in := func(who actor) *actor { who.workspaceID = team; return &who }
	path := "/api/collections/" + notebook

	w, _ := e.do(in(vera), call{method: "PATCH", path: path, body: `{"name":"Nope"}`})
	e.expect(w, 403)
	w, _ = e.do(in(eddie), call{method: "DELETE", path: path})
	e.expect(w, 403)
	w, _ = e.do(&bob, call{method: "DELETE", path: path, workspace: team})
	e.expect(w, 404) // not a member
	w, _ = e.do(&bob, call{method: "DELETE", path: path})
	e.expect(w, 404) // another workspace's notebook

	// Overrides: a viewer becomes an editor here; admins cannot be overridden; editors cannot set them.
	roles := path + "/roles"
	w, _ = e.do(in(alice), call{method: "PUT", path: roles, body: fmt.Sprintf(`{"userId":%q,"role":"editor"}`, vera.id)})
	e.expect(w, 200)
	w, body := e.do(in(alice), call{path: roles})
	e.expect(w, 200)
	found := false
	for _, entry := range body["roles"].([]any) {
		row := entry.(map[string]any)
		if row["userId"] == vera.id {
			found = row["effectiveRole"] == "editor" && row["override"] == "editor" && row["workspaceRole"] == "viewer"
		}
	}
	if !found {
		t.Fatalf("roles = %v", body)
	}
	w, _ = e.do(in(alice), call{method: "PUT", path: roles, body: fmt.Sprintf(`{"userId":%q,"role":"viewer"}`, alice.id)})
	e.expect(w, 400)
	w, _ = e.do(in(eddie), call{method: "PUT", path: roles, body: fmt.Sprintf(`{"userId":%q,"role":"admin"}`, vera.id)})
	e.expect(w, 403)
	w, _ = e.do(in(alice), call{method: "PUT", path: roles, body: fmt.Sprintf(`{"userId":%q,"role":null}`, vera.id)})
	e.expect(w, 200)
	w, _ = e.do(in(alice), call{method: "PUT", path: roles, body: fmt.Sprintf(`{"userId":%q,"role":"editor"}`, bob.id)})
	e.expect(w, 404) // not a member

	// Rename: conflicts with another notebook's name, then succeeds; delete keeps conversations.
	w, _ = e.do(in(alice), call{method: "POST", path: "/api/collections", body: `{"name":"Second"}`})
	e.expect(w, 201)
	w, _ = e.do(in(alice), call{method: "PATCH", path: path, body: `{"name":"Second"}`})
	e.expect(w, 409)
	w, _ = e.do(in(alice), call{method: "PATCH", path: path, body: `{"name":"Handbook"}`})
	e.expect(w, 200)
	w, _ = e.do(in(alice), call{method: "DELETE", path: path})
	e.expect(w, 200)
	w, _ = e.do(in(alice), call{method: "DELETE", path: path})
	e.expect(w, 404)

	actions, err := e.db.QueryString(context.Background(), `SELECT string_agg(action, ',' ORDER BY created_at) FROM app.audit_events WHERE workspace_id = $1 AND action LIKE 'notebook.%'`, team)
	if err != nil || actions != "notebook.access_changed,notebook.access_changed,notebook.created,notebook.renamed,notebook.deleted" {
		t.Fatalf("audit = %q %v", actions, err)
	}
}

func TestAuditLogIsForAdmins(t *testing.T) {
	e := setup(t)
	ada := e.user(unique("ada") + "@example.com")
	ed := e.user(unique("ed") + "@example.com")
	out := e.user(unique("out") + "@example.com")
	team, _ := e.team(ada, "Audited")
	e.join(team, ed, "editor")
	path := "/api/workspaces/" + team + "/audit"

	w, body := e.do(&ada, call{path: path, noWorkspace: true})
	e.expect(w, 200)
	events := body["events"].([]any)
	if len(events) == 0 || events[0].(map[string]any)["action"] != "workspace.created" || events[0].(map[string]any)["actorEmail"] != ada.email {
		t.Fatalf("events = %v", events)
	}
	w, _ = e.do(&ed, call{path: path, noWorkspace: true})
	e.expect(w, 403)
	w, _ = e.do(&out, call{path: path, noWorkspace: true})
	e.expect(w, 404)
}

func TestMembersHideDemoVisitors(t *testing.T) {
	e := setup(t)
	ada := e.user(unique("ada") + "@example.com")
	team, _ := e.team(ada, "Demo")
	guest := e.user(unique("guest") + "@demo.invalid")
	e.join(team, guest, "viewer")
	path := "/api/workspaces/" + team + "/members"

	w, body := e.do(&guest, call{path: path, noWorkspace: true})
	e.expect(w, 200)
	if members := body["members"].([]any); len(members) != 1 || members[0].(map[string]any)["userId"] != guest.id {
		t.Fatalf("a guest sees only themselves: %v", members)
	}
	w, body = e.do(&ada, call{path: path, noWorkspace: true})
	e.expect(w, 200)
	for _, entry := range body["members"].([]any) {
		if entry.(map[string]any)["userId"] == guest.id {
			t.Fatalf("demo visitors are hidden from the member list: %v", body)
		}
	}
	w, _ = e.do(&guest, call{method: "PATCH", path: "/api/workspaces/" + team, noWorkspace: true, body: `{"name":"Mine"}`})
	e.expect(w, 403)
}

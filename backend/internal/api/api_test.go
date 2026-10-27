package api

// HTTP tests against a real, migrated PostgreSQL. Start one with `npm run db:pglite-server` (or
// point at any test database) and set CORPUS_TEST_DATABASE_URL; CI does both. These are the
// scenarios tests/http.test.ts covered for the TypeScript versions of these routes.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ankityadav1asia/Corpus/backend/internal/auth"
	"github.com/ankityadav1asia/Corpus/backend/internal/config"
	"github.com/ankityadav1asia/Corpus/backend/internal/logx"
	"github.com/ankityadav1asia/Corpus/backend/internal/store"
)

var secret = strings.Repeat("y", 48)

type env struct {
	t       *testing.T
	db      *store.Store
	handler http.Handler
}

type actor struct {
	id          string
	email       string
	cookie      string
	workspaceID string
}

func setup(t *testing.T) *env {
	t.Helper()
	url := os.Getenv("CORPUS_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("CORPUS_TEST_DATABASE_URL is not set (start `npm run db:pglite-server`)")
	}
	logx.SetOutput(&strings.Builder{})
	ctx := context.Background()
	db, err := store.Open(ctx, url, 1)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	cfg := config.Config{PostgresURL: url, Secrets: []string{secret}, AppURL: ""}
	return &env{t: t, db: db, handler: New(cfg, db, "test").Handler()}
}

func unique(prefix string) string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return prefix + "-" + hex.EncodeToString(b[:])
}

// user creates an account, a server-side session and its signed cookie, as sign-in does.
func (e *env) user(email string) actor {
	e.t.Helper()
	ctx := context.Background()
	id, err := e.db.QueryString(ctx, `INSERT INTO app.users (email, name) VALUES ($1, $2) RETURNING id::text`, email, "Test")
	if err != nil {
		e.t.Fatal(err)
	}
	sid, err := e.db.QueryString(ctx, `INSERT INTO app.sessions (user_id, expires_at) VALUES ($1, now() + interval '1 day') RETURNING id::text`, id)
	if err != nil {
		e.t.Fatal(err)
	}
	now := time.Now().Unix()
	cookie, err := auth.Sign(map[string]any{"v": 2, "sid": sid, "sub": id, "email": email, "name": "Test", "iat": now, "exp": now + 3600}, []string{secret})
	if err != nil {
		e.t.Fatal(err)
	}
	if auth.IsGuestEmail(email) {
		// Demo visitors get no personal workspace.
		return actor{id: id, email: email, cookie: cookie}
	}
	personal, err := e.db.EnsurePersonal(ctx, id)
	if err != nil {
		e.t.Fatal(err)
	}
	if err := e.db.EnsureDefaultCollection(ctx, personal, id); err != nil {
		e.t.Fatal(err)
	}
	return actor{id: id, email: email, cookie: cookie, workspaceID: personal}
}

type call struct {
	method, path, body, origin, contentType, workspace, cookie string
	noWorkspace                                                bool
}

func (e *env) do(as *actor, c call) (*httptest.ResponseRecorder, map[string]any) {
	e.t.Helper()
	if c.method == "" {
		c.method = "GET"
	}
	r := httptest.NewRequest(c.method, "http://localhost:3000"+c.path, strings.NewReader(c.body))
	r.Host = "localhost:3000"
	cookie := c.cookie
	workspace := c.workspace
	if as != nil {
		if cookie == "" {
			cookie = as.cookie
		}
		if workspace == "" && !c.noWorkspace {
			workspace = as.workspaceID
		}
	}
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: cookie})
	}
	if workspace != "" {
		r.Header.Set("X-Workspace-Id", workspace)
	}
	if c.body != "" {
		contentType := c.contentType
		if contentType == "" {
			contentType = "application/json"
		}
		r.Header.Set("Content-Type", contentType)
	}
	origin := c.origin
	if origin == "" && c.method != "GET" {
		origin = "http://localhost:3000"
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	e.handler.ServeHTTP(w, r)
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	return w, body
}

func code(body map[string]any) string {
	if errBody, ok := body["error"].(map[string]any); ok {
		code, _ := errBody["code"].(string)
		return code
	}
	return ""
}

func (e *env) expect(w *httptest.ResponseRecorder, want int) {
	e.t.Helper()
	if w.Code != want {
		e.t.Fatalf("status %d, want %d: %s", w.Code, want, w.Body.String())
	}
}

func TestHealth(t *testing.T) {
	e := setup(t)
	w, body := e.do(nil, call{path: "/api/health"})
	e.expect(w, 200)
	if body["ok"] != true || body["database"] != "up" || body["backend"] != "go" {
		t.Fatalf("health = %v", body)
	}
}

func TestAuthenticationIsRequired(t *testing.T) {
	e := setup(t)
	alice := e.user(unique("alice") + "@example.com")
	for _, c := range []call{
		{path: "/api/workspaces"},
		{path: "/api/collections", workspace: alice.workspaceID},
		{path: "/api/collections", workspace: alice.workspaceID, cookie: "forged.token"},
	} {
		w, body := e.do(nil, c)
		e.expect(w, 401)
		if code(body) != "UNAUTHENTICATED" {
			t.Fatalf("body = %v", body)
		}
	}
	// A revoked session stops working (after the short "active" cache, which a new server skips).
	if err := e.db.Exec(context.Background(), `UPDATE app.sessions SET revoked_at = now() WHERE user_id = $1`, alice.id); err != nil {
		t.Fatal(err)
	}
	fresh := setup(t)
	w, _ := fresh.do(&alice, call{path: "/api/workspaces"})
	fresh.expect(w, 401)
}

func TestWorkspacesListAndCreate(t *testing.T) {
	e := setup(t)
	bob := e.user(unique("bob") + "@example.com")
	w, body := e.do(&bob, call{method: "POST", path: "/api/workspaces", body: `{"name":"  Bob’s team  "}`})
	e.expect(w, 201)
	created := body["workspace"].(map[string]any)
	if created["name"] != "Bob’s team" || created["role"] != "admin" || created["isPersonal"] != false || created["memberCount"] != 1.0 {
		t.Fatalf("created = %v", created)
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", created["createdAt"].(string)); err != nil {
		t.Fatalf("createdAt %v is not an ISO timestamp", created["createdAt"])
	}

	w, body = e.do(&bob, call{path: "/api/workspaces", noWorkspace: true})
	e.expect(w, 200)
	list := body["workspaces"].([]any)
	if len(list) != 2 || list[0].(map[string]any)["isPersonal"] != true || list[1].(map[string]any)["id"] != created["id"] {
		t.Fatalf("list = %v", list)
	}

	// The new workspace starts with its default notebook.
	w, body = e.do(&bob, call{path: "/api/collections", workspace: created["id"].(string)})
	e.expect(w, 200)
	notebooks := body["collections"].([]any)
	if len(notebooks) != 1 || notebooks[0].(map[string]any)["name"] != "General" || notebooks[0].(map[string]any)["myRole"] != "admin" {
		t.Fatalf("notebooks = %v", notebooks)
	}

	audited, err := e.db.QueryString(context.Background(), `SELECT action FROM app.audit_events WHERE workspace_id = $1`, created["id"])
	if err != nil || audited != "workspace.created" {
		t.Fatalf("audit = %q %v", audited, err)
	}
}

func TestGuestsGetNoPersonalWorkspaceAndCannotCreateOne(t *testing.T) {
	e := setup(t)
	guest := e.user(unique("guest") + "@demo.invalid")
	w, body := e.do(&guest, call{path: "/api/workspaces"})
	e.expect(w, 200)
	if list := body["workspaces"].([]any); len(list) != 0 {
		t.Fatalf("a guest got workspaces: %v", list)
	}
	if n, err := e.db.QueryString(context.Background(), `SELECT count(*)::text FROM app.workspaces WHERE personal_user_id = $1`, guest.id); err != nil || n != "0" {
		t.Fatalf("personal workspaces for the guest = %q %v", n, err)
	}
	w, body = e.do(&guest, call{method: "POST", path: "/api/workspaces", body: `{"name":"Mine"}`})
	e.expect(w, 403)
	if body["error"].(map[string]any)["message"] != auth.GuestDeniedMessage {
		t.Fatalf("body = %v", body)
	}
}

func TestCollectionsRequestChecks(t *testing.T) {
	e := setup(t)
	alice := e.user(unique("alice") + "@example.com")

	w, body := e.do(&alice, call{method: "POST", path: "/api/collections", origin: "https://evil.example", body: `{"name":"x"}`})
	e.expect(w, 403)
	if body["error"].(map[string]any)["message"] != "Cross-origin request blocked." {
		t.Fatalf("csrf = %v", body)
	}
	w, _ = e.do(&alice, call{method: "POST", path: "/api/collections", body: "name=x", contentType: "text/plain"})
	e.expect(w, 415)
	w, _ = e.do(&alice, call{method: "POST", path: "/api/collections", body: `{"name":`})
	e.expect(w, 400)
	w, body = e.do(&alice, call{method: "POST", path: "/api/collections", body: `{"name":""}`})
	e.expect(w, 400)
	if code(body) != "VALIDATION_FAILED" {
		t.Fatalf("validation = %v", body)
	}
	w, _ = e.do(&alice, call{method: "POST", path: "/api/collections", body: `{"name":"` + strings.Repeat("x", 70_000) + `"}`})
	e.expect(w, 413)

	w, body = e.do(&alice, call{method: "POST", path: "/api/collections", body: `{"name":"Work"}`})
	e.expect(w, 201)
	if body["collection"].(map[string]any)["myRole"] != "admin" || body["collection"].(map[string]any)["documentCount"] != 0.0 {
		t.Fatalf("created = %v", body)
	}
	w, body = e.do(&alice, call{method: "POST", path: "/api/collections", body: `{"name":"Work"}`})
	e.expect(w, 409)
	if body["error"].(map[string]any)["message"] != "This workspace already has a notebook with that name." {
		t.Fatalf("duplicate = %v", body)
	}

	w, _ = e.do(&alice, call{method: "DELETE", path: "/api/collections"})
	e.expect(w, 405)
}

func TestWorkspaceScopingAndRoles(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	alice := e.user(unique("alice") + "@example.com")
	bob := e.user(unique("bob") + "@example.com")
	vera := e.user(unique("vera") + "@example.com")
	eddie := e.user(unique("eddie") + "@example.com")

	// A missing or malformed workspace header is a bad request.
	w, _ := e.do(&alice, call{path: "/api/collections", noWorkspace: true})
	e.expect(w, 400)
	w, _ = e.do(&alice, call{path: "/api/collections", workspace: "not-a-uuid"})
	e.expect(w, 400)
	// Another user's workspace behaves like a missing one.
	w, body := e.do(&bob, call{path: "/api/collections", workspace: alice.workspaceID})
	e.expect(w, 404)
	if body["error"].(map[string]any)["message"] != "Workspace not found." {
		t.Fatalf("foreign = %v", body)
	}

	team, err := e.db.CreateWorkspace(ctx, "Team", alice.id)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.db.EnsureDefaultCollection(ctx, team.ID, alice.id); err != nil {
		t.Fatal(err)
	}
	for member, role := range map[string]string{vera.id: "viewer", eddie.id: "editor"} {
		if err := e.db.Exec(ctx, `INSERT INTO app.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)`, team.ID, member, role); err != nil {
			t.Fatal(err)
		}
	}
	general, err := e.db.QueryString(ctx, `SELECT id::text FROM app.collections WHERE workspace_id = $1`, team.ID)
	if err != nil {
		t.Fatal(err)
	}

	w, body = e.do(&vera, call{path: "/api/collections", workspace: team.ID})
	e.expect(w, 200)
	if body["collections"].([]any)[0].(map[string]any)["myRole"] != "viewer" {
		t.Fatalf("viewer list = %v", body)
	}
	w, body = e.do(&vera, call{method: "POST", path: "/api/collections", workspace: team.ID, body: `{"name":"Nope"}`})
	e.expect(w, 403)
	if body["error"].(map[string]any)["message"] != "You need Editor access to create notebooks." {
		t.Fatalf("viewer create = %v", body)
	}
	w, _ = e.do(&eddie, call{method: "POST", path: "/api/collections", workspace: team.ID, body: `{"name":"Specs"}`})
	e.expect(w, 201)

	// A per-notebook override raises Vera on General only.
	if err := e.db.Exec(ctx, `INSERT INTO app.collection_roles (collection_id, user_id, role) VALUES ($1, $2, 'editor')`, general, vera.id); err != nil {
		t.Fatal(err)
	}
	w, body = e.do(&vera, call{path: "/api/collections", workspace: team.ID})
	e.expect(w, 200)
	roles := map[string]any{}
	for _, item := range body["collections"].([]any) {
		notebook := item.(map[string]any)
		roles[notebook["name"].(string)] = notebook["myRole"]
	}
	if roles["General"] != "editor" || roles["Specs"] != "viewer" {
		t.Fatalf("roles = %v", roles)
	}
}

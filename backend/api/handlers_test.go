package api

// Handler tests with an in-memory store: no database needed, so they run everywhere (also as
// WebAssembly under Node). The SQL itself is covered by api_test.go against PostgreSQL.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ankityadav1asia/Corpus/backend/auth"
	"github.com/ankityadav1asia/Corpus/backend/config"
	"github.com/ankityadav1asia/Corpus/backend/logx"
	"github.com/ankityadav1asia/Corpus/backend/store"
)

type memWorkspace struct {
	summary  store.WorkspaceSummary
	personal string
	members  map[string]auth.Role
}

type memCollection struct {
	record      store.CollectionRecord
	workspaceID string
	overrides   map[string]auth.Role
}

type memStore struct {
	sessions    map[string]string // session id → user id
	workspaces  []*memWorkspace
	collections []*memCollection
	audits      []store.AuditEvent
	auditFails  bool
	pingFails   bool
	nextID      int
}

func newMemStore() *memStore { return &memStore{sessions: map[string]string{}} }

func (m *memStore) id() string {
	m.nextID++
	return "00000000-0000-4000-8000-" + strings.Repeat("0", 12-len(itoa(m.nextID))) + itoa(m.nextID)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := ""
	for ; n > 0; n /= 10 {
		digits = string(rune('0'+n%10)) + digits
	}
	return digits
}

func (m *memStore) SessionActive(_ context.Context, sessionID, userID string) (bool, error) {
	return m.sessions[sessionID] == userID, nil
}

func (m *memStore) workspace(id string) *memWorkspace {
	for _, w := range m.workspaces {
		if strings.EqualFold(w.summary.ID, id) {
			return w
		}
	}
	return nil
}

func (m *memStore) Membership(_ context.Context, workspaceID, userID string) (*auth.Membership, error) {
	w := m.workspace(workspaceID)
	if w == nil {
		return nil, nil
	}
	role, ok := w.members[userID]
	if !ok {
		return nil, nil
	}
	return &auth.Membership{Role: role, IsPersonal: w.personal != ""}, nil
}

func (m *memStore) Ping(context.Context) error {
	if m.pingFails {
		return errors.New("connection refused")
	}
	return nil
}

func (m *memStore) EnsurePersonal(_ context.Context, userID string) (string, error) {
	for _, w := range m.workspaces {
		if w.personal == userID {
			return w.summary.ID, nil
		}
	}
	w := &memWorkspace{summary: store.WorkspaceSummary{ID: m.id(), Name: "Personal", CreatedAt: "2026-01-01T00:00:00.000Z"}, personal: userID, members: map[string]auth.Role{userID: auth.Admin}}
	m.workspaces = append(m.workspaces, w)
	return w.summary.ID, nil
}

func (m *memStore) ListWorkspaces(_ context.Context, userID string) ([]store.WorkspaceSummary, error) {
	list := []store.WorkspaceSummary{}
	for _, personalFirst := range []bool{true, false} {
		for _, w := range m.workspaces {
			role, ok := w.members[userID]
			if ok && (w.personal != "") == personalFirst {
				summary := w.summary
				summary.Role, summary.IsPersonal, summary.MemberCount = role, w.personal != "", len(w.members)
				list = append(list, summary)
			}
		}
	}
	return list, nil
}

func (m *memStore) CreateWorkspace(_ context.Context, name, userID string) (store.WorkspaceSummary, error) {
	w := &memWorkspace{summary: store.WorkspaceSummary{ID: m.id(), Name: name, Role: auth.Admin, MemberCount: 1, CreatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}, members: map[string]auth.Role{userID: auth.Admin}}
	m.workspaces = append(m.workspaces, w)
	return w.summary, nil
}

func (m *memStore) ListCollections(_ context.Context, workspaceID, userID string) ([]store.CollectionRecord, error) {
	list := []store.CollectionRecord{}
	for _, c := range m.collections {
		if c.workspaceID == workspaceID {
			record := c.record
			if role, ok := c.overrides[userID]; ok {
				record.Override = &role
			}
			list = append(list, record)
		}
	}
	return list, nil
}

func (m *memStore) CountCollections(_ context.Context, workspaceID string) (int, error) {
	list, _ := m.ListCollections(context.Background(), workspaceID, "")
	return len(list), nil
}

func (m *memStore) CreateCollection(_ context.Context, workspaceID, _, name string) (*store.CollectionRecord, error) {
	for _, c := range m.collections {
		if c.workspaceID == workspaceID && strings.EqualFold(c.record.Name, name) {
			return nil, nil
		}
	}
	c := &memCollection{record: store.CollectionRecord{ID: m.id(), Name: name, CreatedAt: "2026-01-01T00:00:00.000Z"}, workspaceID: workspaceID, overrides: map[string]auth.Role{}}
	m.collections = append(m.collections, c)
	record := c.record
	return &record, nil
}

func (m *memStore) EnsureDefaultCollection(ctx context.Context, workspaceID, createdBy string) error {
	if n, _ := m.CountCollections(ctx, workspaceID); n == 0 {
		_, err := m.CreateCollection(ctx, workspaceID, createdBy, store.DefaultCollectionName)
		return err
	}
	return nil
}

func (m *memStore) RecordAudit(_ context.Context, event store.AuditEvent) error {
	if m.auditFails {
		return errors.New("audit table locked")
	}
	m.audits = append(m.audits, event)
	return nil
}

// ── Harness ──────────────────────────────────────────────────────────────

type memEnv struct {
	t       *testing.T
	store   *memStore
	handler http.Handler
}

func newMemEnv(t *testing.T) *memEnv {
	logx.SetOutput(&strings.Builder{})
	m := newMemStore()
	return &memEnv{t: t, store: m, handler: New(config.Config{PostgresURL: "postgres://memory", Secrets: []string{secret}}, m).Handler()}
}

type person struct {
	id, cookie, personal string
}

func (e *memEnv) person(email string) person {
	e.t.Helper()
	id, sid := e.store.id(), e.store.id()
	e.store.sessions[sid] = id
	now := time.Now().Unix()
	cookie, err := auth.Sign(map[string]any{"v": 2, "sid": sid, "sub": id, "email": email, "name": nil, "iat": now, "exp": now + 600}, []string{secret})
	if err != nil {
		e.t.Fatal(err)
	}
	p := person{id: id, cookie: cookie}
	if !auth.IsGuestEmail(email) {
		p.personal, _ = e.store.EnsurePersonal(context.Background(), id)
		_ = e.store.EnsureDefaultCollection(context.Background(), p.personal, id)
	}
	return p
}

func (e *memEnv) send(method, path string, who *person, workspace, body string, headers ...string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://localhost:3000"+path, strings.NewReader(body))
	r.Host = "localhost:3000"
	if who != nil {
		r.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: who.cookie})
	}
	if workspace != "" {
		r.Header.Set("X-Workspace-Id", workspace)
	}
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if method != "GET" {
		r.Header.Set("Origin", "http://localhost:3000")
	}
	for i := 0; i+1 < len(headers); i += 2 {
		r.Header.Set(headers[i], headers[i+1])
	}
	w := httptest.NewRecorder()
	e.handler.ServeHTTP(w, r)
	return w
}

func (e *memEnv) want(w *httptest.ResponseRecorder, status int, contains ...string) {
	e.t.Helper()
	if w.Code != status {
		e.t.Fatalf("status %d, want %d: %s", w.Code, status, w.Body.String())
	}
	for _, text := range contains {
		if !strings.Contains(w.Body.String(), text) {
			e.t.Fatalf("body %s lacks %q", w.Body.String(), text)
		}
	}
}

// ── Tests ────────────────────────────────────────────────────────────────

func TestHealthReportsDatabaseAndCore(t *testing.T) {
	e := newMemEnv(t)
	e.want(e.send("GET", "/api/health", nil, "", ""), 200, `"ok":true`, `"backend":"go"`)
	e.store.pingFails = true
	e.want(e.send("GET", "/api/health", nil, "", ""), 503, `"database":"down"`)
	noDB := New(config.Config{}, nil).Handler()
	w := httptest.NewRecorder()
	noDB.ServeHTTP(w, httptest.NewRequest("GET", "/api/health", nil))
	if w.Code != 503 {
		t.Fatalf("health without a database = %d", w.Code)
	}
}

func TestSignedOutAndUnknownSessionsGet401(t *testing.T) {
	e := newMemEnv(t)
	alice := e.person("alice@example.com")
	e.want(e.send("GET", "/api/workspaces", nil, "", ""), 401, "UNAUTHENTICATED")
	delete(e.store.sessions, func() string {
		for sid := range e.store.sessions {
			return sid
		}
		return ""
	}())
	e.want(e.send("GET", "/api/collections", &alice, alice.personal, ""), 401)
}

func TestMissingConfigurationIs503(t *testing.T) {
	m := newMemStore()
	handler := New(config.Config{PostgresURL: "postgres://memory"}, m).Handler()
	r := httptest.NewRequest("GET", "/api/workspaces", nil)
	r.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: "a.b"})
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "AUTH_SECRET") {
		t.Fatalf("no AUTH_SECRET = %d %s", w.Code, w.Body.String())
	}
}

func TestCreateAndListWorkspaces(t *testing.T) {
	e := newMemEnv(t)
	bob := e.person("bob@example.com")
	e.want(e.send("POST", "/api/workspaces", &bob, "", `{"name":" Bob’s team "}`), 201, `"name":"Bob’s team"`, `"role":"admin"`, `"isPersonal":false`)
	e.want(e.send("GET", "/api/workspaces", &bob, "", ""), 200, `"name":"Personal"`, `"name":"Bob’s team"`)
	if len(e.store.audits) != 1 || e.store.audits[0].Action != "workspace.created" {
		t.Fatalf("audits = %+v", e.store.audits)
	}
	e.want(e.send("POST", "/api/workspaces", &bob, "", `{"name":""}`), 400, "VALIDATION_FAILED", "Too small")
	e.want(e.send("POST", "/api/workspaces", &bob, "", `{"name":"x"}`, "Origin", "https://evil.example"), 403, "Cross-origin request blocked.")
	e.store.auditFails = true
	e.want(e.send("POST", "/api/workspaces", &bob, "", `{"name":"Second"}`), 201)
}

func TestTeamWorkspaceLimit(t *testing.T) {
	e := newMemEnv(t)
	bob := e.person("bob@example.com")
	for i := 0; i < maxWorkspacesCreated; i++ {
		e.want(e.send("POST", "/api/workspaces", &bob, "", `{"name":"Team"}`), 201)
	}
	e.want(e.send("POST", "/api/workspaces", &bob, "", `{"name":"One more"}`), 409, "at most 20 team workspaces")
}

func TestGuests(t *testing.T) {
	e := newMemEnv(t)
	guest := e.person("guest-0123456789abcdef@demo.invalid")
	e.want(e.send("GET", "/api/workspaces", &guest, "", ""), 200, `{"workspaces":[]}`)
	e.want(e.send("POST", "/api/workspaces", &guest, "", `{"name":"Mine"}`), 403, auth.GuestDeniedMessage)
	owner := e.person("owner@example.com")
	team, _ := e.store.CreateWorkspace(context.Background(), "Demo", owner.id)
	_ = e.store.EnsureDefaultCollection(context.Background(), team.ID, owner.id)
	e.store.workspace(team.ID).members[guest.id] = auth.Admin // even a guest with a high role stays read-only
	e.want(e.send("GET", "/api/collections", &guest, team.ID, ""), 200, `"name":"General"`)
	e.want(e.send("POST", "/api/collections", &guest, team.ID, `{"name":"Mine"}`), 403, auth.GuestDeniedMessage)
}

func TestCollectionsRolesAndScoping(t *testing.T) {
	e := newMemEnv(t)
	alice, bob := e.person("alice@example.com"), e.person("bob@example.com")
	vera, eddie := e.person("vera@example.com"), e.person("eddie@example.com")
	e.want(e.send("GET", "/api/collections", &alice, "", ""), 400, "Select a workspace first")
	e.want(e.send("GET", "/api/collections", &alice, "not-a-uuid", ""), 400)
	e.want(e.send("GET", "/api/collections", &bob, alice.personal, ""), 404, "Workspace not found.")

	team, _ := e.store.CreateWorkspace(context.Background(), "Team", alice.id)
	_ = e.store.EnsureDefaultCollection(context.Background(), team.ID, alice.id)
	members := e.store.workspace(team.ID).members
	members[vera.id], members[eddie.id] = auth.Viewer, auth.Editor

	e.want(e.send("GET", "/api/collections", &vera, team.ID, ""), 200, `"myRole":"viewer"`)
	e.want(e.send("POST", "/api/collections", &vera, team.ID, `{"name":"Nope"}`), 403, "You need Editor access to create notebooks.")
	e.want(e.send("POST", "/api/collections", &eddie, team.ID, `{"name":"Specs"}`), 201, `"myRole":"editor"`, `"documentCount":0`)
	e.want(e.send("POST", "/api/collections", &eddie, team.ID, `{"name":"specs"}`), 409, "already has a notebook with that name")
	e.want(e.send("POST", "/api/collections", &alice, team.ID, `{"name":"`+strings.Repeat("x", 81)+`"}`), 400, "Too big")
	e.want(e.send("PUT", "/api/collections", &alice, team.ID, `{}`), 405)

	// A notebook override raises Vera on one notebook only; admins are admins everywhere.
	e.store.collections[len(e.store.collections)-2].overrides[vera.id] = auth.Editor
	w := e.send("GET", "/api/collections", &vera, team.ID, "")
	e.want(w, 200)
	if strings.Count(w.Body.String(), `"myRole":"editor"`) != 1 || strings.Count(w.Body.String(), `"myRole":"viewer"`) != 1 {
		t.Fatalf("override not applied: %s", w.Body.String())
	}
	e.want(e.send("GET", "/api/collections", &alice, team.ID, ""), 200, `"myRole":"admin"`)
}

func TestNotebookLimit(t *testing.T) {
	e := newMemEnv(t)
	alice := e.person("alice@example.com")
	for i := 1; i < maxCollectionsPerWorkspace; i++ {
		e.want(e.send("POST", "/api/collections", &alice, alice.personal, `{"name":"N`+itoa(i)+`"}`), 201)
	}
	e.want(e.send("POST", "/api/collections", &alice, alice.personal, `{"name":"Too many"}`), 409, "at most 100 notebooks")
}

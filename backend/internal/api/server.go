// Package api is the Go HTTP API. Each route keeps the contract of the TypeScript route it
// replaces (paths, methods, status codes, JSON shapes, error bodies), so the browser app does not
// change. Routes are thin: check access, validate, call the store, respond.
package api

import (
	"context"
	"net/http"

	"github.com/ankityadav1asia/Corpus/backend/internal/auth"
	"github.com/ankityadav1asia/Corpus/backend/internal/config"
	"github.com/ankityadav1asia/Corpus/backend/internal/httpx"
	"github.com/ankityadav1asia/Corpus/backend/internal/store"
)

// Store is what the handlers need from the database (implemented by *store.Store).
type Store interface {
	auth.SessionStore
	auth.MembershipStore
	Ping(ctx context.Context) error
	EnsurePersonal(ctx context.Context, userID string) (string, error)
	ListWorkspaces(ctx context.Context, userID string) ([]store.WorkspaceSummary, error)
	CreateWorkspace(ctx context.Context, name, userID string) (store.WorkspaceSummary, error)
	ListCollections(ctx context.Context, workspaceID, userID string) ([]store.CollectionRecord, error)
	CountCollections(ctx context.Context, workspaceID string) (int, error)
	CreateCollection(ctx context.Context, workspaceID, createdBy, name string) (*store.CollectionRecord, error)
	EnsureDefaultCollection(ctx context.Context, workspaceID, createdBy string) error
	RecordAudit(ctx context.Context, event store.AuditEvent) error
}

type Server struct {
	cfg         config.Config
	store       Store
	sessions    *auth.Sessions
	coreVersion string
}

// New wires the server. A nil store means POSTGRES_URL is missing: database routes answer 503.
// coreVersion is the loaded Rust core's version, reported by the health check.
func New(cfg config.Config, db Store, coreVersion string) *Server {
	s := &Server{cfg: cfg, store: db, coreVersion: coreVersion}
	if db != nil {
		s.sessions = auth.NewSessions(db)
	}
	return s
}

// Handler routes the API paths this service owns. Other /api paths are still served by Next.js
// (see vercel.json); unknown paths and methods get 404 / 405.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /api/health", s.public(s.health))
	mux.Handle("GET /api/workspaces", s.authed(s.listWorkspaces))
	mux.Handle("POST /api/workspaces", s.authed(s.createWorkspace))
	mux.Handle("GET /api/collections", s.workspace(s.listCollections))
	mux.Handle("POST /api/collections", s.workspace(s.createCollection))
	return mux
}

// ── Route wrappers (server/http/route.ts) ────────────────────────────────

type request struct {
	w         http.ResponseWriter
	r         *http.Request
	requestID string
	user      *auth.User
	access    *auth.Access
}

type handler func(*request) error

func (s *Server) execute(w http.ResponseWriter, r *http.Request, needUser bool, run handler) {
	req := &request{w: w, r: r, requestID: httpx.NewRequestID()}
	err := func() error {
		if err := httpx.CheckSameOrigin(r, s.cfg.AppURL); err != nil {
			return err
		}
		if needUser {
			user, err := s.currentUser(r)
			if err != nil {
				return err
			}
			req.user = user
		}
		return run(req)
	}()
	if err != nil {
		httpx.WriteError(w, r, req.requestID, err)
	}
}

func (s *Server) currentUser(r *http.Request) (*auth.User, error) {
	cookie, err := r.Cookie(auth.SessionCookie)
	if err != nil || cookie.Value == "" {
		return nil, nil
	}
	if coreErr := s.cfg.CoreError(); coreErr != nil {
		return nil, coreErr
	}
	return s.sessions.UserFromToken(r.Context(), cookie.Value, s.cfg.Secrets)
}

func (s *Server) public(run handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.execute(w, r, false, run) })
}

// authed: a signed-in user with an active session.
func (s *Server) authed(run handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.execute(w, r, true, func(req *request) error {
			if req.user == nil {
				return errUnauthenticated()
			}
			return run(req)
		})
	})
}

// workspace: signed in and a member of the workspace in X-Workspace-Id (non-members get 404).
func (s *Server) workspace(run handler) http.Handler {
	return s.authed(func(req *request) error {
		workspaceID := req.r.Header.Get("X-Workspace-Id")
		if !httpx.IsID(workspaceID) {
			return errBadRequest("Select a workspace first (missing or invalid X-Workspace-Id header).")
		}
		access, err := auth.ResolveAccess(req.r.Context(), s.store, req.user, workspaceID)
		if err != nil {
			return err
		}
		req.access = access
		return run(req)
	})
}

func (req *request) json(status int, value any) error {
	httpx.WriteJSON(req.w, status, value)
	return nil
}

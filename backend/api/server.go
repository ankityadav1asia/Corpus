// Package api is the Go HTTP API. Each route keeps the contract of the TypeScript route it
// replaces (paths, methods, status codes, JSON shapes, error bodies), so the browser app does not
// change. Routes are thin: check access, validate, call the store, respond.
package api

import (
	"context"
	"net/http"

	"github.com/ankityadav1asia/Corpus/backend/apperr"
	"github.com/ankityadav1asia/Corpus/backend/auth"
	"github.com/ankityadav1asia/Corpus/backend/config"
	"github.com/ankityadav1asia/Corpus/backend/httpx"
	"github.com/ankityadav1asia/Corpus/backend/store"
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
	cfg      config.Config
	store    Store
	admin    AdminStore
	sessions *auth.Sessions
}

// New wires the server. A nil store means POSTGRES_URL is missing: database routes answer 503.
func New(cfg config.Config, db Store) *Server {
	s := &Server{cfg: cfg, store: db}
	if db != nil {
		s.sessions = auth.NewSessions(db)
		// The workspace administration routes need more of the database; a store without it
		// (the in-memory test double) answers 503 there.
		s.admin, _ = db.(AdminStore)
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
	// Group 2: workspace administration.
	mux.Handle("GET /api/workspaces/{id}", s.workspaceParam(s.workspaceDetail))
	mux.Handle("PATCH /api/workspaces/{id}", s.workspaceParam(s.updateWorkspace))
	mux.Handle("DELETE /api/workspaces/{id}", s.workspaceParam(s.deleteWorkspace))
	mux.Handle("GET /api/workspaces/{id}/members", s.workspaceParam(s.listMembers))
	mux.Handle("POST /api/workspaces/{id}/members", s.workspaceParam(s.addMember))
	mux.Handle("PATCH /api/workspaces/{id}/members/{userId}", s.workspaceParam(s.changeMemberRole))
	mux.Handle("DELETE /api/workspaces/{id}/members/{userId}", s.workspaceParam(s.removeMember))
	mux.Handle("DELETE /api/workspaces/{id}/invites", s.workspaceParam(s.revokeInvite))
	mux.Handle("GET /api/workspaces/{id}/audit", s.workspaceParam(s.auditLog))
	mux.Handle("PATCH /api/collections/{id}", s.workspace(s.adminOnly(s.renameCollection)))
	mux.Handle("DELETE /api/collections/{id}", s.workspace(s.adminOnly(s.deleteCollection)))
	mux.Handle("GET /api/collections/{id}/roles", s.workspace(s.adminOnly(s.collectionRoles)))
	mux.Handle("PUT /api/collections/{id}/roles", s.workspace(s.adminOnly(s.setCollectionRole)))
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

// workspaceParam: signed in and a member of the workspace in the path (/api/workspaces/:id/…);
// the id is validated and non-members get 404.
func (s *Server) workspaceParam(run handler) http.Handler {
	return s.authed(func(req *request) error {
		workspaceID, err := pathID(req.r.PathValue("id"))
		if err != nil {
			return err
		}
		access, err := auth.ResolveAccess(req.r.Context(), s.store, req.user, workspaceID)
		if err != nil {
			return err
		}
		req.access = access
		return s.adminOnly(run)(req)
	})
}

// adminOnly: the administration routes need the full store.
func (s *Server) adminOnly(run handler) handler {
	return func(req *request) error {
		if s.admin == nil {
			return apperr.NotConfigured("Server is missing required configuration: POSTGRES_URL")
		}
		return run(req)
	}
}

func (req *request) json(status int, value any) error {
	httpx.WriteJSON(req.w, status, value)
	return nil
}

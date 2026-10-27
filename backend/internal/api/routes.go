package api

import (
	"context"

	"github.com/ankityadav1asia/Corpus/backend/internal/apperr"
	"github.com/ankityadav1asia/Corpus/backend/internal/auth"
	"github.com/ankityadav1asia/Corpus/backend/internal/httpx"
	"github.com/ankityadav1asia/Corpus/backend/internal/logx"
	"github.com/ankityadav1asia/Corpus/backend/internal/store"
)

// Limits from lib/constants.ts and the TypeScript routes.
const (
	workspaceNameChars         = 80
	collectionNameChars        = 80
	maxWorkspacesCreated       = 20
	maxCollectionsPerWorkspace = 100
)

func errUnauthenticated() error          { return apperr.Unauthenticated() }
func errBadRequest(message string) error { return apperr.BadRequest(message) }

// recordAudit is best-effort: a failed audit write is logged and never fails the action.
func (s *Server) recordAudit(ctx context.Context, event store.AuditEvent) {
	if err := s.store.RecordAudit(ctx, event); err != nil {
		logx.Error("Could not write audit event", err, logx.Fields{"action": event.Action})
	}
}

// ── GET /api/health ──────────────────────────────────────────────────────

// health is the public liveness probe: status only, no configuration or error details.
func (s *Server) health(req *request) error {
	status := map[string]any{"ok": true, "database": "up", "backend": "go"}
	if s.coreVersion != "" {
		status["core"] = s.coreVersion
	}
	healthy := s.store != nil
	if healthy {
		if err := s.store.Ping(req.r.Context()); err != nil {
			logx.Warn("Health check: database unreachable", logx.Fields{"error": err.Error()})
			healthy = false
		}
	}
	if !healthy {
		status["ok"], status["database"] = false, "down"
		return req.json(503, status)
	}
	return req.json(200, status)
}

// ── /api/workspaces ──────────────────────────────────────────────────────

// listWorkspaces: the caller's workspaces, personal first. Demo visitors have no personal workspace.
func (s *Server) listWorkspaces(req *request) error {
	ctx := req.r.Context()
	if !req.user.Guest {
		if _, err := s.store.EnsurePersonal(ctx, req.user.ID); err != nil {
			return err
		}
	}
	workspaces, err := s.store.ListWorkspaces(ctx, req.user.ID)
	if err != nil {
		return err
	}
	return req.json(200, map[string]any{"workspaces": workspaces})
}

// createWorkspace: a team workspace; the creator becomes its admin.
func (s *Server) createWorkspace(req *request) error {
	if req.user.Guest {
		return apperr.Forbidden(auth.GuestDeniedMessage)
	}
	body, err := httpx.ReadJSON(req.r, httpx.DefaultJSONLimit)
	if err != nil {
		return err
	}
	name, err := httpx.NameBody(body, workspaceNameChars)
	if err != nil {
		return err
	}
	ctx := req.r.Context()
	mine, err := s.store.ListWorkspaces(ctx, req.user.ID)
	if err != nil {
		return err
	}
	administered := 0
	for _, workspace := range mine {
		if !workspace.IsPersonal && workspace.Role == auth.Admin {
			administered++
		}
	}
	if administered >= maxWorkspacesCreated {
		return apperr.Conflict("You can administer at most 20 team workspaces.")
	}
	workspace, err := s.store.CreateWorkspace(ctx, name, req.user.ID)
	if err != nil {
		return err
	}
	if err := s.store.EnsureDefaultCollection(ctx, workspace.ID, req.user.ID); err != nil {
		return err
	}
	s.recordAudit(ctx, store.AuditEvent{WorkspaceID: workspace.ID, ActorID: req.user.ID, Action: "workspace.created", Details: map[string]any{"name": name}})
	return req.json(201, map[string]any{"workspace": workspace})
}

// ── /api/collections ─────────────────────────────────────────────────────

// Collection is a notebook as the API returns it, with the caller's effective role.
type Collection struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	DocumentCount int       `json:"documentCount"`
	ChunkCount    int       `json:"chunkCount"`
	CreatedAt     string    `json:"createdAt"`
	MyRole        auth.Role `json:"myRole"`
}

func withMyRole(access *auth.Access, record store.CollectionRecord) Collection {
	role := auth.EffectiveCollectionRole(access.Role, record.Override)
	if role == "" {
		role = auth.Viewer
	}
	return Collection{ID: record.ID, Name: record.Name, DocumentCount: record.DocumentCount, ChunkCount: record.ChunkCount, CreatedAt: record.CreatedAt, MyRole: role}
}

// listCollections: every notebook of the workspace, with the caller's effective role on each.
func (s *Server) listCollections(req *request) error {
	records, err := s.store.ListCollections(req.r.Context(), req.access.WorkspaceID, req.access.UserID)
	if err != nil {
		return err
	}
	collections := make([]Collection, 0, len(records))
	for _, record := range records {
		collections = append(collections, withMyRole(req.access, record))
	}
	return req.json(200, map[string]any{"collections": collections})
}

func (s *Server) createCollection(req *request) error {
	if err := auth.RequireWorkspacePermission(req.access, auth.CollectionCreate); err != nil {
		return err
	}
	body, err := httpx.ReadJSON(req.r, httpx.DefaultJSONLimit)
	if err != nil {
		return err
	}
	name, err := httpx.NameBody(body, collectionNameChars)
	if err != nil {
		return err
	}
	ctx := req.r.Context()
	count, err := s.store.CountCollections(ctx, req.access.WorkspaceID)
	if err != nil {
		return err
	}
	if count >= maxCollectionsPerWorkspace {
		return apperr.Conflict("A workspace can have at most 100 notebooks.")
	}
	record, err := s.store.CreateCollection(ctx, req.access.WorkspaceID, req.access.UserID, name)
	if err != nil {
		return err
	}
	if record == nil {
		return apperr.Conflict("This workspace already has a notebook with that name.")
	}
	target, id := "notebook", record.ID
	s.recordAudit(ctx, store.AuditEvent{WorkspaceID: req.access.WorkspaceID, ActorID: req.access.UserID, Action: "notebook.created", TargetType: &target, TargetID: &id, Details: map[string]any{"name": name}})
	return req.json(201, map[string]any{"collection": withMyRole(req.access, *record)})
}

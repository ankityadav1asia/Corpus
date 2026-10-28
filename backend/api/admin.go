package api

import (
	"context"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/ankityadav1asia/Corpus/backend/apperr"
	"github.com/ankityadav1asia/Corpus/backend/auth"
	"github.com/ankityadav1asia/Corpus/backend/httpx"
	"github.com/ankityadav1asia/Corpus/backend/jsstr"
	"github.com/ankityadav1asia/Corpus/backend/logx"
	"github.com/ankityadav1asia/Corpus/backend/store"
)

// Workspace administration (group 2): workspace settings and deletion, members and invitations,
// the audit log, and notebook rename, deletion and per-notebook roles. The TypeScript originals
// are app/api/workspaces/[id]/{route,members,invites,audit}, app/api/collections/[id]/{route,roles}
// and server/workspaces/members.ts.

// AdminStore is what these routes need from the database (implemented by *store.Store).
type AdminStore interface {
	Summary(ctx context.Context, workspaceID, userID string) (*store.WorkspaceSummary, error)
	SettingsJSON(ctx context.Context, workspaceID string) ([]byte, error)
	SaveSettings(ctx context.Context, workspaceID string, settings any) error
	RenameWorkspace(ctx context.Context, workspaceID, name string) error
	DeleteWorkspace(ctx context.Context, workspaceID string) (bool, error)
	Members(ctx context.Context, workspaceID string) ([]store.Member, error)
	Invites(ctx context.Context, workspaceID string) ([]store.Invite, error)
	FindUserIDByEmail(ctx context.Context, email string) (string, error)
	AddMember(ctx context.Context, workspaceID, userID string, role auth.Role) error
	UpsertInvite(ctx context.Context, workspaceID, email string, role auth.Role, invitedBy string) error
	DeleteInvite(ctx context.Context, workspaceID, email string) (bool, error)
	SetRole(ctx context.Context, workspaceID, userID string, role auth.Role) (store.MembershipChange, error)
	RemoveMember(ctx context.Context, workspaceID, userID string) (store.MembershipChange, error)
	AuditLog(ctx context.Context, workspaceID string, limit int) ([]store.AuditEntry, error)
	RateLimitHit(ctx context.Context, key string, windowSeconds int) (int, time.Time, error)
	Notify(ctx context.Context, n store.Notification) error
	Collection(ctx context.Context, workspaceID, id, userID string) (*store.CollectionRef, error)
	RenameCollection(ctx context.Context, workspaceID, id, name string) (store.RenameResult, error)
	DeleteCollection(ctx context.Context, workspaceID, id string) (bool, error)
	RoleOverrides(ctx context.Context, collectionID string) (map[string]auth.Role, error)
	SetRoleOverride(ctx context.Context, collectionID, userID string, role auth.Role) error
}

const (
	auditLimit      = 100
	emailMaxChars   = 254
	invitesPerHour  = 30
	inviteWindowSec = 3600
)

var roleMessage = `Invalid option: expected one of "viewer"|"editor"|"admin"`

// zod's z.email() pattern.
var emailPattern = regexp.MustCompile(`^(?:[A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`)

func validEmail(value string) bool {
	return emailPattern.MatchString(value) && !strings.HasPrefix(value, ".") && !strings.Contains(value, "..")
}

func (s *Server) audit(ctx context.Context, access *auth.Access, action string, targetType, targetID string, details map[string]any) {
	event := store.AuditEvent{WorkspaceID: access.WorkspaceID, ActorID: access.UserID, Action: action, Details: details}
	if targetType != "" {
		event.TargetType, event.TargetID = &targetType, &targetID
	}
	s.recordAudit(ctx, event)
}

// notify is best-effort: a failed notification is logged and never fails the action.
func (s *Server) notify(ctx context.Context, n store.Notification) {
	if err := s.admin.Notify(ctx, n); err != nil {
		logx.Warn("Could not create notification", logx.Fields{"kind": n.Kind, "error": err.Error()})
	}
}

// rateLimit is enforceRateLimit: 429 with the seconds left once key passes limit in its window.
func (s *Server) rateLimit(ctx context.Context, key string, limit, windowSeconds int) error {
	count, reset, err := s.admin.RateLimitHit(ctx, key, windowSeconds)
	if err != nil {
		return err
	}
	if count > limit {
		return apperr.RateLimited(int(math.Max(1, math.Ceil(time.Until(reset).Seconds()))))
	}
	return nil
}

// pathID validates an id from the path (zod's z.guid(), reported at the root path).
func pathID(value string) (string, error) {
	if !httpx.IsID(value) {
		return "", apperr.Validation([]apperr.Issue{{Path: "", Message: "Invalid GUID"}})
	}
	return value, nil
}

func roleField(object map[string]any, name string, nullable bool) (auth.Role, *apperr.Issue) {
	raw, present := object[name]
	if nullable && present && raw == nil {
		return "", nil
	}
	text, _ := raw.(string)
	role := auth.Role(text)
	if !role.Valid() {
		return "", &apperr.Issue{Path: name, Message: roleMessage}
	}
	return role, nil
}

// ── /api/workspaces/:id ──────────────────────────────────────────────────

// WorkspaceDetail is a workspace summary with its settings.
type WorkspaceDetail struct {
	store.WorkspaceSummary
	Settings WorkspaceSettings `json:"settings"`
}

func (s *Server) settings(ctx context.Context, workspaceID string) (WorkspaceSettings, error) {
	raw, err := s.admin.SettingsJSON(ctx, workspaceID)
	if err != nil {
		return WorkspaceSettings{}, err
	}
	return parseStoredSettings(raw), nil
}

func (s *Server) workspaceDetail(req *request) error {
	ctx := req.r.Context()
	summary, err := s.admin.Summary(ctx, req.access.WorkspaceID, req.access.UserID)
	if err != nil {
		return err
	}
	if summary == nil {
		return apperr.NotFound("Workspace")
	}
	settings, err := s.settings(ctx, req.access.WorkspaceID)
	if err != nil {
		return err
	}
	return req.json(200, map[string]any{"workspace": WorkspaceDetail{WorkspaceSummary: *summary, Settings: settings}})
}

// updateWorkspace renames the workspace and/or changes its settings (workspace Admin).
func (s *Server) updateWorkspace(req *request) error {
	body, err := httpx.ReadJSON(req.r, httpx.DefaultJSONLimit)
	if err != nil {
		return err
	}
	object, err := httpx.Object(body)
	if err != nil {
		return err
	}
	var issues []apperr.Issue
	var name string
	_, hasName := object["name"]
	if hasName {
		var issue *apperr.Issue
		if name, issue = httpx.RequiredText(object, "name", workspaceNameChars); issue != nil {
			issues = append(issues, *issue)
		}
	}
	patch, hasSettings := object["settings"]
	var patchObject map[string]any
	if hasSettings {
		var ok bool
		if patchObject, ok = patch.(map[string]any); !ok {
			issues = append(issues, apperr.Issue{Path: "settings", Message: "Invalid input: expected object, received " + jsonType(patch)})
		} else if _, groupIssues := applySettings(defaultSettings(), patchObject, "settings."); len(groupIssues) > 0 {
			issues = append(issues, groupIssues...)
		}
	}
	if len(issues) > 0 {
		return apperr.Validation(issues)
	}
	if !hasName && !hasSettings {
		return apperr.Validation([]apperr.Issue{{Path: "", Message: "Nothing to update"}})
	}
	if err := auth.RequireWorkspacePermission(req.access, auth.WorkspaceManage); err != nil {
		return err
	}
	ctx := req.r.Context()
	if hasName {
		if err := s.admin.RenameWorkspace(ctx, req.access.WorkspaceID, name); err != nil {
			return err
		}
		s.audit(ctx, req.access, "workspace.renamed", "", "", map[string]any{"name": name})
	}
	if hasSettings {
		current, err := s.settings(ctx, req.access.WorkspaceID)
		if err != nil {
			return err
		}
		merged, _ := applySettings(current, patchObject, "settings.")
		if err := s.admin.SaveSettings(ctx, req.access.WorkspaceID, merged); err != nil {
			return err
		}
		s.audit(ctx, req.access, "workspace.settings_changed", "", "", knownSettings(patchObject))
	}
	return s.workspaceDetail(req)
}

// deleteWorkspace removes a team workspace with all of its content (workspace Admin).
func (s *Server) deleteWorkspace(req *request) error {
	if err := auth.RequireWorkspacePermission(req.access, auth.WorkspaceManage); err != nil {
		return err
	}
	if req.access.IsPersonal {
		return apperr.BadRequest("Your personal workspace cannot be deleted.")
	}
	deleted, err := s.admin.DeleteWorkspace(req.r.Context(), req.access.WorkspaceID)
	if err != nil {
		return err
	}
	if !deleted {
		return apperr.NotFound("Workspace")
	}
	return req.json(200, map[string]any{"ok": true})
}

// ── /api/workspaces/:id/members, /members/:userId, /invites ──────────────

// listMembers: any member sees who is in the workspace; invitations are for admins. Demo
// visitors see only themselves, and nobody sees demo visitors.
func (s *Server) listMembers(req *request) error {
	ctx := req.r.Context()
	members, err := s.admin.Members(ctx, req.access.WorkspaceID)
	if err != nil {
		return err
	}
	invites := []store.Invite{}
	if req.access.Role == auth.Admin && !req.access.IsGuest {
		if invites, err = s.admin.Invites(ctx, req.access.WorkspaceID); err != nil {
			return err
		}
	}
	visible := make([]store.Member, 0, len(members))
	for _, member := range members {
		if req.access.IsGuest {
			if member.UserID == req.access.UserID {
				visible = append(visible, member)
			}
		} else if !auth.IsGuestEmail(member.Email) {
			visible = append(visible, member)
		}
	}
	return req.json(200, map[string]any{"members": visible, "invites": invites})
}

// addMember adds an existing account, or invites an address that is accepted when it first
// signs in (workspace Admin).
func (s *Server) addMember(req *request) error {
	body, err := httpx.ReadJSON(req.r, httpx.DefaultJSONLimit)
	if err != nil {
		return err
	}
	object, err := httpx.Object(body)
	if err != nil {
		return err
	}
	var issues []apperr.Issue
	email, issue := httpx.RequiredText(object, "email", emailMaxChars)
	email = strings.ToLower(email)
	if issue != nil {
		if raw, ok := object["email"].(string); ok && jsstr.Trim(raw) == "" {
			issue = &apperr.Issue{Path: "email", Message: "Invalid email address"}
		}
		issues = append(issues, *issue)
	} else if !validEmail(email) {
		issues = append(issues, apperr.Issue{Path: "email", Message: "Invalid email address"})
	}
	role, roleIssue := roleField(object, "role", false)
	if roleIssue != nil {
		issues = append(issues, *roleIssue)
	}
	if len(issues) > 0 {
		return apperr.Validation(issues)
	}

	if err := auth.RequireWorkspacePermission(req.access, auth.MembersManage); err != nil {
		return err
	}
	if req.access.IsPersonal {
		return apperr.BadRequest("Personal workspaces cannot be shared. Create a team workspace instead.")
	}
	ctx := req.r.Context()
	if err := s.rateLimit(ctx, "invite:user:"+req.user.ID, invitesPerHour, inviteWindowSec); err != nil {
		return err
	}
	details := map[string]any{"email": email, "role": role}
	existing, err := s.admin.FindUserIDByEmail(ctx, email)
	if err != nil {
		return err
	}
	if existing == "" {
		if err := s.admin.UpsertInvite(ctx, req.access.WorkspaceID, email, role, req.user.ID); err != nil {
			return err
		}
		s.audit(ctx, req.access, "member.invited", "", "", details)
		return req.json(201, map[string]any{"status": "invited"})
	}
	membership, err := s.store.Membership(ctx, req.access.WorkspaceID, existing)
	if err != nil {
		return err
	}
	if membership != nil {
		return apperr.Conflict("That person is already a member.")
	}
	if err := s.admin.AddMember(ctx, req.access.WorkspaceID, existing, role); err != nil {
		return err
	}
	s.audit(ctx, req.access, "member.added", "user", existing, details)
	workspaceName := "a workspace"
	if summary, err := s.admin.Summary(ctx, req.access.WorkspaceID, req.user.ID); err == nil && summary != nil {
		workspaceName = summary.Name
	}
	actor := req.user.Email
	if req.user.Name != nil && *req.user.Name != "" {
		actor = *req.user.Name
	}
	s.notify(ctx, store.Notification{
		UserID:      existing,
		WorkspaceID: req.access.WorkspaceID,
		Kind:        "member_added",
		Title:       "You were added to “" + workspaceName + "”",
		Body:        actor + " gave you " + string(role) + " access.",
		Link:        map[string]any{"tab": "chat"},
	})
	return req.json(201, map[string]any{"status": "added"})
}

func membershipError(result store.MembershipChange) error {
	switch result {
	case store.ChangeNotFound:
		return apperr.NotFound("Member")
	case store.ChangeLastAdmin:
		return apperr.Conflict("A workspace needs at least one admin. Promote someone else first.")
	}
	return nil
}

// changeMemberRole (workspace Admin).
func (s *Server) changeMemberRole(req *request) error {
	memberID, err := pathID(req.r.PathValue("userId"))
	if err != nil {
		return err
	}
	body, err := httpx.ReadJSON(req.r, httpx.DefaultJSONLimit)
	if err != nil {
		return err
	}
	object, err := httpx.Object(body)
	if err != nil {
		return err
	}
	role, issue := roleField(object, "role", false)
	if issue != nil {
		return apperr.Validation([]apperr.Issue{*issue})
	}
	if err := auth.RequireWorkspacePermission(req.access, auth.MembersManage); err != nil {
		return err
	}
	if req.access.IsPersonal {
		return apperr.BadRequest("Personal workspaces have a single owner.")
	}
	ctx := req.r.Context()
	result, err := s.admin.SetRole(ctx, req.access.WorkspaceID, memberID, role)
	if err != nil {
		return err
	}
	if err := membershipError(result); err != nil {
		return err
	}
	s.audit(ctx, req.access, "member.role_changed", "user", memberID, map[string]any{"role": role})
	return req.json(200, map[string]any{"ok": true})
}

// removeMember removes a member (workspace Admin), or lets a member leave.
func (s *Server) removeMember(req *request) error {
	memberID, err := pathID(req.r.PathValue("userId"))
	if err != nil {
		return err
	}
	leaving := memberID == req.access.UserID
	if !leaving {
		if err := auth.RequireWorkspacePermission(req.access, auth.MembersManage); err != nil {
			return err
		}
	}
	if req.access.IsPersonal {
		return apperr.BadRequest("You cannot leave your personal workspace.")
	}
	ctx := req.r.Context()
	result, err := s.admin.RemoveMember(ctx, req.access.WorkspaceID, memberID)
	if err != nil {
		return err
	}
	if err := membershipError(result); err != nil {
		return err
	}
	action := "member.removed"
	if leaving {
		action = "member.left"
	}
	s.audit(ctx, req.access, action, "user", memberID, nil)
	return req.json(200, map[string]any{"ok": true})
}

// revokeInvite (workspace Admin): DELETE …/invites?email=…
func (s *Server) revokeInvite(req *request) error {
	email := strings.ToLower(jsstr.Trim(req.r.URL.Query().Get("email")))
	if email == "" {
		return apperr.Validation([]apperr.Issue{{Path: "email", Message: "Invalid input: expected string, received undefined"}})
	}
	if !validEmail(email) {
		return apperr.Validation([]apperr.Issue{{Path: "email", Message: "Invalid email address"}})
	}
	if err := auth.RequireWorkspacePermission(req.access, auth.MembersManage); err != nil {
		return err
	}
	ctx := req.r.Context()
	deleted, err := s.admin.DeleteInvite(ctx, req.access.WorkspaceID, email)
	if err != nil {
		return err
	}
	if !deleted {
		return apperr.NotFound("Invitation")
	}
	s.audit(ctx, req.access, "invite.revoked", "", "", map[string]any{"email": email})
	return req.json(200, map[string]any{"ok": true})
}

// auditLog: recent changes in the workspace (workspace Admin).
func (s *Server) auditLog(req *request) error {
	if err := auth.RequireWorkspacePermission(req.access, auth.WorkspaceManage); err != nil {
		return err
	}
	events, err := s.admin.AuditLog(req.r.Context(), req.access.WorkspaceID, auditLimit)
	if err != nil {
		return err
	}
	return req.json(200, map[string]any{"events": events})
}

// ── /api/collections/:id, /roles ─────────────────────────────────────────

// collectionManager loads the notebook in the path and requires notebook Admin on it.
func (s *Server) collectionManager(req *request) (*store.CollectionRef, error) {
	id, err := pathID(req.r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	if req.access.IsGuest && !auth.GuestCan(auth.CollectionManage) {
		return nil, apperr.Forbidden(auth.GuestDeniedMessage)
	}
	ref, err := s.admin.Collection(req.r.Context(), req.access.WorkspaceID, id, req.access.UserID)
	if err != nil {
		return nil, err
	}
	if ref == nil {
		return nil, apperr.NotFound("Notebook")
	}
	role := auth.EffectiveCollectionRole(req.access.Role, ref.Override)
	if role == "" {
		role = auth.Viewer
	}
	if err := auth.RequirePermission(role, auth.CollectionManage); err != nil {
		return nil, err
	}
	return ref, nil
}

// renameCollection (notebook Admin).
func (s *Server) renameCollection(req *request) error {
	if _, err := pathID(req.r.PathValue("id")); err != nil {
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
	ref, err := s.collectionManager(req)
	if err != nil {
		return err
	}
	ctx := req.r.Context()
	result, err := s.admin.RenameCollection(ctx, req.access.WorkspaceID, ref.ID, name)
	if err != nil {
		return err
	}
	switch result {
	case store.RenameNotFound:
		return apperr.NotFound("Notebook")
	case store.RenameConflict:
		return apperr.Conflict("This workspace already has a notebook with that name.")
	}
	s.audit(ctx, req.access, "notebook.renamed", "notebook", ref.ID, map[string]any{"from": ref.Name, "to": name})
	return req.json(200, map[string]any{"ok": true})
}

// deleteCollection removes the notebook with its documents and chunks (notebook Admin).
func (s *Server) deleteCollection(req *request) error {
	ref, err := s.collectionManager(req)
	if err != nil {
		return err
	}
	ctx := req.r.Context()
	deleted, err := s.admin.DeleteCollection(ctx, req.access.WorkspaceID, ref.ID)
	if err != nil {
		return err
	}
	if !deleted {
		return apperr.NotFound("Notebook")
	}
	s.audit(ctx, req.access, "notebook.deleted", "notebook", ref.ID, map[string]any{"name": ref.Name})
	return req.json(200, map[string]any{"ok": true})
}

// CollectionRoleEntry is a member with their override on a notebook and the resulting role.
type CollectionRoleEntry struct {
	UserID        string     `json:"userId"`
	Email         string     `json:"email"`
	Name          *string    `json:"name"`
	WorkspaceRole auth.Role  `json:"workspaceRole"`
	Override      *auth.Role `json:"override"`
	EffectiveRole auth.Role  `json:"effectiveRole"`
}

// collectionRoles: workspace members with their per-notebook override (notebook Admin).
func (s *Server) collectionRoles(req *request) error {
	ref, err := s.collectionManager(req)
	if err != nil {
		return err
	}
	ctx := req.r.Context()
	members, err := s.admin.Members(ctx, req.access.WorkspaceID)
	if err != nil {
		return err
	}
	overrides, err := s.admin.RoleOverrides(ctx, ref.ID)
	if err != nil {
		return err
	}
	roles := make([]CollectionRoleEntry, 0, len(members))
	for _, member := range members {
		var override *auth.Role
		if role, ok := overrides[member.UserID]; ok {
			override = &role
		}
		effective := auth.EffectiveCollectionRole(member.Role, override)
		if effective == "" {
			effective = member.Role
		}
		roles = append(roles, CollectionRoleEntry{UserID: member.UserID, Email: member.Email, Name: member.Name, WorkspaceRole: member.Role, Override: override, EffectiveRole: effective})
	}
	return req.json(200, map[string]any{"roles": roles})
}

// setCollectionRole sets (role) or clears (null) a member's override (notebook Admin).
func (s *Server) setCollectionRole(req *request) error {
	if _, err := pathID(req.r.PathValue("id")); err != nil {
		return err
	}
	body, err := httpx.ReadJSON(req.r, httpx.DefaultJSONLimit)
	if err != nil {
		return err
	}
	object, err := httpx.Object(body)
	if err != nil {
		return err
	}
	var issues []apperr.Issue
	userID, _ := object["userId"].(string)
	if !httpx.IsID(userID) {
		issues = append(issues, apperr.Issue{Path: "userId", Message: "Invalid GUID"})
	}
	role, issue := roleField(object, "role", true)
	if issue != nil {
		issues = append(issues, *issue)
	}
	if len(issues) > 0 {
		return apperr.Validation(issues)
	}
	ref, err := s.collectionManager(req)
	if err != nil {
		return err
	}
	ctx := req.r.Context()
	membership, err := s.store.Membership(ctx, req.access.WorkspaceID, userID)
	if err != nil {
		return err
	}
	if membership == nil {
		return apperr.NotFound("Member")
	}
	if membership.Role == auth.Admin {
		return apperr.BadRequest("Workspace admins always have Admin access to every notebook.")
	}
	if err := s.admin.SetRoleOverride(ctx, ref.ID, userID, role); err != nil {
		return err
	}
	shown := "workspace role"
	if role != "" {
		shown = string(role)
	}
	s.audit(ctx, req.access, "notebook.access_changed", "user", userID, map[string]any{"notebook": ref.Name, "role": shown})
	return req.json(200, map[string]any{"ok": true})
}

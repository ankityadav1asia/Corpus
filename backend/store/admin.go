package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ankityadav1asia/Corpus/backend/auth"
)

// Workspace administration: settings, members, invitations, the audit log, notebook rename,
// delete and per-notebook roles. The SQL is server/repositories/{workspaces,collections,audit}.ts.

// MembershipChange is the outcome of a role change or removal.
type MembershipChange string

const (
	ChangeOK        MembershipChange = "ok"
	ChangeNotFound  MembershipChange = "not_found"
	ChangeLastAdmin MembershipChange = "last_admin"
)

// RenameResult is the outcome of renaming a notebook.
type RenameResult string

const (
	RenameOK       RenameResult = "ok"
	RenameNotFound RenameResult = "not_found"
	RenameConflict RenameResult = "conflict"
)

// Summary is the caller's view of one workspace, or nil when they are not a member.
func (s *Store) Summary(ctx context.Context, workspaceID, userID string) (*WorkspaceSummary, error) {
	summary, err := scanSummary(s.pool.QueryRow(ctx, `SELECT `+summaryColumns+`
		FROM app.workspace_members m JOIN app.workspaces w ON w.id = m.workspace_id
		WHERE w.id = $1 AND m.user_id = $2`, workspaceID, userID))
	if errors.Is(err, pgx.ErrNoRows) || isInvalidID(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &summary, nil
}

// SettingsJSON is the stored settings document (null when never saved).
func (s *Store) SettingsJSON(ctx context.Context, workspaceID string) ([]byte, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT settings FROM app.workspaces WHERE id = $1`, workspaceID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return raw, err
}

func (s *Store) SaveSettings(ctx context.Context, workspaceID string, settings any) error {
	encoded, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `UPDATE app.workspaces SET settings = $2::jsonb WHERE id = $1`, workspaceID, string(encoded))
	return err
}

func (s *Store) RenameWorkspace(ctx context.Context, workspaceID, name string) error {
	_, err := s.pool.Exec(ctx, `UPDATE app.workspaces SET name = $2 WHERE id = $1`, workspaceID, name)
	return err
}

// DeleteWorkspace removes a team workspace and everything in it; personal workspaces stay.
func (s *Store) DeleteWorkspace(ctx context.Context, workspaceID string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM app.workspaces WHERE id = $1 AND personal_user_id IS NULL`, workspaceID)
	return tag.RowsAffected() > 0, err
}

// Member is a workspace member as the API returns it.
type Member struct {
	UserID   string    `json:"userId"`
	Email    string    `json:"email"`
	Name     *string   `json:"name"`
	Role     auth.Role `json:"role"`
	JoinedAt string    `json:"joinedAt"`
}

// Invite is a pending invitation.
type Invite struct {
	Email     string    `json:"email"`
	Role      auth.Role `json:"role"`
	CreatedAt string    `json:"createdAt"`
}

// Members: admins first, then editors, then viewers, each by email.
func (s *Store) Members(ctx context.Context, workspaceID string) ([]Member, error) {
	rows, err := s.pool.Query(ctx, `SELECT u.id::text, u.email, u.name, m.role, m.created_at
		FROM app.workspace_members m JOIN app.users u ON u.id = m.user_id
		WHERE m.workspace_id = $1
		ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.email`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Member{}
	for rows.Next() {
		var member Member
		var role string
		var joined time.Time
		if err := rows.Scan(&member.UserID, &member.Email, &member.Name, &role, &joined); err != nil {
			return nil, err
		}
		member.Role, member.JoinedAt = auth.Role(role), IsoTime(joined)
		list = append(list, member)
	}
	return list, rows.Err()
}

func (s *Store) Invites(ctx context.Context, workspaceID string) ([]Invite, error) {
	rows, err := s.pool.Query(ctx, `SELECT email, role, created_at FROM app.workspace_invites WHERE workspace_id = $1 ORDER BY created_at`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Invite{}
	for rows.Next() {
		var invite Invite
		var role string
		var created time.Time
		if err := rows.Scan(&invite.Email, &role, &created); err != nil {
			return nil, err
		}
		invite.Role, invite.CreatedAt = auth.Role(role), IsoTime(created)
		list = append(list, invite)
	}
	return list, rows.Err()
}

// FindUserIDByEmail returns "" when no account has that address.
func (s *Store) FindUserIDByEmail(ctx context.Context, email string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `SELECT id::text FROM app.users WHERE email = lower($1)`, email).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// AddMember adds a member, or changes the role of an existing one.
func (s *Store) AddMember(ctx context.Context, workspaceID, userID string, role auth.Role) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO app.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
		ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`, workspaceID, userID, string(role))
	return err
}

func (s *Store) UpsertInvite(ctx context.Context, workspaceID, email string, role auth.Role, invitedBy string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO app.workspace_invites (workspace_id, email, role, invited_by) VALUES ($1, lower($2), $3, $4)
		ON CONFLICT (workspace_id, email) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, created_at = now()`,
		workspaceID, email, string(role), invitedBy)
	return err
}

func (s *Store) DeleteInvite(ctx context.Context, workspaceID, email string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM app.workspace_invites WHERE workspace_id = $1 AND email = lower($2)`, workspaceID, email)
	return tag.RowsAffected() > 0, err
}

// lockedChange runs one membership statement after locking the workspace row, so two admins
// demoting or removing each other at the same time cannot leave the workspace without an admin.
func (s *Store) lockedChange(ctx context.Context, workspaceID, userID, statement string, args ...any) (MembershipChange, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT id FROM app.workspaces WHERE id = $1 FOR UPDATE`, workspaceID); err != nil {
		return "", err
	}
	tag, err := tx.Exec(ctx, statement, args...)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() == 0 {
		if err := tx.Commit(ctx); err != nil {
			return "", err
		}
		membership, err := s.Membership(ctx, workspaceID, userID)
		if err != nil {
			return "", err
		}
		if membership != nil {
			return ChangeLastAdmin, nil
		}
		return ChangeNotFound, nil
	}
	return ChangeOK, tx.Commit(ctx)
}

// SetRole changes a role but never leaves the workspace without an admin.
func (s *Store) SetRole(ctx context.Context, workspaceID, userID string, role auth.Role) (MembershipChange, error) {
	return s.lockedChange(ctx, workspaceID, userID, `UPDATE app.workspace_members m SET role = $3
		WHERE m.workspace_id = $1 AND m.user_id = $2
		  AND ($3 = 'admin' OR m.role <> 'admin'
		       OR (SELECT count(*) FROM app.workspace_members a WHERE a.workspace_id = $1 AND a.role = 'admin') > 1)`,
		workspaceID, userID, string(role))
}

// RemoveMember removes a member (never the last admin). Their notebook overrides, connected
// accounts and the public links they created go with them.
func (s *Store) RemoveMember(ctx context.Context, workspaceID, userID string) (MembershipChange, error) {
	result, err := s.lockedChange(ctx, workspaceID, userID, `DELETE FROM app.workspace_members m
		WHERE m.workspace_id = $1 AND m.user_id = $2
		  AND (m.role <> 'admin'
		       OR (SELECT count(*) FROM app.workspace_members a WHERE a.workspace_id = $1 AND a.role = 'admin') > 1)`,
		workspaceID, userID)
	if err != nil || result != ChangeOK {
		return result, err
	}
	for _, cleanup := range []string{
		`DELETE FROM app.collection_roles cr USING app.collections c
		 WHERE cr.collection_id = c.id AND c.workspace_id = $1 AND cr.user_id = $2`,
		`DELETE FROM app.connections WHERE workspace_id = $1 AND user_id = $2`,
		`UPDATE app.share_links SET revoked_at = now() WHERE workspace_id = $1 AND created_by = $2 AND revoked_at IS NULL`,
	} {
		if _, err := s.pool.Exec(ctx, cleanup, workspaceID, userID); err != nil {
			return "", err
		}
	}
	return ChangeOK, nil
}

// AuditEntry is one audit event as the API returns it.
type AuditEntry struct {
	ID         string         `json:"id"`
	Action     string         `json:"action"`
	TargetType *string        `json:"targetType"`
	TargetID   *string        `json:"targetId"`
	Details    map[string]any `json:"details"`
	ActorEmail *string        `json:"actorEmail"`
	CreatedAt  string         `json:"createdAt"`
}

// AuditLog: the latest events of a workspace, newest first.
func (s *Store) AuditLog(ctx context.Context, workspaceID string, limit int) ([]AuditEntry, error) {
	rows, err := s.pool.Query(ctx, `SELECT e.id::text, e.action, e.target_type, e.target_id, e.details, e.created_at, u.email
		FROM app.audit_events e LEFT JOIN app.users u ON u.id = e.actor_id
		WHERE e.workspace_id = $1
		ORDER BY e.created_at DESC, e.id DESC
		LIMIT $2`, workspaceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []AuditEntry{}
	for rows.Next() {
		var entry AuditEntry
		var details []byte
		var created time.Time
		if err := rows.Scan(&entry.ID, &entry.Action, &entry.TargetType, &entry.TargetID, &details, &created, &entry.ActorEmail); err != nil {
			return nil, err
		}
		entry.Details = map[string]any{}
		_ = json.Unmarshal(details, &entry.Details)
		if entry.Details == nil {
			entry.Details = map[string]any{}
		}
		entry.CreatedAt = IsoTime(created)
		list = append(list, entry)
	}
	return list, rows.Err()
}

// RateLimitHit counts one request against key in a fixed window; it returns the count and when
// the window resets (server/repositories/auth-state.ts → hit).
func (s *Store) RateLimitHit(ctx context.Context, key string, windowSeconds int) (int, time.Time, error) {
	var count int
	var reset time.Time
	err := s.pool.QueryRow(ctx, `INSERT INTO app.rate_limits AS rl (key, window_start, count)
		VALUES ($1, now(), 1)
		ON CONFLICT (key) DO UPDATE SET
		  count = CASE WHEN rl.window_start <= now() - make_interval(secs => $2::float8) THEN 1 ELSE rl.count + 1 END,
		  window_start = CASE WHEN rl.window_start <= now() - make_interval(secs => $2::float8) THEN now() ELSE rl.window_start END
		RETURNING count, window_start + make_interval(secs => $2::float8)`, key, windowSeconds).Scan(&count, &reset)
	return count, reset, err
}

// Notification is an in-app notification for one person.
type Notification struct {
	UserID      string
	WorkspaceID string
	Kind        string
	Title       string
	Body        string
	Link        map[string]any
}

func (s *Store) Notify(ctx context.Context, n Notification) error {
	link, err := json.Marshal(n.Link)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO app.notifications (user_id, workspace_id, kind, title, body, link)
		VALUES ($1, $2, $3, left($4, 200), left($5, 500), $6::jsonb)`, n.UserID, n.WorkspaceID, n.Kind, n.Title, n.Body, string(link))
	return err
}

// CollectionRef is a notebook of a workspace and the caller's override on it.
type CollectionRef struct {
	ID       string
	Name     string
	Override *auth.Role
}

func (s *Store) Collection(ctx context.Context, workspaceID, id, userID string) (*CollectionRef, error) {
	var ref CollectionRef
	var override *string
	err := s.pool.QueryRow(ctx, `SELECT c.id::text, c.name, cr.role
		FROM app.collections c
		LEFT JOIN app.collection_roles cr ON cr.collection_id = c.id AND cr.user_id = $3
		WHERE c.id = $1 AND c.workspace_id = $2`, id, workspaceID, userID).Scan(&ref.ID, &ref.Name, &override)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidID(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if override != nil {
		role := auth.Role(*override)
		ref.Override = &role
	}
	return &ref, nil
}

func (s *Store) RenameCollection(ctx context.Context, workspaceID, id, name string) (RenameResult, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE app.collections SET name = $3 WHERE id = $1 AND workspace_id = $2`, id, workspaceID, name)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return RenameConflict, nil
	}
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() == 0 {
		return RenameNotFound, nil
	}
	return RenameOK, nil
}

// DeleteCollection removes the notebook with its documents and chunks; conversations keep their
// history (their notebook becomes NULL).
func (s *Store) DeleteCollection(ctx context.Context, workspaceID, id string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM app.collections WHERE id = $1 AND workspace_id = $2`, id, workspaceID)
	return tag.RowsAffected() > 0, err
}

// RoleOverrides: per-notebook roles by user id.
func (s *Store) RoleOverrides(ctx context.Context, collectionID string) (map[string]auth.Role, error) {
	rows, err := s.pool.Query(ctx, `SELECT user_id::text, role FROM app.collection_roles WHERE collection_id = $1`, collectionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	overrides := map[string]auth.Role{}
	for rows.Next() {
		var userID, role string
		if err := rows.Scan(&userID, &role); err != nil {
			return nil, err
		}
		overrides[userID] = auth.Role(role)
	}
	return overrides, rows.Err()
}

// SetRoleOverride sets a member's role on a notebook, or with an empty role removes it.
func (s *Store) SetRoleOverride(ctx context.Context, collectionID, userID string, role auth.Role) error {
	if role == "" {
		_, err := s.pool.Exec(ctx, `DELETE FROM app.collection_roles WHERE collection_id = $1 AND user_id = $2`, collectionID, userID)
		return err
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO app.collection_roles (collection_id, user_id, role) VALUES ($1, $2, $3)
		ON CONFLICT (collection_id, user_id) DO UPDATE SET role = EXCLUDED.role`, collectionID, userID, string(role))
	return err
}

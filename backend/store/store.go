// Package store holds all SQL of the Go backend, against the same PostgreSQL schema (app.*) the
// TypeScript migrations create. Every query is parameterised and scoped by workspace; an id from
// another workspace behaves like a missing one.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ankityadav1asia/Corpus/backend/auth"
)

type Store struct {
	pool *pgxpool.Pool
}

// Open connects to POSTGRES_URL. Statements are sent unnamed (QueryExecModeExec), which works
// behind poolers in transaction mode, such as Neon's pooled endpoint.
func Open(ctx context.Context, postgresURL string, maxConns int32) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(cleanURL(postgresURL))
	if err != nil {
		return nil, fmt.Errorf("POSTGRES_URL is not a valid connection string: %w", err)
	}
	cfg.MaxConns = maxConns
	cfg.MaxConnIdleTime = time.Minute
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &Store{pool: pool}, nil
}

// cleanURL drops connection options libpq knows and pgx would send to the server as settings.
func cleanURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") {
		return raw
	}
	query := parsed.Query()
	query.Del("channel_binding")
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) Ping(ctx context.Context) error {
	var one int
	return s.pool.QueryRow(ctx, `SELECT 1`).Scan(&one)
}

// IsoTime formats a timestamp like JavaScript's Date#toISOString (UTC, milliseconds).
func IsoTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// ── Sessions ─────────────────────────────────────────────────────────────

// SessionActive: the session belongs to the user, was not revoked and has not expired.
func (s *Store) SessionActive(ctx context.Context, sessionID, userID string) (bool, error) {
	rows, err := s.pool.Query(ctx, `SELECT 1 FROM app.sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()`, sessionID, userID)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	found := rows.Next()
	return found, rows.Err()
}

// ── Workspaces ───────────────────────────────────────────────────────────

type WorkspaceSummary struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Role        auth.Role `json:"role"`
	IsPersonal  bool      `json:"isPersonal"`
	MemberCount int       `json:"memberCount"`
	CreatedAt   string    `json:"createdAt"`
}

const summaryColumns = `w.id::text, w.name, w.created_at, m.role, (w.personal_user_id IS NOT NULL) AS is_personal,
  (SELECT count(*) FROM app.workspace_members mm WHERE mm.workspace_id = w.id)::int AS member_count`

func scanSummary(row pgx.Row) (WorkspaceSummary, error) {
	var summary WorkspaceSummary
	var created time.Time
	var role string
	if err := row.Scan(&summary.ID, &summary.Name, &created, &role, &summary.IsPersonal, &summary.MemberCount); err != nil {
		return summary, err
	}
	summary.Role, summary.CreatedAt = auth.Role(role), IsoTime(created)
	return summary, nil
}

func (s *Store) Membership(ctx context.Context, workspaceID, userID string) (*auth.Membership, error) {
	var role string
	var personal bool
	err := s.pool.QueryRow(ctx, `SELECT m.role, (w.personal_user_id IS NOT NULL)
		FROM app.workspace_members m JOIN app.workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = $1 AND m.user_id = $2`, workspaceID, userID).Scan(&role, &personal)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidID(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &auth.Membership{Role: auth.Role(role), IsPersonal: personal}, nil
}

// isInvalidID: a malformed uuid can only mean "no such row" to callers.
func isInvalidID(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "22P02"
}

// EnsurePersonal idempotently creates the user's personal workspace and admin membership.
func (s *Store) EnsurePersonal(ctx context.Context, userID string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `WITH created AS (
		   INSERT INTO app.workspaces (name, personal_user_id, created_by) VALUES ('Personal', $1, $1)
		   ON CONFLICT (personal_user_id) DO NOTHING
		   RETURNING id
		 ),
		 workspace AS (
		   SELECT id FROM created
		   UNION ALL
		   SELECT id FROM app.workspaces WHERE personal_user_id = $1
		 ),
		 membership AS (
		   INSERT INTO app.workspace_members (workspace_id, user_id, role)
		   SELECT id, $1, 'admin' FROM workspace LIMIT 1
		   ON CONFLICT DO NOTHING
		 )
		 SELECT id::text FROM workspace LIMIT 1`, userID).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	// A concurrent first sign-in created it after this statement's snapshot; it has committed by
	// now (our insert waited for it), so a new statement sees it.
	if err := s.pool.QueryRow(ctx, `SELECT id::text FROM app.workspaces WHERE personal_user_id = $1`, userID).Scan(&id); err != nil {
		return "", fmt.Errorf("could not create the personal workspace: %w", err)
	}
	return id, nil
}

func (s *Store) ListWorkspaces(ctx context.Context, userID string) ([]WorkspaceSummary, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+summaryColumns+`
		FROM app.workspace_members m JOIN app.workspaces w ON w.id = m.workspace_id
		WHERE m.user_id = $1
		ORDER BY (w.personal_user_id IS NOT NULL) DESC, w.created_at, w.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []WorkspaceSummary{}
	for rows.Next() {
		summary, err := scanSummary(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, summary)
	}
	return list, rows.Err()
}

// CreateWorkspace creates a team workspace with its creator as admin.
func (s *Store) CreateWorkspace(ctx context.Context, name, userID string) (WorkspaceSummary, error) {
	return scanSummary(s.pool.QueryRow(ctx, `WITH w AS (
		   INSERT INTO app.workspaces (name, created_by) VALUES ($1, $2) RETURNING id, name, created_at
		 ),
		 m AS (
		   INSERT INTO app.workspace_members (workspace_id, user_id, role) SELECT id, $2, 'admin' FROM w RETURNING role
		 )
		 SELECT w.id::text, w.name, w.created_at, 'admin', false, 1 FROM w`, name, userID))
}

// ── Notebooks (collections) ──────────────────────────────────────────────

// DefaultCollectionName is the notebook every workspace starts with.
const DefaultCollectionName = "General"

// CollectionRecord is a stored notebook plus the caller's role override.
type CollectionRecord struct {
	ID            string
	Name          string
	DocumentCount int
	ChunkCount    int
	CreatedAt     string
	Override      *auth.Role
}

func scanCollection(row pgx.Row) (CollectionRecord, error) {
	var record CollectionRecord
	var created time.Time
	var override *string
	if err := row.Scan(&record.ID, &record.Name, &created, &override, &record.DocumentCount, &record.ChunkCount); err != nil {
		return record, err
	}
	record.CreatedAt = IsoTime(created)
	if override != nil {
		role := auth.Role(*override)
		record.Override = &role
	}
	return record, nil
}

func (s *Store) ListCollections(ctx context.Context, workspaceID, userID string) ([]CollectionRecord, error) {
	rows, err := s.pool.Query(ctx, `SELECT c.id::text, c.name, c.created_at, cr.role AS override,
		        count(d.id) FILTER (WHERE d.status = 'ready')::int AS document_count,
		        coalesce(sum(d.chunk_count) FILTER (WHERE d.status = 'ready'), 0)::int AS chunk_count
		 FROM app.collections c
		 LEFT JOIN app.documents d ON d.collection_id = c.id
		 LEFT JOIN app.collection_roles cr ON cr.collection_id = c.id AND cr.user_id = $2
		 WHERE c.workspace_id = $1
		 GROUP BY c.id, cr.role
		 ORDER BY c.created_at, c.name`, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []CollectionRecord{}
	for rows.Next() {
		record, err := scanCollection(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, record)
	}
	return list, rows.Err()
}

func (s *Store) CountCollections(ctx context.Context, workspaceID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*)::int FROM app.collections WHERE workspace_id = $1`, workspaceID).Scan(&n)
	return n, err
}

// CreateCollection returns nil when the workspace already has a notebook with that name.
func (s *Store) CreateCollection(ctx context.Context, workspaceID, createdBy, name string) (*CollectionRecord, error) {
	record, err := scanCollection(s.pool.QueryRow(ctx, `INSERT INTO app.collections (workspace_id, created_by, name) VALUES ($1, $2, $3)
		 ON CONFLICT DO NOTHING
		 RETURNING id::text, name, created_at, NULL::text, 0, 0`, workspaceID, createdBy, name))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

// EnsureDefaultCollection: every workspace always has at least one notebook to ingest into.
func (s *Store) EnsureDefaultCollection(ctx context.Context, workspaceID, createdBy string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO app.collections (workspace_id, created_by, name)
		 SELECT $1, $2, $3
		 WHERE NOT EXISTS (SELECT 1 FROM app.collections WHERE workspace_id = $1)
		 ON CONFLICT DO NOTHING`, workspaceID, createdBy, DefaultCollectionName)
	return err
}

// ── Audit log ────────────────────────────────────────────────────────────

type AuditEvent struct {
	WorkspaceID string
	ActorID     string
	Action      string
	TargetType  *string
	TargetID    *string
	Details     map[string]any
}

func (s *Store) RecordAudit(ctx context.Context, event AuditEvent) error {
	details := event.Details
	if details == nil {
		details = map[string]any{}
	}
	data, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO app.audit_events (workspace_id, actor_id, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
		event.WorkspaceID, event.ActorID, event.Action, event.TargetType, event.TargetID, string(data))
	return err
}

// ── Test helpers ─────────────────────────────────────────────────────────

// Exec runs a statement (tests use it to set up data).
func (s *Store) Exec(ctx context.Context, sql string, args ...any) error {
	_, err := s.pool.Exec(ctx, sql, args...)
	return err
}

// QueryString returns the first column of the first row as text (tests).
func (s *Store) QueryString(ctx context.Context, sql string, args ...any) (string, error) {
	var value string
	err := s.pool.QueryRow(ctx, sql, args...).Scan(&value)
	return strings.TrimSpace(value), err
}

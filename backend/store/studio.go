package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Group 4b: the studio's reports (server/repositories/reports.ts). The
// routes only queue them; the TypeScript job runner writes them.

// ReportSummary is a report as the list returns it.
type ReportSummary struct {
	ID             string  `json:"id"`
	Title          string  `json:"title"`
	Template       string  `json:"template"`
	Format         string  `json:"format"`
	Status         string  `json:"status"`
	Progress       *string `json:"progress"`
	CreatedAt      string  `json:"createdAt"`
	CompletedAt    *string `json:"completedAt"`
	CreatedByEmail *string `json:"createdByEmail"`
}

// ReportDetail adds what was asked for and what was written. CreatedBy is not returned.
type ReportDetail struct {
	ReportSummary
	Instructions *string         `json:"instructions"`
	Content      *string         `json:"content"`
	Output       json.RawMessage `json:"output"`
	Sources      json.RawMessage `json:"sources"`
	Error        *string         `json:"error"`
	CreatedBy    *string         `json:"-"`
}

// NewReport is what POST /api/reports stores.
type NewReport struct {
	WorkspaceID, CreatedBy, Template, Format, Title string
	Instructions                                    *string
	CollectionIDs, DocumentIDs                      []string
}

const reportColumns = `r.id::text, r.title, r.template, r.format, r.status, r.progress, r.created_at, r.completed_at, u.email`

// nonEmpty is the TypeScript `value ? String(value) : null`.
func nonEmpty(value *string) *string {
	if value == nil || *value == "" {
		return nil
	}
	return value
}

func isoOrNil(t *time.Time) *string {
	if t == nil {
		return nil
	}
	value := IsoTime(*t)
	return &value
}

// jsonOrNull is asJsonObject for a jsonb column: the stored JSON, or null.
func jsonOrNull(raw []byte) json.RawMessage {
	if trimmed := strings.TrimSpace(string(raw)); trimmed != "" && json.Valid(raw) {
		return json.RawMessage(trimmed)
	}
	return json.RawMessage("null")
}

func reportSummaryTargets(r *ReportSummary, created *time.Time, completed **time.Time) []any {
	return []any{&r.ID, &r.Title, &r.Template, &r.Format, &r.Status, &r.Progress, created, completed, &r.CreatedByEmail}
}

func (r *ReportSummary) finish(created time.Time, completed *time.Time) {
	if r.Format != "json" {
		r.Format = "markdown"
	}
	r.Progress, r.CreatedByEmail = nonEmpty(r.Progress), nonEmpty(r.CreatedByEmail)
	r.CreatedAt, r.CompletedAt = IsoTime(created), isoOrNil(completed)
}

func (s *Store) CreateReport(ctx context.Context, input NewReport) (*ReportSummary, error) {
	var r ReportSummary
	var created time.Time
	var completed *time.Time
	err := s.pool.QueryRow(ctx, `WITH r AS (
			INSERT INTO app.reports (workspace_id, created_by, template, format, title, instructions, collection_ids, document_ids)
			VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8::uuid[])
			RETURNING *
		)
		SELECT `+reportColumns+` FROM r LEFT JOIN app.users u ON u.id = r.created_by`,
		input.WorkspaceID, input.CreatedBy, input.Template, input.Format, input.Title, input.Instructions, ids(input.CollectionIDs), ids(input.DocumentIDs),
	).Scan(reportSummaryTargets(&r, &created, &completed)...)
	if err != nil {
		return nil, err
	}
	r.finish(created, completed)
	return &r, nil
}

// ListReports: newest first.
func (s *Store) ListReports(ctx context.Context, workspaceID string, limit int) ([]ReportSummary, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+reportColumns+` FROM app.reports r LEFT JOIN app.users u ON u.id = r.created_by
		WHERE r.workspace_id = $1 ORDER BY r.created_at DESC LIMIT $2`, workspaceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []ReportSummary{}
	for rows.Next() {
		var r ReportSummary
		var created time.Time
		var completed *time.Time
		if err := rows.Scan(reportSummaryTargets(&r, &created, &completed)...); err != nil {
			return nil, err
		}
		r.finish(created, completed)
		list = append(list, r)
	}
	return list, rows.Err()
}

// GetReport: nil when the report is not in the workspace.
func (s *Store) GetReport(ctx context.Context, workspaceID, id string) (*ReportDetail, error) {
	var r ReportDetail
	var created time.Time
	var completed *time.Time
	var output, sources []byte
	targets := append(reportSummaryTargets(&r.ReportSummary, &created, &completed), &r.Instructions, &r.Content, &output, &sources, &r.Error, &r.CreatedBy)
	err := s.pool.QueryRow(ctx, `SELECT `+reportColumns+`, r.instructions, r.content, r.output, r.sources, r.error, r.created_by::text
		FROM app.reports r LEFT JOIN app.users u ON u.id = r.created_by
		WHERE r.id = $1 AND r.workspace_id = $2`, id, workspaceID).Scan(targets...)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidID(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.finish(created, completed)
	r.Instructions, r.Content, r.Error, r.CreatedBy = nonEmpty(r.Instructions), nonEmpty(r.Content), nonEmpty(r.Error), nonEmpty(r.CreatedBy)
	r.Output, r.Sources = jsonOrNull(output), jsonArray(sources)
	return &r, nil
}

func (s *Store) DeleteReport(ctx context.Context, workspaceID, id string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM app.reports WHERE id = $1 AND workspace_id = $2`, id, workspaceID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// SelectedDocument is an indexed document a studio selection resolves to.
type SelectedDocument struct {
	ID, CollectionID string
}

// ReadyDocuments is resolveReportDocuments: the indexed documents of the notebooks plus the
// documents picked one by one, newest first, at most limit.
func (s *Store) ReadyDocuments(ctx context.Context, workspaceID string, collectionIDs, documentIDs []string, limit int) ([]SelectedDocument, error) {
	rows, err := s.pool.Query(ctx, `SELECT id::text, collection_id::text FROM app.documents
		WHERE workspace_id = $1 AND status = 'ready'
		  AND (collection_id = ANY($2::uuid[]) OR id = ANY($3::uuid[]))
		ORDER BY created_at DESC
		LIMIT $4`, workspaceID, ids(collectionIDs), ids(documentIDs), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []SelectedDocument{}
	for rows.Next() {
		var document SelectedDocument
		if err := rows.Scan(&document.ID, &document.CollectionID); err != nil {
			return nil, err
		}
		list = append(list, document)
	}
	return list, rows.Err()
}

// ids never passes a nil slice, which pgx would send as NULL instead of an empty array.
func ids(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}

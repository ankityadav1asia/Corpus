package api

import (
	"context"
	"fmt"
	"strings"

	"github.com/ankityadav1asia/Corpus/backend/apperr"
	"github.com/ankityadav1asia/Corpus/backend/auth"
	"github.com/ankityadav1asia/Corpus/backend/httpx"
	"github.com/ankityadav1asia/Corpus/backend/jsstr"
	"github.com/ankityadav1asia/Corpus/backend/store"
)

// Group 4b: the studio's reports. The TypeScript original is app/api/reports. These routes queue the
// work; the TypeScript job runner writes the report, started by the browser through
// POST /api/jobs/nudge while it polls (hooks/use-api.ts).

// StudioStore is what these routes need from the database (implemented by *store.Store).
type StudioStore interface {
	ReadyDocuments(ctx context.Context, workspaceID string, collectionIDs, documentIDs []string, limit int) ([]store.SelectedDocument, error)
	CreateReport(ctx context.Context, input store.NewReport) (*store.ReportSummary, error)
	ListReports(ctx context.Context, workspaceID string, limit int) ([]store.ReportSummary, error)
	GetReport(ctx context.Context, workspaceID, id string) (*store.ReportDetail, error)
	DeleteReport(ctx context.Context, workspaceID, id string) (bool, error)
}

// Limits from lib/constants.ts, lib/contracts/studio.ts, server/security/rate-limit.ts and
// server/repositories/jobs.ts.
const (
	studioBodyLimit         = 16 * 1024
	reportTitleChars        = 200
	reportInstructionsChars = 2000
	reportCollectionsMax    = 20
	reportDocumentsMax      = 50
	documentsPerReport      = 12
	reportsListed           = 50
	reportsPerHour          = 10
	reportAttempts          = 4
	noSourcesMessage        = "Select at least one notebook or document"
)

// templateLabels is TEMPLATE_LABELS (server/reports/generate.ts), in REPORT_TEMPLATES order.
var templateLabels = []struct{ key, label string }{
	{"executive_summary", "Executive summary"},
	{"comparison_table", "Comparison table"},
	{"slide_outline", "Slide outline"},
}

func templateLabel(template string) string {
	for _, entry := range templateLabels {
		if entry.key == template {
			return entry.label
		}
	}
	return ""
}

func (s *Server) studioOnly(run handler) handler {
	return func(req *request) error {
		if s.studio == nil || s.admin == nil || s.asking == nil {
			return apperr.NotConfigured("Server is missing required configuration: POSTGRES_URL")
		}
		return run(req)
	}
}

// ── Request validation ───────────────────────────────────────────────────

func enumIssue(name string, options []string) *apperr.Issue {
	return &apperr.Issue{Path: name, Message: `Invalid option: expected one of "` + strings.Join(options, `"|"`) + `"`}
}

// enumField is z.enum(options), with fallback as its .default() when the field is absent.
func enumField(object map[string]any, name string, options []string, fallback string) (string, *apperr.Issue) {
	raw, present := object[name]
	if !present && fallback != "" {
		return fallback, nil
	}
	text, _ := raw.(string)
	for _, option := range options {
		if text == option {
			return text, nil
		}
	}
	return "", enumIssue(name, options)
}

// optionalText is z.string().trim().max(max).optional(): nil when absent, possibly empty.
func optionalText(object map[string]any, name string, max int) (*string, *apperr.Issue) {
	raw, present := object[name]
	if !present {
		return nil, nil
	}
	text, ok := raw.(string)
	if !ok {
		return nil, &apperr.Issue{Path: name, Message: "Invalid input: expected string, received " + jsonType(raw)}
	}
	text = jsstr.Trim(text)
	if jsstr.Len(text) > max {
		return nil, &apperr.Issue{Path: name, Message: fmt.Sprintf("Too big: expected string to have <=%d characters", max)}
	}
	return &text, nil
}

// idList is z.array(z.guid()).max(max).default([]).
func idList(object map[string]any, name string, max int) ([]string, []apperr.Issue) {
	raw, present := object[name]
	if !present {
		return []string{}, nil
	}
	list, ok := raw.([]any)
	if !ok {
		return nil, []apperr.Issue{{Path: name, Message: "Invalid input: expected array, received " + jsonType(raw)}}
	}
	var issues []apperr.Issue
	result := []string{}
	for i, item := range list {
		text, isString := item.(string)
		switch {
		case !isString:
			issues = append(issues, apperr.Issue{Path: fmt.Sprintf("%s.%d", name, i), Message: "Invalid input: expected string, received " + jsonType(item)})
		case !httpx.IsID(text):
			issues = append(issues, apperr.Issue{Path: fmt.Sprintf("%s.%d", name, i), Message: "Invalid GUID"})
		default:
			result = append(result, text)
		}
	}
	if len(list) > max {
		issues = append(issues, apperr.Issue{Path: name, Message: fmt.Sprintf("Too big: expected array to have <=%d items", max)})
	}
	return result, issues
}

func readStudioBody(req *request) (map[string]any, error) {
	body, err := httpx.ReadJSON(req.r, studioBodyLimit)
	if err != nil {
		return nil, err
	}
	return httpx.Object(body)
}

// selection collects the notebooks and documents of a studio request; the "at least one" check
// runs only when every field is valid, as zod's refine does.
type selection struct {
	collectionIDs, documentIDs []string
}

func (sel selection) check(issues []apperr.Issue) error {
	if len(issues) > 0 {
		return apperr.Validation(issues)
	}
	if len(sel.collectionIDs)+len(sel.documentIDs) == 0 {
		return apperr.Validation([]apperr.Issue{{Path: "", Message: noSourcesMessage}})
	}
	return nil
}

// notebook is collectionAccess: the notebook must exist in the workspace (404 otherwise).
func (s *Server) notebook(ctx context.Context, access *auth.Access, collectionID string) (*store.CollectionRef, error) {
	ref, err := s.admin.Collection(ctx, access.WorkspaceID, collectionID, access.UserID)
	if err != nil {
		return nil, err
	}
	if ref == nil {
		return nil, apperr.NotFound("Notebook")
	}
	return ref, nil
}

// ── /api/reports ─────────────────────────────────────────────────────────

func (s *Server) listReports(req *request) error {
	reports, err := s.studio.ListReports(req.r.Context(), req.access.WorkspaceID, reportsListed)
	if err != nil {
		return err
	}
	return req.json(200, map[string]any{"reports": reports})
}

// createReport queues a multi-document synthesis (any member: it only reads content they can
// already see) and answers 202; the report is written in the background.
func (s *Server) createReport(req *request) error {
	if err := auth.RequireWorkspacePermission(req.access, auth.ReportsCreate); err != nil {
		return err
	}
	object, err := readStudioBody(req)
	if err != nil {
		return err
	}
	var issues []apperr.Issue
	options := make([]string, len(templateLabels))
	for i, entry := range templateLabels {
		options[i] = entry.key
	}
	template, issue := enumField(object, "template", options, "")
	if issue != nil {
		issues = append(issues, *issue)
	}
	title, issue := optionalText(object, "title", reportTitleChars)
	if issue != nil {
		issues = append(issues, *issue)
	}
	var sel selection
	var listIssues []apperr.Issue
	sel.collectionIDs, listIssues = idList(object, "collectionIds", reportCollectionsMax)
	issues = append(issues, listIssues...)
	sel.documentIDs, listIssues = idList(object, "documentIds", reportDocumentsMax)
	issues = append(issues, listIssues...)
	instructions, issue := optionalText(object, "instructions", reportInstructionsChars)
	if issue != nil {
		issues = append(issues, *issue)
	}
	format, issue := enumField(object, "format", []string{"markdown", "json"}, "markdown")
	if issue != nil {
		issues = append(issues, *issue)
	}
	if err := sel.check(issues); err != nil {
		return err
	}

	ctx := req.r.Context()
	if _, _, err := models(); err != nil { // 503 when AI is not configured
		return err
	}
	if err := s.rateLimit(ctx, "reports:user:"+req.access.UserID, reportsPerHour, 3600); err != nil {
		return err
	}
	for _, id := range sel.collectionIDs {
		if _, err := s.notebook(ctx, req.access, id); err != nil {
			return err
		}
	}
	documents, err := s.studio.ReadyDocuments(ctx, req.access.WorkspaceID, sel.collectionIDs, sel.documentIDs, documentsPerReport)
	if err != nil {
		return err
	}
	if len(documents) == 0 {
		return apperr.BadRequest("The selection has no indexed documents yet.")
	}
	if template != "slide_outline" {
		format = "markdown"
	}
	reportTitle := ""
	if title != nil {
		reportTitle = *title
	}
	if reportTitle == "" {
		plural := "s"
		if len(documents) == 1 {
			plural = ""
		}
		reportTitle = fmt.Sprintf("%s — %d document%s", templateLabel(template), len(documents), plural)
	}
	report, err := s.studio.CreateReport(ctx, store.NewReport{
		WorkspaceID: req.access.WorkspaceID, CreatedBy: req.access.UserID, Template: template, Format: format, Title: reportTitle,
		Instructions: instructions, CollectionIDs: sel.collectionIDs, DocumentIDs: sel.documentIDs,
	})
	if err != nil {
		return err
	}
	if err := s.asking.EnqueueJob(ctx, "generate_report", map[string]any{"reportId": report.ID}, reportAttempts); err != nil {
		return err
	}
	s.audit(ctx, req.access, "report.created", "report", report.ID, map[string]any{"title": report.Title, "template": report.Template})
	return req.json(202, map[string]any{"report": report})
}

func (s *Server) reportDetail(req *request) error {
	id, err := pathID(req.r.PathValue("id"))
	if err != nil {
		return err
	}
	report, err := s.studio.GetReport(req.r.Context(), req.access.WorkspaceID, id)
	if err != nil {
		return err
	}
	if report == nil {
		return apperr.NotFound("Report")
	}
	return req.json(200, map[string]any{"report": report})
}

// deleteStudioItem: its creator or a workspace admin deletes it.
func (s *Server) deleteStudioItem(req *request, noun, auditType, id string, title string, createdBy *string, remove func() (bool, error)) error {
	if createdBy == nil || *createdBy != req.access.UserID {
		if req.access.Role != auth.Admin {
			return apperr.Forbidden("Only its creator or a workspace admin can delete this " + strings.ToLower(noun) + ".")
		}
	}
	if _, err := remove(); err != nil {
		return err
	}
	s.audit(req.r.Context(), req.access, auditType+".deleted", auditType, id, map[string]any{"title": title})
	return req.json(200, map[string]any{"ok": true})
}

func (s *Server) deleteReport(req *request) error {
	id, err := pathID(req.r.PathValue("id"))
	if err != nil {
		return err
	}
	ctx := req.r.Context()
	report, err := s.studio.GetReport(ctx, req.access.WorkspaceID, id)
	if err != nil {
		return err
	}
	if report == nil {
		return apperr.NotFound("Report")
	}
	return s.deleteStudioItem(req, "Report", "report", id, report.Title, report.CreatedBy, func() (bool, error) {
		return s.studio.DeleteReport(ctx, req.access.WorkspaceID, id)
	})
}

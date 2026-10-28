package api

import (
	"context"
	"strconv"
	"time"

	"github.com/ankityadav1asia/Corpus/backend/ai"
	"github.com/ankityadav1asia/Corpus/backend/apperr"
	"github.com/ankityadav1asia/Corpus/backend/auth"
	"github.com/ankityadav1asia/Corpus/backend/logx"
	"github.com/ankityadav1asia/Corpus/backend/store"
)

// Workspace usage: AI tokens metered per call (backend/ai/usage.go, server/ai/usage.ts), questions,
// storage and studio items, for workspace admins (GET /api/usage).

// UsageStore is what metering and the dashboard need from the database.
type UsageStore interface {
	RecordUsage(ctx context.Context, row store.UsageRow) error
	UsageSummary(ctx context.Context, workspaceID string, days int, now time.Time) (*store.UsageSummary, error)
}

const (
	usageDaysDefault = 30
	usageDaysMax     = 365
)

// meterInto stores the model calls of this process; a failed insert is logged, never returned.
func meterInto(usage UsageStore) {
	ai.Recorder = func(ctx context.Context, u ai.Usage) {
		// The answer may already be streamed and the client gone: store the row anyway.
		background, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		row := store.UsageRow{WorkspaceID: u.WorkspaceID, UserID: u.UserID, Feature: u.Feature, Model: u.Model, Kind: u.Kind, InputTokens: u.InputTokens, OutputTokens: u.OutputTokens, Estimated: u.Estimated}
		if err := usage.RecordUsage(background, row); err != nil {
			logx.Warn("Could not record AI usage", logx.Fields{"feature": u.Feature, "error": err.Error()})
		}
	}
}

// metered attributes the model calls made with ctx to the caller's workspace.
func metered(ctx context.Context, access *auth.Access, feature string) context.Context {
	return ai.WithScope(ctx, ai.Scope{WorkspaceID: access.WorkspaceID, UserID: access.UserID, Feature: feature})
}

// usageSummary: ?days=1…365 (30 by default), workspace admins only.
func (s *Server) usageSummary(req *request) error {
	if err := auth.RequireWorkspacePermission(req.access, auth.AnalyticsWorkspace); err != nil {
		return err
	}
	if s.usage == nil {
		return apperr.NotConfigured("Server is missing required configuration: POSTGRES_URL")
	}
	days := usageDaysDefault
	if raw := req.r.URL.Query().Get("days"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > usageDaysMax {
			return apperr.Validation([]apperr.Issue{{Path: "days", Message: "Enter a whole number of days from 1 to 365"}})
		}
		days = parsed
	}
	summary, err := s.usage.UsageSummary(req.r.Context(), req.access.WorkspaceID, days, time.Now())
	if err != nil {
		return err
	}
	return req.json(200, summary)
}

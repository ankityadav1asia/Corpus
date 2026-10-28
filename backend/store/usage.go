package store

import (
	"context"
	"time"
)

// AI usage (app.ai_usage) and the workspace usage summary behind GET /api/usage.

// UsageRow is one model call to store.
type UsageRow struct {
	WorkspaceID, UserID, Feature, Model, Kind string
	InputTokens, OutputTokens                 int
	Estimated                                 bool
}

// RecordUsage stores one model call.
func (s *Store) RecordUsage(ctx context.Context, row UsageRow) error {
	var user *string
	if row.UserID != "" {
		user = &row.UserID
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO app.ai_usage (workspace_id, user_id, feature, model, kind, input_tokens, output_tokens, estimated)
		VALUES ($1, $2, left($3, 60), left($4, 120), $5, $6, $7, $8)`,
		row.WorkspaceID, user, row.Feature, row.Model, row.Kind, row.InputTokens, row.OutputTokens, row.Estimated)
	return err
}

// TokenCount is calls and tokens of one group.
type TokenCount struct {
	Calls          int `json:"calls"`
	InputTokens    int `json:"inputTokens"`
	OutputTokens   int `json:"outputTokens"`
	EstimatedCalls int `json:"estimatedCalls"`
}

type UsageDay struct {
	Date         string `json:"date"`
	InputTokens  int    `json:"inputTokens"`
	OutputTokens int    `json:"outputTokens"`
	Questions    int    `json:"questions"`
}

type FeatureUsage struct {
	Feature string `json:"feature"`
	TokenCount
}

type ModelUsage struct {
	Model string `json:"model"`
	Kind  string `json:"kind"`
	TokenCount
}

type MemberUsage struct {
	UserID *string `json:"userId"`
	Email  *string `json:"email"`
	TokenCount
}

// UsageSummary is a workspace's usage over the last Days days (today included).
type UsageSummary struct {
	Days   int `json:"days"`
	Totals struct {
		TokenCount
		Questions     int `json:"questions"`
		FailedAnswers int `json:"failedAnswers"`
		ActiveMembers int `json:"activeMembers"`
	} `json:"totals"`
	Daily     []UsageDay     `json:"daily"`
	ByFeature []FeatureUsage `json:"byFeature"`
	ByModel   []ModelUsage   `json:"byModel"`
	ByMember  []MemberUsage  `json:"byMember"`
	Storage   struct {
		Notebooks int   `json:"notebooks"`
		Documents int   `json:"documents"`
		Chunks    int   `json:"chunks"`
		Bytes     int64 `json:"bytes"`
	} `json:"storage"`
	Studio struct {
		Reports int `json:"reports"`
	} `json:"studio"`
}

const usageCounts = `count(*)::int, coalesce(sum(input_tokens), 0)::bigint, coalesce(sum(output_tokens), 0)::bigint, count(*) FILTER (WHERE estimated)::int`

func (s *Store) groups(ctx context.Context, sql string, args []any, scan func(scan func(dest ...any) error) error) error {
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := scan(rows.Scan); err != nil {
			return err
		}
	}
	return rows.Err()
}

// UsageSummary: days counts back from today (UTC), e.g. 30 → today and the 29 days before.
func (s *Store) UsageSummary(ctx context.Context, workspaceID string, days int, now time.Time) (*UsageSummary, error) {
	today := now.UTC().Truncate(24 * time.Hour)
	since := today.AddDate(0, 0, -(days - 1))
	window := []any{workspaceID, since}
	summary := &UsageSummary{Days: days, Daily: make([]UsageDay, days), ByFeature: []FeatureUsage{}, ByModel: []ModelUsage{}, ByMember: []MemberUsage{}}
	index := map[string]int{}
	for i := range summary.Daily {
		date := since.AddDate(0, 0, i).Format("2006-01-02")
		summary.Daily[i].Date, index[date] = date, i
	}
	t := &summary.Totals
	err := s.pool.QueryRow(ctx, `SELECT `+usageCounts+`, count(DISTINCT user_id)::int FROM app.ai_usage WHERE workspace_id = $1 AND created_at >= $2`, window...).
		Scan(&t.Calls, &t.InputTokens, &t.OutputTokens, &t.EstimatedCalls, &t.ActiveMembers)
	if err != nil {
		return nil, err
	}
	err = s.pool.QueryRow(ctx, `SELECT count(*)::int, count(*) FILTER (WHERE status = 'error')::int FROM app.query_logs WHERE workspace_id = $1 AND created_at >= $2`, window...).
		Scan(&t.Questions, &t.FailedAnswers)
	if err != nil {
		return nil, err
	}
	err = s.groups(ctx, `SELECT to_char(day, 'YYYY-MM-DD'), sum(input)::bigint, sum(output)::bigint, sum(questions)::int FROM (
			SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day, input_tokens AS input, output_tokens AS output, 0 AS questions
			FROM app.ai_usage WHERE workspace_id = $1 AND created_at >= $2
			UNION ALL
			SELECT date_trunc('day', created_at AT TIME ZONE 'UTC'), 0, 0, 1 FROM app.query_logs WHERE workspace_id = $1 AND created_at >= $2
		) d GROUP BY day`, window, func(scan func(...any) error) error {
		var date string
		var day UsageDay
		if err := scan(&date, &day.InputTokens, &day.OutputTokens, &day.Questions); err != nil {
			return err
		}
		if i, ok := index[date]; ok {
			day.Date = date
			summary.Daily[i] = day
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = s.groups(ctx, `SELECT feature, `+usageCounts+` FROM app.ai_usage WHERE workspace_id = $1 AND created_at >= $2
		GROUP BY feature ORDER BY sum(input_tokens + output_tokens) DESC, feature`, window, func(scan func(...any) error) error {
		var f FeatureUsage
		if err := scan(&f.Feature, &f.Calls, &f.InputTokens, &f.OutputTokens, &f.EstimatedCalls); err != nil {
			return err
		}
		summary.ByFeature = append(summary.ByFeature, f)
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = s.groups(ctx, `SELECT model, kind, `+usageCounts+` FROM app.ai_usage WHERE workspace_id = $1 AND created_at >= $2
		GROUP BY model, kind ORDER BY sum(input_tokens + output_tokens) DESC, model`, window, func(scan func(...any) error) error {
		var m ModelUsage
		if err := scan(&m.Model, &m.Kind, &m.Calls, &m.InputTokens, &m.OutputTokens, &m.EstimatedCalls); err != nil {
			return err
		}
		summary.ByModel = append(summary.ByModel, m)
		return nil
	})
	if err != nil {
		return nil, err
	}
	// The ten members who used the most; calls of members since removed show without an email.
	err = s.groups(ctx, `SELECT a.user_id::text, u.email, count(*)::int, coalesce(sum(a.input_tokens), 0)::bigint, coalesce(sum(a.output_tokens), 0)::bigint, count(*) FILTER (WHERE a.estimated)::int
		FROM app.ai_usage a LEFT JOIN app.users u ON u.id = a.user_id
		WHERE a.workspace_id = $1 AND a.created_at >= $2
		GROUP BY a.user_id, u.email ORDER BY sum(a.input_tokens + a.output_tokens) DESC, u.email LIMIT 10`, window, func(scan func(...any) error) error {
		var m MemberUsage
		if err := scan(&m.UserID, &m.Email, &m.Calls, &m.InputTokens, &m.OutputTokens, &m.EstimatedCalls); err != nil {
			return err
		}
		summary.ByMember = append(summary.ByMember, m)
		return nil
	})
	if err != nil {
		return nil, err
	}
	st := &summary.Storage
	err = s.pool.QueryRow(ctx, `SELECT (SELECT count(*)::int FROM app.collections WHERE workspace_id = $1),
		  count(*)::int, coalesce(sum(chunk_count), 0)::bigint, coalesce(sum(byte_size), 0)::bigint
		FROM app.documents WHERE workspace_id = $1`, workspaceID).Scan(&st.Notebooks, &st.Documents, &st.Chunks, &st.Bytes)
	if err != nil {
		return nil, err
	}
	studio := &summary.Studio
	err = s.pool.QueryRow(ctx, `SELECT count(*)::int FROM app.reports WHERE workspace_id = $1`, workspaceID).Scan(&studio.Reports)
	if err != nil {
		return nil, err
	}
	return summary, nil
}

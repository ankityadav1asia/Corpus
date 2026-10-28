package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Conversations, messages, answer feedback, notifications and usage analytics (group 3). The SQL
// is server/repositories/{conversations,feedback,notifications,analytics}.ts. Conversations are
// private to their author inside a workspace: every query checks both.

// Conversation is a conversation summary as the API returns it.
type Conversation struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	CollectionID *string `json:"collectionId"`
	ParentID     *string `json:"parentId"`
	Pinned       bool    `json:"pinned"`
	CreatedAt    string  `json:"createdAt"`
	UpdatedAt    string  `json:"updatedAt"`
}

const conversationColumns = `id::text, title, collection_id::text, parent_id::text, pinned_at, created_at, updated_at`

func scanConversation(row pgx.Row) (Conversation, error) {
	var c Conversation
	var pinned *time.Time
	var created, updated time.Time
	if err := row.Scan(&c.ID, &c.Title, &c.CollectionID, &c.ParentID, &pinned, &created, &updated); err != nil {
		return c, err
	}
	c.Pinned, c.CreatedAt, c.UpdatedAt = pinned != nil, IsoTime(created), IsoTime(updated)
	return c, nil
}

func (s *Store) conversations(ctx context.Context, sql string, args ...any) ([]Conversation, error) {
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Conversation{}
	for rows.Next() {
		c, err := scanConversation(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, c)
	}
	return list, rows.Err()
}

// one runs a statement returning at most one conversation; nil when there is none.
func (s *Store) one(ctx context.Context, sql string, args ...any) (*Conversation, error) {
	c, err := scanConversation(s.pool.QueryRow(ctx, sql, args...))
	if errors.Is(err, pgx.ErrNoRows) || isInvalidID(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// ListConversations: pinned first, then the most recently active.
func (s *Store) ListConversations(ctx context.Context, workspaceID, ownerID string, limit int) ([]Conversation, error) {
	return s.conversations(ctx, `SELECT `+conversationColumns+` FROM app.conversations WHERE workspace_id = $1 AND owner_id = $2
		ORDER BY pinned_at DESC NULLS LAST, updated_at DESC LIMIT $3`, workspaceID, ownerID, limit)
}

// escapeLike makes a search term literal inside ILIKE … ESCAPE '\'.
func escapeLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}

// SearchConversations: the author's conversations whose title or any message contains query
// literally, newest first.
func (s *Store) SearchConversations(ctx context.Context, workspaceID, ownerID, query string, limit int) ([]Conversation, error) {
	return s.conversations(ctx, `SELECT `+conversationColumns+` FROM app.conversations c
		WHERE c.workspace_id = $1 AND c.owner_id = $2
		  AND (c.title ILIKE $3 ESCAPE '\'
		       OR EXISTS (SELECT 1 FROM app.messages m WHERE m.conversation_id = c.id AND m.content ILIKE $3 ESCAPE '\'))
		ORDER BY c.updated_at DESC LIMIT $4`, workspaceID, ownerID, "%"+escapeLike(query)+"%", limit)
}

func (s *Store) GetConversation(ctx context.Context, workspaceID, ownerID, id string) (*Conversation, error) {
	return s.one(ctx, `SELECT `+conversationColumns+` FROM app.conversations WHERE id = $1 AND workspace_id = $2 AND owner_id = $3`, id, workspaceID, ownerID)
}

func (s *Store) RenameConversation(ctx context.Context, workspaceID, ownerID, id, title string) (*Conversation, error) {
	return s.one(ctx, `UPDATE app.conversations SET title = $4, updated_at = now()
		WHERE id = $1 AND workspace_id = $2 AND owner_id = $3 RETURNING `+conversationColumns, id, workspaceID, ownerID, title)
}

func (s *Store) PinConversation(ctx context.Context, workspaceID, ownerID, id string, pinned bool) (*Conversation, error) {
	return s.one(ctx, `UPDATE app.conversations SET pinned_at = CASE WHEN $4 THEN coalesce(pinned_at, now()) ELSE NULL END
		WHERE id = $1 AND workspace_id = $2 AND owner_id = $3 RETURNING `+conversationColumns, id, workspaceID, ownerID, pinned)
}

func (s *Store) DeleteConversation(ctx context.Context, workspaceID, ownerID, id string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM app.conversations WHERE id = $1 AND workspace_id = $2 AND owner_id = $3`, id, workspaceID, ownerID)
	if isInvalidID(err) {
		return false, nil
	}
	return tag.RowsAffected() > 0, err
}

// BranchConversation copies the thread up to and including messageId into a new conversation;
// "" when the conversation or message is not the author's.
func (s *Store) BranchConversation(ctx context.Context, workspaceID, ownerID, conversationID, messageID string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `WITH source_conversation AS (
		   SELECT id, collection_id, title FROM app.conversations WHERE id = $1 AND workspace_id = $4 AND owner_id = $2
		 ),
		 pivot AS (
		   SELECT m.seq FROM app.messages m JOIN source_conversation s ON s.id = m.conversation_id WHERE m.id = $3
		 ),
		 new_conversation AS (
		   INSERT INTO app.conversations (workspace_id, owner_id, collection_id, parent_id, title)
		   SELECT $4, $2, s.collection_id, s.id, left('↳ ' || s.title, 200)
		   FROM source_conversation s
		   WHERE EXISTS (SELECT 1 FROM pivot)
		   RETURNING id
		 ),
		 copied AS (
		   INSERT INTO app.messages (conversation_id, role, content, citations, steps, created_at)
		   SELECT n.id, m.role, m.content, m.citations, m.steps, m.created_at
		   FROM app.messages m, new_conversation n, pivot p
		   WHERE m.conversation_id = $1 AND m.seq <= p.seq
		   ORDER BY m.seq
		 )
		 SELECT id::text FROM new_conversation`, conversationID, ownerID, messageID, workspaceID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidID(err) {
		return "", nil
	}
	return id, err
}

// Evaluation holds an answer's background quality scores.
type Evaluation struct {
	Faithfulness     *float64 `json:"faithfulness"`
	AnswerRelevance  *float64 `json:"answerRelevance"`
	ContextPrecision *float64 `json:"contextPrecision"`
	ContextRecall    *float64 `json:"contextRecall"`
}

// Feedback is the viewer's own rating of an answer.
type Feedback struct {
	Rating  int     `json:"rating"`
	Comment *string `json:"comment"`
}

// Message is a chat message as the API returns it. Citations and steps are stored JSON, passed
// through as they are.
type Message struct {
	ID         string          `json:"id"`
	Role       string          `json:"role"`
	Content    string          `json:"content"`
	Citations  json.RawMessage `json:"citations"`
	Steps      json.RawMessage `json:"steps"`
	CreatedAt  string          `json:"createdAt"`
	Evaluation *Evaluation     `json:"evaluation"`
	Feedback   *Feedback       `json:"feedback"`
	Followups  []string        `json:"followups"`
}

// jsonArray is asJsonArray: a stored JSON array, or [] for anything else.
func jsonArray(raw []byte) json.RawMessage {
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, "[") && json.Valid(raw) {
		return json.RawMessage(trimmed)
	}
	return json.RawMessage("[]")
}

// Messages of a conversation the caller has verified, with quality scores and viewerID's ratings.
func (s *Store) Messages(ctx context.Context, conversationID, viewerID string) ([]Message, error) {
	rows, err := s.pool.Query(ctx, `SELECT m.id::text, m.role, m.content, m.citations, m.steps, m.created_at, m.followups,
		       e.id IS NOT NULL, e.faithfulness::float8, e.answer_relevance::float8, e.context_precision::float8, e.context_recall::float8,
		       f.rating, f.comment
		FROM app.messages m
		LEFT JOIN app.evaluations e ON e.message_id = m.id
		LEFT JOIN app.message_feedback f ON f.message_id = m.id AND f.user_id = $2
		WHERE m.conversation_id = $1
		ORDER BY m.seq`, conversationID, viewerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Message{}
	for rows.Next() {
		var m Message
		var citations, steps, followups []byte
		var created time.Time
		var evaluated bool
		var scores Evaluation
		var rating *int
		var comment *string
		if err := rows.Scan(&m.ID, &m.Role, &m.Content, &citations, &steps, &created, &followups,
			&evaluated, &scores.Faithfulness, &scores.AnswerRelevance, &scores.ContextPrecision, &scores.ContextRecall,
			&rating, &comment); err != nil {
			return nil, err
		}
		if m.Role != "assistant" {
			m.Role = "user"
		}
		m.Citations, m.Steps, m.CreatedAt = jsonArray(citations), jsonArray(steps), IsoTime(created)
		if evaluated {
			m.Evaluation = &scores
		}
		if rating != nil {
			value := -1
			if *rating == 1 {
				value = 1
			}
			if comment != nil && *comment == "" {
				comment = nil
			}
			m.Feedback = &Feedback{Rating: value, Comment: comment}
		}
		var items []any
		if len(followups) > 0 && json.Unmarshal(followups, &items) == nil && items != nil {
			m.Followups = []string{}
			for _, item := range items {
				if text, ok := item.(string); ok {
					m.Followups = append(m.Followups, text)
				}
			}
		}
		list = append(list, m)
	}
	return list, rows.Err()
}

// MessageContext says who may rate a message: its conversation's author, inside that workspace.
type MessageContext struct {
	WorkspaceID string
	OwnerID     string
	Role        string
}

func (s *Store) MessageContext(ctx context.Context, messageID string) (*MessageContext, error) {
	var mc MessageContext
	err := s.pool.QueryRow(ctx, `SELECT c.workspace_id::text, c.owner_id::text, m.role
		FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id WHERE m.id = $1`, messageID).Scan(&mc.WorkspaceID, &mc.OwnerID, &mc.Role)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidID(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &mc, nil
}

func (s *Store) SetFeedback(ctx context.Context, messageID, userID, workspaceID string, rating int, comment *string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO app.message_feedback (message_id, user_id, workspace_id, rating, comment)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (message_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()`,
		messageID, userID, workspaceID, rating, comment)
	return err
}

func (s *Store) RemoveFeedback(ctx context.Context, messageID, userID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM app.message_feedback WHERE message_id = $1 AND user_id = $2`, messageID, userID)
	return err
}

// NotificationItem is a notification as the API returns it.
type NotificationItem struct {
	ID            string          `json:"id"`
	Kind          string          `json:"kind"`
	Title         string          `json:"title"`
	Body          *string         `json:"body"`
	Link          json.RawMessage `json:"link"`
	WorkspaceID   *string         `json:"workspaceId"`
	WorkspaceName *string         `json:"workspaceName"`
	ReadAt        *string         `json:"readAt"`
	CreatedAt     string          `json:"createdAt"`
}

// Notifications from a workspace the person has since left are hidden.
const visibleNotification = `(n.workspace_id IS NULL OR EXISTS (SELECT 1 FROM app.workspace_members m WHERE m.workspace_id = n.workspace_id AND m.user_id = n.user_id))`

// Notifications: the latest across the caller's workspaces, and the unread count.
func (s *Store) Notifications(ctx context.Context, userID string, limit int) ([]NotificationItem, int, error) {
	var unread int
	if err := s.pool.QueryRow(ctx, `SELECT count(*)::int FROM app.notifications n WHERE n.user_id = $1 AND n.read_at IS NULL AND `+visibleNotification, userID).Scan(&unread); err != nil {
		return nil, 0, err
	}
	rows, err := s.pool.Query(ctx, `SELECT n.id::text, n.kind, n.title, n.body, n.link, n.workspace_id::text, w.name, n.read_at, n.created_at
		FROM app.notifications n LEFT JOIN app.workspaces w ON w.id = n.workspace_id
		WHERE n.user_id = $1 AND `+visibleNotification+`
		ORDER BY n.created_at DESC
		LIMIT $2`, userID, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []NotificationItem{}
	for rows.Next() {
		var item NotificationItem
		var link []byte
		var read *time.Time
		var created time.Time
		if err := rows.Scan(&item.ID, &item.Kind, &item.Title, &item.Body, &link, &item.WorkspaceID, &item.WorkspaceName, &read, &created); err != nil {
			return nil, 0, err
		}
		item.Link = asLink(link)
		if read != nil {
			readAt := IsoTime(*read)
			item.ReadAt = &readAt
		}
		item.CreatedAt = IsoTime(created)
		items = append(items, item)
	}
	return items, unread, rows.Err()
}

// asLink keeps a stored link only when it is a JSON object with a tab.
func asLink(raw []byte) json.RawMessage {
	var link map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &link) != nil || link == nil {
		return json.RawMessage("null")
	}
	if _, ok := link["tab"]; !ok {
		return json.RawMessage("null")
	}
	return json.RawMessage(raw)
}

// MarkNotificationsRead marks ids (or every notification when all) as read; returns how many.
func (s *Store) MarkNotificationsRead(ctx context.Context, userID string, ids []string, all bool) (int, error) {
	if all {
		tag, err := s.pool.Exec(ctx, `UPDATE app.notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, userID)
		return int(tag.RowsAffected()), err
	}
	tag, err := s.pool.Exec(ctx, `UPDATE app.notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::uuid[])`, userID, ids)
	return int(tag.RowsAffected()), err
}

// QueryLogEntry is one logged question.
type QueryLogEntry struct {
	ID              string  `json:"id"`
	Query           string  `json:"query"`
	Mode            string  `json:"mode"`
	CollectionID    *string `json:"collectionId"`
	LatencyMs       int     `json:"latencyMs"`
	ChunksRetrieved int     `json:"chunksRetrieved"`
	Status          string  `json:"status"`
	CreatedAt       string  `json:"createdAt"`
}

// Analytics is the usage and latency summary.
type Analytics struct {
	Scope  string `json:"scope"`
	Totals struct {
		Queries      int  `json:"queries"`
		Errors       int  `json:"errors"`
		Insufficient int  `json:"insufficient"`
		AvgLatencyMs *int `json:"avgLatencyMs"`
		P95LatencyMs *int `json:"p95LatencyMs"`
	} `json:"totals"`
	ByMode map[string]int  `json:"byMode"`
	Recent []QueryLogEntry `json:"recent"`
}

// AnalyticsSummary: ownerID's questions, or with ownerID "" everyone's in the workspace.
func (s *Store) AnalyticsSummary(ctx context.Context, workspaceID, ownerID string) (*Analytics, error) {
	where, args := `workspace_id = $1`, []any{workspaceID}
	summary := &Analytics{Scope: "workspace", ByMode: map[string]int{"standard": 0, "deep": 0}, Recent: []QueryLogEntry{}}
	if ownerID != "" {
		where, args = where+` AND owner_id = $2`, append(args, ownerID)
		summary.Scope = "me"
	}
	err := s.pool.QueryRow(ctx, `SELECT count(*)::int,
		  count(*) FILTER (WHERE status = 'error')::int,
		  count(*) FILTER (WHERE status = 'insufficient_context')::int,
		  round(avg(latency_ms) FILTER (WHERE status = 'ok'))::int,
		  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status = 'ok'))::int
		FROM app.query_logs WHERE `+where, args...).Scan(&summary.Totals.Queries, &summary.Totals.Errors, &summary.Totals.Insufficient, &summary.Totals.AvgLatencyMs, &summary.Totals.P95LatencyMs)
	if err != nil {
		return nil, err
	}
	modes, err := s.pool.Query(ctx, `SELECT mode, count(*)::int FROM app.query_logs WHERE `+where+` GROUP BY mode`, args...)
	if err != nil {
		return nil, err
	}
	for modes.Next() {
		var mode string
		var count int
		if err := modes.Scan(&mode, &count); err != nil {
			modes.Close()
			return nil, err
		}
		if mode == "standard" || mode == "deep" {
			summary.ByMode[mode] = count
		}
	}
	modes.Close()
	if err := modes.Err(); err != nil {
		return nil, err
	}
	recent, err := s.pool.Query(ctx, `SELECT id::text, query, mode, collection_id::text, latency_ms, chunks_retrieved, status, created_at
		FROM app.query_logs WHERE `+where+` ORDER BY created_at DESC, id DESC LIMIT 20`, args...)
	if err != nil {
		return nil, err
	}
	defer recent.Close()
	for recent.Next() {
		var entry QueryLogEntry
		var created time.Time
		if err := recent.Scan(&entry.ID, &entry.Query, &entry.Mode, &entry.CollectionID, &entry.LatencyMs, &entry.ChunksRetrieved, &entry.Status, &created); err != nil {
			return nil, err
		}
		if entry.Mode != "deep" {
			entry.Mode = "standard"
		}
		if entry.Status != "error" && entry.Status != "insufficient_context" {
			entry.Status = "ok"
		}
		entry.CreatedAt = IsoTime(created)
		summary.Recent = append(summary.Recent, entry)
	}
	return summary, recent.Err()
}

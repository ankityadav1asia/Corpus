package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/ankityadav1asia/Corpus/backend/ai"
	"github.com/ankityadav1asia/Corpus/backend/rag"
)

// Asking a question (group 4): hybrid search, the conversation's messages, the query log, the
// evaluation queue. The SQL is server/repositories/{documents,conversations,analytics,jobs,
// chunks,evaluations}.ts.

// vectorLiteral is pgvector's text form; non-finite values become 0, as in TypeScript.
func vectorLiteral(values []float64) (string, error) {
	if len(values) != ai.EmbeddingDimensions {
		return "", fmt.Errorf("expected a %d-dimension embedding, got %d", ai.EmbeddingDimensions, len(values))
	}
	var b strings.Builder
	b.Grow(len(values) * 12)
	b.WriteByte('[')
	for i, v := range values {
		if i > 0 {
			b.WriteByte(',')
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			v = 0
		}
		b.WriteString(strconv.FormatFloat(v, 'g', -1, 64))
	}
	b.WriteByte(']')
	return b.String(), nil
}

const hitColumns = `c.id::text, c.document_id::text, c.collection_id::text, c.content, d.title, d.source, d.source_type`

func scanHits(rows pgx.Rows) ([]rag.Hit, error) {
	defer rows.Close()
	hits := []rag.Hit{}
	for rows.Next() {
		var hit rag.Hit
		if err := rows.Scan(&hit.ChunkID, &hit.DocumentID, &hit.CollectionID, &hit.Content, &hit.Title, &hit.Source, &hit.SourceType, &hit.Similarity); err != nil {
			return nil, err
		}
		hits = append(hits, hit)
	}
	return hits, rows.Err()
}

// VectorSearch: nearest chunks of ready documents, comparing only vectors of the active model.
func (s *Store) VectorSearch(ctx context.Context, scope rag.Scope, embedding []float64, embeddingModel string, limit int) ([]rag.Hit, error) {
	literal, err := vectorLiteral(embedding)
	if err != nil {
		return nil, err
	}
	args := []any{scope.WorkspaceID, literal, limit}
	filter := ""
	if scope.CollectionID != "" {
		args = append(args, scope.CollectionID)
		filter = fmt.Sprintf(" AND c.collection_id = $%d", len(args))
	}
	if embeddingModel != "" {
		args = append(args, embeddingModel)
		filter += fmt.Sprintf(" AND (c.embedding_model IS NULL OR c.embedding_model = $%d)", len(args))
	}
	rows, err := s.pool.Query(ctx, `SELECT `+hitColumns+`, 1 - (c.embedding <=> $2::vector)
		FROM app.chunks c
		JOIN app.documents d ON d.id = c.document_id
		WHERE c.workspace_id = $1 AND d.status = 'ready'`+filter+`
		ORDER BY c.embedding <=> $2::vector
		LIMIT $3`, args...)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}

// KeywordSearch: full-text matches; websearch_to_tsquery accepts any user text without errors.
func (s *Store) KeywordSearch(ctx context.Context, scope rag.Scope, query string, limit int) ([]rag.Hit, error) {
	args := []any{scope.WorkspaceID, query, limit}
	filter := ""
	if scope.CollectionID != "" {
		args = append(args, scope.CollectionID)
		filter = ` AND c.collection_id = $4`
	}
	rows, err := s.pool.Query(ctx, `SELECT `+hitColumns+`, NULL::float8
		FROM app.chunks c
		JOIN app.documents d ON d.id = c.document_id
		CROSS JOIN LATERAL websearch_to_tsquery('english', $2) AS q(query)
		WHERE c.workspace_id = $1 AND d.status = 'ready' AND c.tsv @@ q.query`+filter+`
		ORDER BY ts_rank_cd(c.tsv, q.query) DESC, c.id
		LIMIT $3`, args...)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// CreateConversation starts a thread with its first message's title.
func (s *Store) CreateConversation(ctx context.Context, workspaceID, ownerID, collectionID, title string) (*Conversation, error) {
	return s.one(ctx, `INSERT INTO app.conversations (workspace_id, owner_id, collection_id, title) VALUES ($1, $2, $3, $4) RETURNING `+conversationColumns,
		workspaceID, ownerID, nullable(collectionID), title)
}

// RecentTurns: the last limit messages, oldest first.
func (s *Store) RecentTurns(ctx context.Context, conversationID string, limit int) ([]ai.Turn, error) {
	rows, err := s.pool.Query(ctx, `SELECT role, content FROM (
		  SELECT role, content, seq FROM app.messages WHERE conversation_id = $1 ORDER BY seq DESC LIMIT $2
		) recent ORDER BY seq`, conversationID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	turns := []ai.Turn{}
	for rows.Next() {
		var turn ai.Turn
		if err := rows.Scan(&turn.Role, &turn.Content); err != nil {
			return nil, err
		}
		if turn.Role != "assistant" {
			turn.Role = "user"
		}
		turns = append(turns, turn)
	}
	return turns, rows.Err()
}

// AddMessage stores a message with its citations and research steps; returns its id.
func (s *Store) AddMessage(ctx context.Context, conversationID, role, content string, citations, steps any) (string, error) {
	if citations == nil {
		citations = []any{}
	}
	if steps == nil {
		steps = []any{}
	}
	citationsJSON, err := json.Marshal(citations)
	if err != nil {
		return "", err
	}
	stepsJSON, err := json.Marshal(steps)
	if err != nil {
		return "", err
	}
	var id string
	err = s.pool.QueryRow(ctx, `INSERT INTO app.messages (conversation_id, role, content, citations, steps) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) RETURNING id::text`,
		conversationID, role, content, string(citationsJSON), string(stepsJSON)).Scan(&id)
	return id, err
}

// TouchConversation records activity and the notebook used most recently in the thread.
func (s *Store) TouchConversation(ctx context.Context, id, collectionID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE app.conversations SET updated_at = now(), collection_id = $2 WHERE id = $1`, id, nullable(collectionID))
	return err
}

// QueryLog is one question for the usage analytics.
type QueryLog struct {
	WorkspaceID, OwnerID, CollectionID, Mode, Query, Status string
	LatencyMs, ChunksRetrieved                              int
}

func (s *Store) LogQuery(ctx context.Context, entry QueryLog) error {
	query := entry.Query
	if runes := []rune(query); len(runes) > 500 {
		query = string(runes[:500])
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO app.query_logs (workspace_id, owner_id, collection_id, mode, query, latency_ms, chunks_retrieved, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		entry.WorkspaceID, entry.OwnerID, nullable(entry.CollectionID), entry.Mode, query, max(0, entry.LatencyMs), entry.ChunksRetrieved, entry.Status)
	return err
}

// EnqueueJob adds a background job for the TypeScript runner (or for EvaluatePending below).
func (s *Store) EnqueueJob(ctx context.Context, jobType string, payload any, maxAttempts int) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO app.jobs (type, payload, run_after, max_attempts) VALUES ($1, $2::jsonb, now(), $3)`, jobType, string(encoded), maxAttempts)
	return err
}

// FollowupSource is an answer with its question, for suggesting follow-ups.
type FollowupSource struct {
	WorkspaceID, OwnerID, Role, Answer, Question string
	CitationTitles                               []string
	Followups                                    []string // nil until generated
}

func (s *Store) FollowupSource(ctx context.Context, messageID string) (*FollowupSource, error) {
	var src FollowupSource
	var question *string
	var citations, followups []byte
	err := s.pool.QueryRow(ctx, `SELECT c.workspace_id::text, c.owner_id::text, a.role, a.content, a.citations, a.followups,
		  (SELECT q.content FROM app.messages q WHERE q.conversation_id = a.conversation_id AND q.seq < a.seq AND q.role = 'user' ORDER BY q.seq DESC LIMIT 1)
		FROM app.messages a JOIN app.conversations c ON c.id = a.conversation_id
		WHERE a.id = $1`, messageID).Scan(&src.WorkspaceID, &src.OwnerID, &src.Role, &src.Answer, &citations, &followups, &question)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidID(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if question != nil {
		src.Question = *question
	}
	var cited []struct {
		Title string `json:"title"`
	}
	_ = json.Unmarshal(citations, &cited)
	for _, c := range cited {
		src.CitationTitles = append(src.CitationTitles, c.Title)
	}
	var items []any
	if len(followups) > 0 && json.Unmarshal(followups, &items) == nil && items != nil {
		src.Followups = []string{}
		for _, item := range items {
			if text, ok := item.(string); ok {
				src.Followups = append(src.Followups, text)
			}
		}
	}
	return &src, nil
}

func (s *Store) SetFollowups(ctx context.Context, messageID string, followups []string) error {
	encoded, err := json.Marshal(followups)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `UPDATE app.messages SET followups = $2::jsonb WHERE id = $1`, messageID, string(encoded))
	return err
}

// ── Answer evaluation ────────────────────────────────────────────────────

// PendingEvaluation is a claimed evaluate_answer job.
type PendingEvaluation struct {
	JobID     string
	MessageID string
	ChunkIDs  []string
	Attempts  int
}

// ClaimEvaluation claims the queued evaluate_answer job of one message (the TypeScript runner's
// claim, for one job), or returns nil when there is none or another worker has it.
func (s *Store) ClaimEvaluation(ctx context.Context, messageID string) (*PendingEvaluation, error) {
	var job PendingEvaluation
	var payload []byte
	err := s.pool.QueryRow(ctx, `UPDATE app.jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
		WHERE id = (
		  SELECT id FROM app.jobs
		  WHERE type = 'evaluate_answer' AND status = 'queued' AND run_after <= now() AND payload @> jsonb_build_object('messageId', $1::text)
		  ORDER BY run_after
		  FOR UPDATE SKIP LOCKED
		  LIMIT 1
		)
		RETURNING id::text, payload, attempts`, messageID).Scan(&job.JobID, &payload, &job.Attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var parsed struct {
		MessageID string   `json:"messageId"`
		ChunkIDs  []string `json:"chunkIds"`
	}
	if json.Unmarshal(payload, &parsed) != nil {
		return nil, s.FailJob(ctx, job.JobID, "Invalid job payload", 0, true)
	}
	job.MessageID, job.ChunkIDs = parsed.MessageID, parsed.ChunkIDs
	return &job, nil
}

func (s *Store) CompleteJob(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `UPDATE app.jobs SET status = 'completed', locked_at = NULL, last_error = NULL, updated_at = now() WHERE id = $1`, id)
	return err
}

// FailJob re-queues with a delay, or marks the job failed when it is out of attempts or permanent.
func (s *Store) FailJob(ctx context.Context, id, message string, retryDelaySeconds float64, permanent bool) error {
	_, err := s.pool.Exec(ctx, `UPDATE app.jobs SET
		  status = CASE WHEN $4::boolean OR attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
		  run_after = now() + make_interval(secs => $3::float8),
		  locked_at = NULL,
		  last_error = left($2, 2000),
		  updated_at = now()
		WHERE id = $1`, id, message, retryDelaySeconds, permanent)
	return err
}

// EvaluationTarget is an answer with the question it answered.
type EvaluationTarget struct {
	WorkspaceID, Question, Answer string
}

func (s *Store) EvaluationTarget(ctx context.Context, messageID string) (*EvaluationTarget, error) {
	var target EvaluationTarget
	var question *string
	err := s.pool.QueryRow(ctx, `SELECT a.content, c.workspace_id::text,
		  (SELECT q.content FROM app.messages q WHERE q.conversation_id = a.conversation_id AND q.seq < a.seq AND q.role = 'user' ORDER BY q.seq DESC LIMIT 1)
		FROM app.messages a JOIN app.conversations c ON c.id = a.conversation_id
		WHERE a.id = $1 AND a.role = 'assistant'`, messageID).Scan(&target.Answer, &target.WorkspaceID, &question)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidID(err) || question == nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	target.Question = *question
	return &target, nil
}

// ChunkTexts returns the passages of ids that still exist, in the order of ids.
func (s *Store) ChunkTexts(ctx context.Context, workspaceID string, ids []string) ([]string, []string, error) {
	if len(ids) == 0 {
		return nil, nil, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT id::text, content FROM app.chunks WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, workspaceID, ids)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	byID := map[string]string{}
	for rows.Next() {
		var id, text string
		if err := rows.Scan(&id, &text); err != nil {
			return nil, nil, err
		}
		byID[id] = text
	}
	var found, texts []string
	for _, id := range ids {
		if text, ok := byID[id]; ok {
			found, texts = append(found, id), append(texts, text)
		}
	}
	return found, texts, rows.Err()
}

// SaveEvaluation stores (or replaces) the scores of one answer.
func (s *Store) SaveEvaluation(ctx context.Context, workspaceID, messageID, question, answer string, scores rag.Scores, details any, model string) error {
	encoded, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO app.evaluations (workspace_id, message_id, run_id, case_id, question, answer,
		    faithfulness, answer_relevance, context_precision, context_recall, details, model)
		VALUES ($1, $2, NULL, NULL, left($3, 4000), left($4, 20000), $5, $6, $7, $8, $9::jsonb, $10)
		ON CONFLICT (message_id) DO UPDATE SET
		  faithfulness = EXCLUDED.faithfulness, answer_relevance = EXCLUDED.answer_relevance,
		  context_precision = EXCLUDED.context_precision, context_recall = EXCLUDED.context_recall,
		  details = EXCLUDED.details, model = EXCLUDED.model, created_at = now()`,
		workspaceID, messageID, question, answer, scores.Faithfulness, scores.AnswerRelevance, scores.ContextPrecision, scores.ContextRecall, string(encoded), model)
	return err
}

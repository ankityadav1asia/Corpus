package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ankityadav1asia/Corpus/backend/ai"
	"github.com/ankityadav1asia/Corpus/backend/apperr"
	"github.com/ankityadav1asia/Corpus/backend/httpx"
	"github.com/ankityadav1asia/Corpus/backend/jsstr"
	"github.com/ankityadav1asia/Corpus/backend/logx"
	"github.com/ankityadav1asia/Corpus/backend/rag"
	"github.com/ankityadav1asia/Corpus/backend/store"
)

// Group 4a: asking a question (POST /api/chat, streamed as NDJSON), follow-up suggestions, and
// running an answer's queued evaluation when the client polls for it. The TypeScript originals
// are app/api/chat/route.ts, server/rag/chat-service.ts and app/api/messages/[id]/followups.

// ChatStore is what asking needs from the database (implemented by *store.Store).
type ChatStore interface {
	rag.Searcher
	CreateConversation(ctx context.Context, workspaceID, ownerID, collectionID, title string) (*store.Conversation, error)
	RecentTurns(ctx context.Context, conversationID string, limit int) ([]ai.Turn, error)
	AddMessage(ctx context.Context, conversationID, role, content string, citations, steps any) (string, error)
	TouchConversation(ctx context.Context, id, collectionID string) error
	LogQuery(ctx context.Context, entry store.QueryLog) error
	EnqueueJob(ctx context.Context, jobType string, payload any, maxAttempts int) error
	FollowupSource(ctx context.Context, messageID string) (*store.FollowupSource, error)
	SetFollowups(ctx context.Context, messageID string, followups []string) error
	ClaimEvaluation(ctx context.Context, messageID string) (*store.PendingEvaluation, error)
	CompleteJob(ctx context.Context, id string) error
	FailJob(ctx context.Context, id, message string, retryDelaySeconds float64, permanent bool) error
	EvaluationTarget(ctx context.Context, messageID string) (*store.EvaluationTarget, error)
	ChunkTexts(ctx context.Context, workspaceID string, ids []string) ([]string, []string, error)
	SaveEvaluation(ctx context.Context, workspaceID, messageID, question, answer string, scores rag.Scores, details any, model string) error
}

const (
	chatBodyLimit        = 16 * 1024
	chatMessageChars     = 4000
	chatPerMinute        = 20
	historyMessages      = 8
	followupsPerHour     = 200
	followupTimeout      = 10 * time.Second
	evaluationTimeout    = 25 * time.Second
	evaluationAttempts   = 3
	demoQuestionsPerIP   = 15
	demoQuestionsDefault = 50
	// InsufficientContextMessage is the fixed reply when nothing relevant enough was found.
	InsufficientContextMessage = "Insufficient context in knowledge base."
)

// models is the AI provider and re-ranker from the environment (overridable in tests).
var models = func() (ai.Provider, rag.Reranker, error) {
	provider, rerankConfig, err := ai.FromEnv()
	if err != nil {
		return nil, nil, err
	}
	switch rerankConfig.Kind {
	case "cohere":
		return provider, rag.NewCohereReranker(rerankConfig.APIKey, rerankConfig.Model), nil
	case "llm":
		return provider, rag.NewLLMReranker(provider), nil
	}
	return provider, nil, nil
}

// queryCache is shared by the requests of one instance.
var queryCache = &rag.QueryCache{}

// randomFloat samples answers for evaluation (overridable in tests).
var randomFloat = rand.Float64

func (s *Server) chatOnly(run handler) handler {
	return func(req *request) error {
		if s.asking == nil || s.chats == nil || s.admin == nil {
			return apperr.NotConfigured("Server is missing required configuration: POSTGRES_URL")
		}
		return run(req)
	}
}

// ── Request validation ───────────────────────────────────────────────────

type chatInput struct {
	message, conversationID, collectionID, mode string
}

func optionalID(object map[string]any, name string) (string, *apperr.Issue) {
	raw, present := object[name]
	if !present || raw == nil {
		return "", nil
	}
	return guidField(object, name)
}

func readChatInput(req *request) (chatInput, error) {
	body, err := httpx.ReadJSON(req.r, chatBodyLimit)
	if err != nil {
		return chatInput{}, err
	}
	object, err := httpx.Object(body)
	if err != nil {
		return chatInput{}, err
	}
	var input chatInput
	var issues []apperr.Issue
	var issue *apperr.Issue
	if input.message, issue = httpx.RequiredText(object, "message", chatMessageChars); issue != nil {
		issues = append(issues, *issue)
	}
	if input.conversationID, issue = optionalID(object, "conversationId"); issue != nil {
		issues = append(issues, *issue)
	}
	if input.collectionID, issue = optionalID(object, "collectionId"); issue != nil {
		issues = append(issues, *issue)
	}
	input.mode = "standard"
	if raw, present := object["mode"]; present {
		mode, _ := raw.(string)
		if mode != "standard" && mode != "deep" {
			issues = append(issues, apperr.Issue{Path: "mode", Message: `Invalid option: expected one of "standard"|"deep"`})
		}
		input.mode = mode
	}
	if len(issues) > 0 {
		return chatInput{}, apperr.Validation(issues)
	}
	return input, nil
}

// ── Demo limits (server/auth/demo.ts) ────────────────────────────────────

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// clientIP is the address the trusted proxy saw (TRUST_PROXY hops of X-Forwarded-For; 1 on
// Vercel); without a trusted proxy every caller shares one bucket.
func clientIP(r *http.Request) string {
	hops := 0
	switch value := strings.ToLower(strings.TrimSpace(os.Getenv("TRUST_PROXY"))); {
	case value == "true":
		hops = 1
	case value != "":
		if n, err := strconv.Atoi(value); err == nil && n > 0 {
			hops = min(n, 5)
		}
	case os.Getenv("VERCEL") != "":
		hops = 1
	}
	if hops == 0 {
		return "untrusted"
	}
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		chain := strings.Split(forwarded, ",")
		if len(chain) >= hops {
			if client := strings.TrimSpace(chain[len(chain)-hops]); net.ParseIP(client) != nil {
				return client
			}
		}
		return "unknown"
	}
	if real := strings.TrimSpace(r.Header.Get("X-Real-IP")); net.ParseIP(real) != nil {
		return real
	}
	return "unknown"
}

func demoLimit(err error, message string) error {
	if limited, ok := apperr.As(err); ok && limited.Status == 429 {
		return &apperr.Error{Status: 429, Code: "DEMO_LIMIT", Message: message, Details: limited.Details, Headers: limited.Headers}
	}
	return err
}

// demoQuestionLimits: a guest's question counts against their IP's hourly allowance and the
// demo's daily one.
func (s *Server) demoQuestionLimits(ctx context.Context, r *http.Request) error {
	workspace := strings.TrimSpace(os.Getenv("DEMO_WORKSPACE_ID"))
	if !uuidPattern.MatchString(workspace) {
		return apperr.NotFound("Demo")
	}
	daily, err := strconv.Atoi(strings.TrimSpace(os.Getenv("DEMO_DAILY_QUESTIONS")))
	if err != nil || daily <= 0 {
		daily = demoQuestionsDefault
	}
	if err := s.rateLimit(ctx, "demo:questions:ip:"+clientIP(r), demoQuestionsPerIP, 3600); err != nil {
		return demoLimit(err, "You have asked a lot of questions in the demo. Please try again in an hour.")
	}
	if err := s.rateLimit(ctx, "demo:questions:day", daily, 86400); err != nil {
		return demoLimit(err, "The demo has answered all of today’s questions. Please come back tomorrow, or run your own copy from the GitHub repository.")
	}
	return nil
}

// ── POST /api/chat ───────────────────────────────────────────────────────

type preparedChat struct {
	workspaceID, userID, conversationID, conversationTitle, collectionID, mode, question, userMessageID string
	createdConversation                                                                                 bool
	history                                                                                             []ai.Turn
	settings                                                                                            WorkspaceSettings
	startedAt                                                                                           time.Time
}

// prepareChat validates access, creates the conversation on the first message and stores the
// question, before streaming starts, so failures are normal HTTP errors. History comes from the
// database: the client cannot inject assistant turns.
func (s *Server) prepareChat(ctx context.Context, req *request, input chatInput) (*preparedChat, error) {
	chat := &preparedChat{workspaceID: req.access.WorkspaceID, userID: req.access.UserID, collectionID: input.collectionID, mode: input.mode, question: input.message, startedAt: time.Now()}
	settings, err := s.settings(ctx, chat.workspaceID)
	if err != nil {
		return nil, err
	}
	chat.settings = settings
	if chat.collectionID != "" {
		ref, err := s.admin.Collection(ctx, chat.workspaceID, chat.collectionID, chat.userID)
		if err != nil {
			return nil, err
		}
		if ref == nil {
			return nil, apperr.NotFound("Notebook")
		}
	}
	var conversation *store.Conversation
	if input.conversationID != "" {
		if conversation, err = s.chats.GetConversation(ctx, chat.workspaceID, chat.userID, input.conversationID); err != nil {
			return nil, err
		}
		if conversation == nil {
			return nil, apperr.NotFound("Conversation")
		}
		turns, err := s.asking.RecentTurns(ctx, conversation.ID, historyMessages)
		if err != nil {
			return nil, err
		}
		chat.history = rag.NormalizeTurns(turns)
	} else {
		if conversation, err = s.asking.CreateConversation(ctx, chat.workspaceID, chat.userID, chat.collectionID, rag.DeriveTitle(input.message)); err != nil {
			return nil, err
		}
		chat.createdConversation = true
	}
	chat.conversationID, chat.conversationTitle = conversation.ID, conversation.Title
	if chat.userMessageID, err = s.asking.AddMessage(ctx, conversation.ID, "user", input.message, nil, nil); err != nil {
		return nil, err
	}
	return chat, nil
}

func (s *Server) chat(req *request) error {
	input, err := readChatInput(req)
	if err != nil {
		return err
	}
	ctx := req.r.Context()
	if err := s.rateLimit(ctx, "chat:user:"+req.access.UserID, chatPerMinute, 60); err != nil {
		return err
	}
	if req.access.IsGuest {
		if err := s.demoQuestionLimits(ctx, req.r); err != nil {
			return err
		}
	}
	provider, reranker, err := models()
	if err != nil {
		return err
	}
	chat, err := s.prepareChat(ctx, req, input)
	if err != nil {
		return err
	}
	s.streamChat(ctx, req.w, provider, reranker, chat)
	return nil
}

// ndjson writes one event per line and flushes it at once.
type ndjson struct {
	w       http.ResponseWriter
	flusher http.Flusher
}

func (n ndjson) send(event map[string]any) error {
	line, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err := n.w.Write(append(line, '\n')); err != nil {
		return err
	}
	if n.flusher != nil {
		n.flusher.Flush()
	}
	return nil
}

// errEmptyAnswer: the model returned nothing (often a safety filter).
var errEmptyAnswer = &apperr.Error{Status: 502, Code: "EMPTY_ANSWER", Message: "The model returned no answer (it may have been blocked by a safety filter). Try rephrasing."}

func chatErrorMessage(err error) string {
	if appErr, ok := apperr.As(err); ok {
		return appErr.Message
	}
	if vendor, ok := ai.AsError(err); ok {
		if vendor.DailyQuota {
			return ai.DailyQuotaMessage
		}
		if vendor.Status == 429 {
			return "The AI service is rate-limiting requests. Please try again in a minute."
		}
		return "The AI service could not answer right now. Please try again."
	}
	return "Something went wrong while answering. Please try again."
}

// streamChat runs the pipeline and streams progress and the answer. A disconnect cancels ctx,
// which stops the model call; what was written is still saved and the question still logged.
func (s *Server) streamChat(ctx context.Context, w http.ResponseWriter, provider ai.Provider, reranker rag.Reranker, chat *preparedChat) {
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	out := ndjson{w: w, flusher: flusher}

	var answer strings.Builder
	var citations []rag.Citation
	var steps []rag.Step
	chunksRetrieved, finished, outcome := 0, false, "error"

	defer func() {
		// Runs on success, on error and after a disconnect, so with a context that is not cancelled.
		background, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if !finished && jsstr.Trim(answer.String()) != "" {
			if _, err := s.asking.AddMessage(background, chat.conversationID, "assistant", answer.String(), citations, steps); err != nil {
				logx.Error("Could not save partial answer", err, logx.Fields{"conversationId": chat.conversationID})
			}
		}
		if err := s.asking.TouchConversation(background, chat.conversationID, chat.collectionID); err != nil {
			logx.Warn("Could not update conversation timestamp", logx.Fields{"error": err.Error()})
		}
		status := "error"
		if finished {
			status = outcome
		}
		if err := s.asking.LogQuery(background, store.QueryLog{WorkspaceID: chat.workspaceID, OwnerID: chat.userID, CollectionID: chat.collectionID, Mode: chat.mode,
			Query: chat.question, LatencyMs: int(time.Since(chat.startedAt).Milliseconds()), ChunksRetrieved: chunksRetrieved, Status: status}); err != nil {
			logx.Warn("Could not write query log", logx.Fields{"error": err.Error()})
		}
	}()

	if out.send(map[string]any{"type": "start", "conversationId": chat.conversationID, "conversationTitle": chat.conversationTitle, "createdConversation": chat.createdConversation, "userMessageId": chat.userMessageID}) != nil {
		return
	}
	err := func() error {
		retrieval := rag.RetrievalSettings{Rerank: chat.settings.Retrieval.Rerank, CandidatePool: chat.settings.Retrieval.CandidatePool, TopK: chat.settings.Retrieval.TopK,
			MultiQueryCount: chat.settings.Retrieval.MultiQueryCount, StepBack: chat.settings.Retrieval.StepBack, Hyde: chat.settings.Retrieval.Hyde}
		if chat.mode == "deep" {
			if err := out.send(map[string]any{"type": "status", "stage": "planning", "message": "Expanding the question (multi-query, step-back, HyDE)…"}); err != nil {
				return err
			}
		}
		plan := rag.PlanRetrieval(ctx, provider, chat.question, chat.history, chat.mode, retrieval)
		if err := out.send(map[string]any{"type": "status", "stage": "searching", "message": "Searching your notebooks…"}); err != nil {
			return err
		}
		scope := rag.Scope{WorkspaceID: chat.workspaceID, CollectionID: chat.collectionID}
		candidates, searches, err := rag.SearchCandidates(ctx, provider, queryCache, s.asking, scope, plan, retrieval.CandidatePool)
		if err != nil {
			return err
		}
		if retrieval.Rerank && reranker != nil && len(candidates) > 0 {
			noun := "passages"
			if len(candidates) == 1 {
				noun = "passage"
			}
			if err := out.send(map[string]any{"type": "status", "stage": "reranking", "message": fmt.Sprintf("Re-ranking %d %s…", len(candidates), noun)}); err != nil {
				return err
			}
		}
		rerank := rag.RerankCandidates(ctx, reranker, chat.question, candidates, retrieval.TopK, retrieval.Rerank)
		guardrail := rag.EvaluateRelevance(rag.GuardrailSettings{Enabled: chat.settings.Guardrail.Enabled, MinRelevance: chat.settings.Guardrail.MinRelevance, MinSimilarity: chat.settings.Guardrail.MinSimilarity}, len(candidates), rerank.Hits)
		hits := rerank.Hits
		if !guardrail.Pass {
			hits = nil
		}
		chunksRetrieved = len(hits)
		citations = rag.ToCitations(hits)
		steps = rag.DescribeRetrieval(chat.mode, plan, len(candidates), searches, rerank, guardrail)
		if err := out.send(map[string]any{"type": "sources", "citations": citations, "steps": steps}); err != nil {
			return err
		}

		if !guardrail.Pass {
			// Nothing relevant enough: the model is never asked to improvise.
			answer.WriteString(InsufficientContextMessage)
			if err := out.send(map[string]any{"type": "delta", "text": InsufficientContextMessage}); err != nil {
				return err
			}
			id, err := s.asking.AddMessage(ctx, chat.conversationID, "assistant", InsufficientContextMessage, citations, steps)
			if err != nil {
				return err
			}
			finished, outcome = true, "insufficient_context"
			return out.send(map[string]any{"type": "done", "assistantMessageId": id})
		}

		if err := out.send(map[string]any{"type": "status", "stage": "generating", "message": "Writing the answer…"}); err != nil {
			return err
		}
		turns := rag.NormalizeTurns(append(append([]ai.Turn{}, chat.history...), ai.Turn{Role: "user", Content: rag.UserPrompt(chat.question, rag.Passages(hits))}))
		// Standard mode skips the model's thinking phase so the first words arrive sooner.
		err = provider.StreamChat(ctx, rag.SystemPrompt(chat.mode), turns, chat.mode == "standard", func(text string) error {
			answer.WriteString(text)
			return out.send(map[string]any{"type": "delta", "text": text})
		})
		if err != nil {
			return err
		}
		if jsstr.Trim(answer.String()) == "" {
			return errEmptyAnswer
		}
		id, err := s.asking.AddMessage(ctx, chat.conversationID, "assistant", answer.String(), citations, steps)
		if err != nil {
			return err
		}
		finished, outcome = true, "ok"
		s.scheduleEvaluation(ctx, chat, id, hits)
		return out.send(map[string]any{"type": "done", "assistantMessageId": id})
	}()
	if err != nil && ctx.Err() == nil {
		logx.Error("Chat generation failed", err, logx.Fields{"conversationId": chat.conversationID})
		_ = out.send(map[string]any{"type": "error", "message": chatErrorMessage(err)})
	}
}

// scheduleEvaluation queues quality scoring for a sample of answers; never fails the chat. The
// client's next poll of the conversation runs it (conversationDetail → evaluatePending), and the
// TypeScript job runner and the cron pick it up otherwise.
func (s *Server) scheduleEvaluation(ctx context.Context, chat *preparedChat, messageID string, hits []rag.RankedHit) {
	evaluation := chat.settings.Evaluation
	if !evaluation.Enabled || len(hits) == 0 || randomFloat() >= evaluation.SampleRate {
		return
	}
	chunkIDs := make([]string, len(hits))
	for i, hit := range hits {
		chunkIDs[i] = hit.ChunkID
	}
	if err := s.asking.EnqueueJob(ctx, "evaluate_answer", map[string]any{"messageId": messageID, "chunkIds": chunkIDs}, evaluationAttempts); err != nil {
		logx.Warn("Could not queue answer evaluation", logx.Fields{"error": err.Error()})
	}
}

// ── POST /api/messages/:id/followups ─────────────────────────────────────

// followups: suggested next questions for one of the caller's answers, generated once and stored.
// Suggestions are optional: any failure gives an empty list rather than an error.
func (s *Server) followups(req *request) error {
	id, err := pathID(req.r.PathValue("id"))
	if err != nil {
		return err
	}
	ctx := req.r.Context()
	source, err := s.asking.FollowupSource(ctx, id)
	if err != nil {
		return err
	}
	if source == nil || source.WorkspaceID != req.access.WorkspaceID || source.OwnerID != req.access.UserID || source.Role != "assistant" {
		return apperr.NotFound("Answer")
	}
	empty := map[string]any{"followups": []string{}}
	if source.Followups != nil {
		return req.json(200, map[string]any{"followups": source.Followups})
	}
	// Demo visitors spend the model quota on answers only.
	if req.access.IsGuest || source.Question == "" || len(source.CitationTitles) == 0 || jsstr.Trim(source.Answer) == InsufficientContextMessage {
		return req.json(200, empty)
	}
	if err := s.rateLimit(ctx, "followups:user:"+req.access.UserID, followupsPerHour, 3600); err != nil {
		return err
	}
	provider, _, err := models()
	if err != nil {
		logx.Warn("Could not suggest follow-up questions", logx.Fields{"error": err.Error()})
		return req.json(200, empty)
	}
	titles := []string{}
	seen := map[string]bool{}
	for _, title := range source.CitationTitles {
		if !seen[title] {
			seen[title] = true
			titles = append(titles, title)
		}
	}
	suggestCtx, cancel := context.WithTimeout(ctx, followupTimeout)
	defer cancel()
	suggested, err := rag.SuggestFollowups(suggestCtx, provider, source.Question, source.Answer, titles)
	if err != nil {
		logx.Warn("Could not suggest follow-up questions", logx.Fields{"error": err.Error()})
		return req.json(200, empty)
	}
	if len(suggested) > 0 {
		if err := s.asking.SetFollowups(ctx, id, suggested); err != nil {
			return err
		}
	}
	return req.json(200, map[string]any{"followups": suggested})
}

// ── Running a queued evaluation when the client polls ────────────────────

// retryDelay is the job runner's backoff: 10 s doubling, at most 300 s.
func retryDelay(attempt int) float64 {
	return math.Min(300, 10*math.Pow(2, math.Max(0, float64(attempt-1))))
}

// evaluatePending scores the answer whose evaluate_answer job is queued, if any (the TypeScript
// job runner's evaluate_answer step for that one job). Returns whether scores were saved.
func (s *Server) evaluatePending(ctx context.Context, messageID string) bool {
	if s.asking == nil {
		return false
	}
	provider, _, err := models()
	if err != nil {
		return false
	}
	job, err := s.asking.ClaimEvaluation(ctx, messageID)
	if err != nil || job == nil {
		return false
	}
	runCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), evaluationTimeout)
	defer cancel()
	err = func() error {
		target, err := s.asking.EvaluationTarget(runCtx, job.MessageID)
		if err != nil || target == nil {
			return err // deleted meanwhile: nothing to score
		}
		chunkIDs, passages, err := s.asking.ChunkTexts(runCtx, target.WorkspaceID, job.ChunkIDs)
		if err != nil {
			return err
		}
		scores, verdict, err := rag.JudgeAnswer(runCtx, provider, target.Question, target.Answer, passages)
		if err != nil {
			return err
		}
		if chunkIDs == nil {
			chunkIDs = []string{}
		}
		details := map[string]any{"claims": verdict.Claims, "answer_relevance": verdict.AnswerRelevance, "passages": verdict.Passages, "reference_statements": verdict.ReferenceStatements, "chunkIds": chunkIDs}
		return s.asking.SaveEvaluation(runCtx, target.WorkspaceID, job.MessageID, target.Question, target.Answer, scores, details, provider.ChatModel())
	}()
	if err == nil {
		if completeErr := s.asking.CompleteJob(runCtx, job.JobID); completeErr != nil {
			logx.Warn("Could not complete evaluation job", logx.Fields{"error": completeErr.Error()})
		}
		return true
	}
	permanent, delay := false, retryDelay(job.Attempts)
	if vendor, ok := ai.AsError(err); ok {
		permanent = vendor.DailyQuota
		delay = math.Max(delay, vendor.RetryAfter)
	}
	logx.Warn("Background job failed", logx.Fields{"type": "evaluate_answer", "jobId": job.JobID, "error": err.Error()})
	if failErr := s.asking.FailJob(runCtx, job.JobID, err.Error(), delay, permanent); failErr != nil && !errors.Is(failErr, context.Canceled) {
		logx.Warn("Could not record the job failure", logx.Fields{"error": failErr.Error()})
	}
	return false
}

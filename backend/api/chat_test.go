package api

// Asking questions against a real database with a fake model vendor: the scenarios
// tests/http.test.ts and tests/services.test.ts covered for the TypeScript chat route.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/ankityadav1asia/Corpus/backend/ai"
	"github.com/ankityadav1asia/Corpus/backend/rag"
)

// fakeAI embeds text as a bag of words, grades passages by shared words, and answers in two
// pieces. It counts its calls so tests can check what was (not) asked.
type fakeAI struct {
	lastFast   atomic.Bool
	lastTurns  atomic.Int32
	planned    atomic.Int32
	failRerank bool
	chats      atomic.Int32
	judged     atomic.Int32
	followups  atomic.Int32
	failChat   *ai.Error
}

func (f *fakeAI) ChatModel() string      { return "fake-chat" }
func (f *fakeAI) EmbeddingModel() string { return "gemini-embedding-001" }

func words(text string) []string {
	return strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9') })
}

func bagOfWords(text string) []float64 {
	vector := make([]float64, ai.EmbeddingDimensions)
	for _, word := range words(text) {
		h := fnv.New32a()
		h.Write([]byte(word))
		vector[h.Sum32()%ai.EmbeddingDimensions]++
	}
	norm := 0.0
	for _, v := range vector {
		norm += v * v
	}
	if norm == 0 {
		vector[0] = 1
		return vector
	}
	for i := range vector {
		vector[i] /= math.Sqrt(norm)
	}
	return vector
}

func (f *fakeAI) EmbedQueries(_ context.Context, texts []string) ([][]float64, error) {
	out := make([][]float64, len(texts))
	for i, text := range texts {
		out[i] = bagOfWords(text)
	}
	return out, nil
}

func (f *fakeAI) EmbedDocuments(ctx context.Context, texts []string) ([][]float64, error) {
	return f.EmbedQueries(ctx, texts)
}

func (f *fakeAI) StreamChat(_ context.Context, _ string, turns []ai.Turn, fast bool, emit func(string) error) error {
	f.chats.Add(1)
	f.lastFast.Store(fast)
	f.lastTurns.Store(int32(len(turns)))
	if err := emit("Answer from "); err != nil {
		return err
	}
	if f.failChat != nil {
		return f.failChat
	}
	return emit("sources [1].")
}

func (f *fakeAI) Complete(_ context.Context, input ai.Completion) (string, error) {
	if !input.Fast {
		return "", fmt.Errorf("helper calls must be fast: %.40s", input.System)
	}
	switch {
	case input.System == rag.LLMRerankSystem && f.failRerank:
		return "", &ai.Error{Message: "Gemini request failed (503)", Status: 503}
	case input.System == rag.LLMRerankSystem:
		// Score 9 when the passage shares a word of five letters or more with the question.
		question := strings.SplitN(strings.TrimPrefix(input.Prompt, "Question: "), "\n", 2)[0]
		scores := []string{}
		for i, passage := range strings.Split(input.Prompt, "<passage id=")[1:] {
			score := 1
			for _, word := range words(question) {
				if len(word) >= 5 && strings.Contains(strings.ToLower(passage), word) {
					score = 9
				}
			}
			scores = append(scores, fmt.Sprintf(`{"id":%d,"score":%d}`, i+1, score))
		}
		return "[" + strings.Join(scores, ",") + "]", nil
	case input.System == rag.JudgeSystem:
		f.judged.Add(1)
		return `{"claims":[{"claim":"a","supported":true},{"claim":"b","supported":false}],"answer_relevance":5,"passages":[{"id":1,"relevant":true}]}`, nil
	case strings.HasPrefix(input.System, "You generate search queries"):
		f.planned.Add(1)
		return `["codename of the project", "project name", "what is the codename"]`, nil
	case input.System == rag.StepBackSystem:
		f.planned.Add(1)
		return `{"question": "How are projects named?"}`, nil
	case input.System == rag.HydeSystem:
		f.planned.Add(1)
		return "The project codename is a bird name chosen by the team for secrecy.", nil
	case input.System == rag.FollowupSystem:
		f.followups.Add(1)
		return `{"questions":["Who chose the codename?","When was it chosen?","Is it still secret?"]}`, nil
	}
	return "[]", nil
}

func (e *env) useFakeAI(t *testing.T) *fakeAI {
	fake := &fakeAI{}
	previous := models
	models = func() (ai.Provider, rag.Reranker, error) { return fake, rag.NewLLMReranker(fake), nil }
	previousRandom := randomFloat
	randomFloat = func() float64 { return 0 }
	t.Cleanup(func() { models, randomFloat = previous, previousRandom })
	return fake
}

// document stores a ready document with one chunk per text in the notebook.
func (e *env) document(owner actor, notebook, title string, chunks ...string) {
	e.t.Helper()
	ctx := context.Background()
	id, err := e.db.QueryString(ctx, `INSERT INTO app.documents (workspace_id, collection_id, created_by, source_type, source, title, status, chunk_count, char_count)
		VALUES ($1, $2, $3, 'text', $4, $4, 'ready', $5, 10) RETURNING id::text`, owner.workspaceID, notebook, owner.id, title, len(chunks))
	if err != nil {
		e.t.Fatal(err)
	}
	for i, text := range chunks {
		vector, _ := json.Marshal(bagOfWords(text))
		if err := e.db.Exec(ctx, `INSERT INTO app.chunks (document_id, workspace_id, collection_id, chunk_index, content, embedding, embedding_model) VALUES ($1, $2, $3, $4, $5, $6::vector, 'gemini-embedding-001')`,
			id, owner.workspaceID, notebook, i, text, string(vector)); err != nil {
			e.t.Fatal(err)
		}
	}
}

// events reads an NDJSON body.
func events(t *testing.T, body string) []map[string]any {
	t.Helper()
	list := []map[string]any{}
	scanner := bufio.NewScanner(strings.NewReader(body))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var event map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatalf("not one JSON event per line: %q", scanner.Text())
		}
		list = append(list, event)
	}
	return list
}

func types(list []map[string]any) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, event := range list {
		kind := event["type"].(string)
		if !seen[kind] {
			seen[kind] = true
			out = append(out, kind)
		}
	}
	return out
}

func notebookOf(e *env, who actor) string {
	id, err := e.db.QueryString(context.Background(), `SELECT id::text FROM app.collections WHERE workspace_id = $1 LIMIT 1`, who.workspaceID)
	if err != nil {
		e.t.Fatal(err)
	}
	return id
}

func TestChatStreamsAnAnswerWithSourcesAndScoresIt(t *testing.T) {
	e := setup(t)
	fake := e.useFakeAI(t)
	alice := e.user(unique("alice") + "@example.com")
	notebook := notebookOf(e, alice)
	e.document(alice, notebook, "Secret plan", "The codename of the project is Bluebird.", "Lunch is served at noon.")

	w, _ := e.do(&alice, call{method: "POST", path: "/api/chat", body: fmt.Sprintf(`{"message":"What is the codename?","collectionId":%q}`, notebook)})
	e.expect(w, 200)
	if contentType := w.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/x-ndjson") {
		t.Fatalf("content type %q", contentType)
	}
	list := events(t, w.Body.String())
	if got := strings.Join(types(list), ","); got != "start,status,sources,delta,done" {
		t.Fatalf("event types = %s\n%s", got, w.Body.String())
	}
	start, sources, done := list[0], list[2], list[len(list)-1]
	if start["createdConversation"] != true || start["conversationTitle"] != "What is the codename?" {
		t.Fatalf("start = %v", start)
	}
	citations := sources["citations"].([]any)
	first := citations[0].(map[string]any)
	if first["title"] != "Secret plan" || first["relevance"] != 0.9 || first["index"] != 1.0 {
		t.Fatalf("sources = %v", sources)
	}
	if steps := sources["steps"].([]any); steps[len(steps)-1].(map[string]any)["label"] != "Relevance check" {
		t.Fatalf("steps = %v", steps)
	}
	conversation := start["conversationId"].(string)
	answer := done["assistantMessageId"].(string)
	stored, err := e.db.QueryString(context.Background(), `SELECT content FROM app.messages WHERE id = $1`, answer)
	if err != nil || stored != "Answer from sources [1]." {
		t.Fatalf("stored answer %q %v", stored, err)
	}
	status, err := e.db.QueryString(context.Background(), `SELECT status FROM app.query_logs WHERE owner_id = $1`, alice.id)
	if err != nil || status != "ok" {
		t.Fatalf("query log %q %v", status, err)
	}

	// The evaluation was queued; the client's poll of the conversation runs it.
	w, body := e.do(&alice, call{path: "/api/conversations/" + conversation})
	e.expect(w, 200)
	messages := body["messages"].([]any)
	evaluation, ok := messages[1].(map[string]any)["evaluation"].(map[string]any)
	if !ok || evaluation["faithfulness"] != 0.5 || evaluation["answerRelevance"] != 1.0 || fake.judged.Load() != 1 {
		t.Fatalf("evaluation = %v (judged %d)", messages[1], fake.judged.Load())
	}
	job, err := e.db.QueryString(context.Background(), `SELECT status FROM app.jobs WHERE type = 'evaluate_answer' AND payload->>'messageId' = $1`, answer)
	if err != nil || job != "completed" {
		t.Fatalf("job %q %v", job, err)
	}

	// Follow-ups are generated once, then served from the message.
	path := "/api/messages/" + answer + "/followups"
	for round := 0; round < 2; round++ {
		w, body = e.do(&alice, call{method: "POST", path: path})
		e.expect(w, 200)
		if suggestions := body["followups"].([]any); len(suggestions) != 3 || suggestions[0] != "Who chose the codename?" {
			t.Fatalf("follow-ups = %v", body)
		}
	}
	if fake.followups.Load() != 1 {
		t.Fatalf("follow-ups were generated %d times", fake.followups.Load())
	}

	// A follow-up question continues the thread with its history.
	w, _ = e.do(&alice, call{method: "POST", path: "/api/chat", body: fmt.Sprintf(`{"message":"And the codename again?","conversationId":%q}`, conversation)})
	e.expect(w, 200)
	if list := events(t, w.Body.String()); list[0]["createdConversation"] != false || list[0]["conversationId"] != conversation {
		t.Fatalf("follow-up start = %v", list[0])
	}
}

func TestChatWithholdsAnswersWithoutRelevantSources(t *testing.T) {
	e := setup(t)
	fake := e.useFakeAI(t)
	alice := e.user(unique("alice") + "@example.com")
	notebook := notebookOf(e, alice)
	e.document(alice, notebook, "Secret plan", "The codename of the project is Bluebird.")

	w, _ := e.do(&alice, call{method: "POST", path: "/api/chat", body: `{"message":"Who won the football league yesterday?"}`})
	e.expect(w, 200)
	list := events(t, w.Body.String())
	var text strings.Builder
	for _, event := range list {
		if event["type"] == "delta" {
			text.WriteString(event["text"].(string))
		}
	}
	if text.String() != InsufficientContextMessage || fake.chats.Load() != 0 {
		t.Fatalf("answer %q, model called %d times", text.String(), fake.chats.Load())
	}
	status, _ := e.db.QueryString(context.Background(), `SELECT status FROM app.query_logs WHERE owner_id = $1`, alice.id)
	if status != "insufficient_context" {
		t.Fatalf("query log = %q", status)
	}
	answer := list[len(list)-1]["assistantMessageId"].(string)
	w, body := e.do(&alice, call{method: "POST", path: "/api/messages/" + answer + "/followups"})
	e.expect(w, 200)
	if len(body["followups"].([]any)) != 0 || fake.followups.Load() != 0 {
		t.Fatalf("no follow-ups for a withheld answer: %v", body)
	}
}

func TestChatRequestChecks(t *testing.T) {
	e := setup(t)
	e.useFakeAI(t)
	alice := e.user(unique("alice") + "@example.com")
	bob := e.user(unique("bob") + "@example.com")
	for _, bad := range []string{`{"message":""}`, `{"message":"` + strings.Repeat("x", 5000) + `"}`, `{"message":"hi","mode":"fast"}`, `{"message":"hi","collectionId":"nope"}`} {
		w, body := e.do(&alice, call{method: "POST", path: "/api/chat", body: bad})
		e.expect(w, 400)
		if code(body) != "VALIDATION_FAILED" {
			t.Fatalf("%.60s → %v", bad, body)
		}
	}
	w, _ := e.do(&alice, call{method: "POST", path: "/api/chat", body: fmt.Sprintf(`{"message":"hi","collectionId":%q}`, notebookOf(e, bob))})
	e.expect(w, 404) // another workspace's notebook
	w, _ = e.do(&bob, call{method: "POST", path: "/api/chat", workspace: alice.workspaceID, body: `{"message":"hi"}`})
	e.expect(w, 404) // not a member
	w, _ = e.do(&alice, call{method: "POST", path: "/api/chat", body: `{"message":"hi"}`, origin: "https://evil.example"})
	e.expect(w, 403)
}

func TestChatSurfacesVendorFailuresAndKeepsThePartialAnswer(t *testing.T) {
	e := setup(t)
	fake := e.useFakeAI(t)
	fake.failChat = &ai.Error{Message: "Gemini request failed (429)", Status: 429, DailyQuota: true}
	alice := e.user(unique("alice") + "@example.com")
	e.document(alice, notebookOf(e, alice), "Secret plan", "The codename of the project is Bluebird.")

	w, _ := e.do(&alice, call{method: "POST", path: "/api/chat", body: `{"message":"What is the codename?"}`})
	e.expect(w, 200)
	list := events(t, w.Body.String())
	last := list[len(list)-1]
	if last["type"] != "error" || last["message"] != ai.DailyQuotaMessage {
		t.Fatalf("last event = %v", last)
	}
	partial, err := e.db.QueryString(context.Background(), `SELECT content FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id WHERE c.owner_id = $1 AND m.role = 'assistant'`, alice.id)
	if err != nil || partial != "Answer from " {
		t.Fatalf("partial answer %q %v", partial, err)
	}
	status, _ := e.db.QueryString(context.Background(), `SELECT status FROM app.query_logs WHERE owner_id = $1`, alice.id)
	if status != "error" {
		t.Fatalf("query log = %q", status)
	}
}

func TestDeepModeExpandsTheQuestionAndStandardModeSkipsThinking(t *testing.T) {
	e := setup(t)
	fake := e.useFakeAI(t)
	alice := e.user(unique("alice") + "@example.com")
	e.document(alice, notebookOf(e, alice), "Secret plan", "The codename of the project is Bluebird.")

	w, _ := e.do(&alice, call{method: "POST", path: "/api/chat", body: `{"message":"What is the codename?"}`})
	e.expect(w, 200)
	if !fake.lastFast.Load() || fake.planned.Load() != 0 {
		t.Fatalf("standard mode: fast %v, planned %d", fake.lastFast.Load(), fake.planned.Load())
	}
	w, _ = e.do(&alice, call{method: "POST", path: "/api/chat", body: `{"message":"What is the codename?","mode":"deep"}`})
	e.expect(w, 200)
	list := events(t, w.Body.String())
	if list[1]["stage"] != "planning" || fake.lastFast.Load() || fake.planned.Load() != 3 {
		t.Fatalf("deep mode: %v, fast %v, planned %d", list[1], fake.lastFast.Load(), fake.planned.Load())
	}
	labels := []string{}
	for _, step := range list[2]["steps"].([]any) {
		labels = append(labels, step.(map[string]any)["label"].(string))
	}
	if strings.Join(labels, ",") != "Query expansion,Step-back question,Hypothetical answer (HyDE),Retrieved,Re-ranked,Relevance check" {
		t.Fatalf("deep steps = %v", labels)
	}
}

func TestChatFallsBackToSimilarityWhenTheRerankerFails(t *testing.T) {
	e := setup(t)
	fake := e.useFakeAI(t)
	fake.failRerank = true
	alice := e.user(unique("alice") + "@example.com")
	e.document(alice, notebookOf(e, alice), "Secret plan", "The codename of the project is Bluebird.")

	w, _ := e.do(&alice, call{method: "POST", path: "/api/chat", body: `{"message":"What is the codename of the project?"}`})
	e.expect(w, 200)
	list := events(t, w.Body.String())
	sources := list[3]
	if sources["type"] != "sources" {
		sources = list[2]
	}
	steps := sources["steps"].([]any)
	if detail := steps[1].(map[string]any)["detail"].(string); !strings.Contains(detail, "unavailable") {
		t.Fatalf("re-rank step = %v", steps)
	}
	if first := sources["citations"].([]any)[0].(map[string]any); first["relevance"] != nil || first["similarity"] == nil {
		t.Fatalf("judged by similarity: %v", first)
	}
	if fake.chats.Load() != 1 {
		t.Fatal("the answer is still written")
	}
}

func TestFollowupsAreForTheAuthorOnly(t *testing.T) {
	e := setup(t)
	e.useFakeAI(t)
	ada := e.user(unique("ada") + "@example.com")
	ed := e.user(unique("ed") + "@example.com")
	team, notebook := e.team(ada, "Team")
	e.join(team, ed, "editor")
	ada.workspaceID, ed.workspaceID = team, team
	e.document(ed, notebook, "Secret plan", "The codename of the project is Bluebird.")
	w, _ := e.do(&ed, call{method: "POST", path: "/api/chat", body: `{"message":"What is the codename?"}`})
	list := events(t, w.Body.String())
	answer := list[len(list)-1]["assistantMessageId"].(string)
	w, _ = e.do(&ada, call{method: "POST", path: "/api/messages/" + answer + "/followups"})
	e.expect(w, 404)
}

func TestDemoGuestsAskWithinTheirAllowance(t *testing.T) {
	e := setup(t)
	fake := e.useFakeAI(t)
	ada := e.user(unique("ada") + "@example.com")
	team, notebook := e.team(ada, "Demo")
	ada.workspaceID = team
	e.document(ada, notebook, "Secret plan", "The codename of the project is Bluebird.")
	guest := e.user(unique("guest") + "@demo.invalid")
	e.join(team, guest, "viewer")
	guest.workspaceID = team
	t.Setenv("DEMO_WORKSPACE_ID", team)
	t.Setenv("DEMO_DAILY_QUESTIONS", "2")
	// Each run gets its own daily bucket.
	if err := e.db.Exec(context.Background(), `DELETE FROM app.rate_limits WHERE key LIKE 'demo:questions:%'`); err != nil {
		t.Fatal(err)
	}

	w, _ := e.do(&guest, call{method: "POST", path: "/api/chat", body: `{"message":"What is the codename?"}`})
	e.expect(w, 200)
	list := events(t, w.Body.String())
	answer := list[len(list)-1]["assistantMessageId"].(string)
	w, body := e.do(&guest, call{method: "POST", path: "/api/messages/" + answer + "/followups"})
	e.expect(w, 200)
	if len(body["followups"].([]any)) != 0 || fake.followups.Load() != 0 {
		t.Fatalf("guests spend no model calls on suggestions: %v", body)
	}
	w, _ = e.do(&guest, call{method: "POST", path: "/api/chat", body: `{"message":"And again?"}`})
	e.expect(w, 200)
	w, body = e.do(&guest, call{method: "POST", path: "/api/chat", body: `{"message":"One more?"}`})
	e.expect(w, 429)
	if code(body) != "DEMO_LIMIT" || !strings.Contains(message(body), "today") {
		t.Fatalf("third question = %v", body)
	}
	t.Setenv("DEMO_WORKSPACE_ID", "")
	w, body = e.do(&guest, call{method: "POST", path: "/api/chat", body: `{"message":"Closed?"}`})
	e.expect(w, 404) // the demo is closed
}

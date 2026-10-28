package ai

import (
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"

	"github.com/ankityadav1asia/Corpus/backend/apperr"
)

// Model configuration from the environment, with the names and rules of server/env.ts, so the Go
// and TypeScript code read one set of Vercel environment variables.

const (
	defaultChatModel      = "gemini-3.6-flash"
	defaultEmbeddingModel = "gemini-embedding-001"
)

type getenv func(string) string

func value(get getenv, name string) string { return strings.TrimSpace(get(name)) }

var placeholder = regexp.MustCompile(`(?i)\.\.\.|^your[-_]`)

// geminiAPIKey is GOOGLE_API_KEY or GEMINI_API_KEY, ignoring placeholders.
func geminiAPIKey(get getenv) string {
	key := value(get, "GOOGLE_API_KEY")
	if key == "" {
		key = value(get, "GEMINI_API_KEY")
	}
	if len(key) < 20 || placeholder.MatchString(key) {
		return ""
	}
	return key
}

type backend struct {
	gemini  bool
	apiKey  string
	baseURL string
	model   string
}

func chosen(get getenv, name string) bool {
	return strings.ToLower(value(get, name)) == "openai-compatible"
}

func compatible(get getenv, model, modelVariable, label, baseOverride string) (backend, error) {
	if model == "" {
		return backend{}, apperr.NotConfigured(label + "=openai-compatible requires " + modelVariable + ".")
	}
	base := baseOverride
	if base == "" {
		base = value(get, "OPENAI_COMPATIBLE_BASE_URL")
	}
	if base == "" {
		return backend{}, apperr.NotConfigured(label + "=openai-compatible requires OPENAI_COMPATIBLE_BASE_URL (e.g. http://localhost:11434/v1 for Ollama).")
	}
	if parsed, err := url.Parse(base); err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return backend{}, apperr.NotConfigured("The base URL for " + label + " is not a valid http(s) URL.")
	}
	return backend{baseURL: base, apiKey: value(get, "OPENAI_COMPATIBLE_API_KEY"), model: model}, nil
}

func geminiBackend(get getenv, model, label string) (backend, error) {
	key := geminiAPIKey(get)
	if key == "" {
		return backend{}, apperr.NotConfigured("AI is not configured. Set GOOGLE_API_KEY on the server, or " + label + "=openai-compatible for an open-source model server.")
	}
	return backend{gemini: true, apiKey: key, model: model}, nil
}

func chatBackend(get getenv) (backend, error) {
	if chosen(get, "CHAT_PROVIDER") {
		return compatible(get, value(get, "OPENAI_COMPATIBLE_CHAT_MODEL"), "OPENAI_COMPATIBLE_CHAT_MODEL", "CHAT_PROVIDER", "")
	}
	model := value(get, "GEMINI_CHAT_MODEL")
	if model == "" {
		model = defaultChatModel
	}
	return geminiBackend(get, model, "CHAT_PROVIDER")
}

func embeddingBackend(get getenv) (backend, error) {
	if chosen(get, "EMBEDDING_PROVIDER") {
		return compatible(get, value(get, "OPENAI_COMPATIBLE_EMBEDDING_MODEL"), "OPENAI_COMPATIBLE_EMBEDDING_MODEL", "EMBEDDING_PROVIDER", value(get, "OPENAI_COMPATIBLE_EMBEDDING_BASE_URL"))
	}
	model := value(get, "GEMINI_EMBEDDING_MODEL")
	if model == "" {
		model = defaultEmbeddingModel
	}
	return geminiBackend(get, model, "EMBEDDING_PROVIDER")
}

func fastModel(get getenv) string {
	if chosen(get, "CHAT_PROVIDER") {
		return value(get, "OPENAI_COMPATIBLE_FAST_MODEL")
	}
	return value(get, "GEMINI_FAST_MODEL")
}

func build(get getenv) (Provider, error) {
	chat, err := chatBackend(get)
	if err != nil {
		return nil, err
	}
	embeddings, err := embeddingBackend(get)
	if err != nil {
		return nil, err
	}
	fast := fastModel(get)
	if chat.gemini && embeddings.gemini && chat.apiKey == embeddings.apiKey {
		return NewGemini(GeminiConfig{APIKey: chat.apiKey, ChatModel: chat.model, EmbeddingModel: embeddings.model, FastModel: fast}), nil
	}
	var chatProvider, embeddingProvider Provider
	if chat.gemini {
		chatProvider = NewGemini(GeminiConfig{APIKey: chat.apiKey, ChatModel: chat.model, FastModel: fast})
	} else {
		chatProvider = NewOpenAIChat(OpenAIConfig{BaseURL: chat.baseURL, APIKey: chat.apiKey, Model: chat.model, FastModel: fast})
	}
	if embeddings.gemini {
		embeddingProvider = NewGemini(GeminiConfig{APIKey: embeddings.apiKey, EmbeddingModel: embeddings.model})
	} else {
		embeddingProvider = NewOpenAIEmbeddings(OpenAIConfig{BaseURL: embeddings.baseURL, APIKey: embeddings.apiKey, Model: embeddings.model})
	}
	return Combine(chatProvider, embeddingProvider), nil
}

// RerankerKind is the configured re-ranker: "cohere", "llm" or "none".
type RerankerConfig struct {
	Kind   string
	APIKey string
	Model  string
}

// Reranker is RERANKER=auto (Cohere when COHERE_API_KEY is set, else the LLM grader), or a
// forced choice of cohere, llm or none.
func rerankerConfig(get getenv) (RerankerConfig, error) {
	choice := strings.ToLower(value(get, "RERANKER"))
	if choice == "" {
		choice = "auto"
	}
	switch {
	case choice == "none":
		return RerankerConfig{Kind: "none"}, nil
	case choice == "llm":
		return RerankerConfig{Kind: "llm"}, nil
	case value(get, "COHERE_API_KEY") != "" && (choice == "cohere" || choice == "auto"):
		model := value(get, "COHERE_RERANK_MODEL")
		if model == "" {
			model = "rerank-v3.5"
		}
		return RerankerConfig{Kind: "cohere", APIKey: value(get, "COHERE_API_KEY"), Model: model}, nil
	case choice == "cohere":
		return RerankerConfig{}, apperr.NotConfigured("RERANKER=cohere requires COHERE_API_KEY.")
	}
	return RerankerConfig{Kind: "llm"}, nil
}

var (
	cacheOnce     sync.Once
	cachedModels  Provider
	cachedErr     error
	cachedRerank  RerankerConfig
	cachedRankErr error
)

// FromEnv is the process-wide provider and re-ranker configuration (built once per instance, so
// the query-embedding cache and thinking fallbacks persist between requests).
func FromEnv() (Provider, RerankerConfig, error) {
	cacheOnce.Do(func() {
		cachedModels, cachedErr = build(os.Getenv)
		cachedRerank, cachedRankErr = rerankerConfig(os.Getenv)
	})
	if cachedErr != nil {
		return nil, RerankerConfig{}, cachedErr
	}
	return cachedModels, cachedRerank, cachedRankErr
}

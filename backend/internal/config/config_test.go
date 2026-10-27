package config

import (
	"strings"
	"testing"

	"github.com/ankityadav1asia/Corpus/backend/internal/apperr"
)

func env(values map[string]string) getenv {
	return func(name string) string { return values[name] }
}

var secret = strings.Repeat("s", 40)

func TestSecretsAreTheKeyRing(t *testing.T) {
	cfg := load(env(map[string]string{"AUTH_SECRET": secret, "AUTH_SECRET_PREVIOUS": strings.Repeat("p", 40)}))
	if len(cfg.Secrets) != 2 || cfg.Secrets[0] != secret {
		t.Fatalf("secrets = %v", cfg.Secrets)
	}
	short := load(env(map[string]string{"AUTH_SECRET": "short", "AUTH_SECRET_PREVIOUS": secret}))
	if len(short.Secrets) != 0 {
		t.Fatalf("a short AUTH_SECRET must not be accepted: %v", short.Secrets)
	}
	same := load(env(map[string]string{"AUTH_SECRET": secret, "AUTH_SECRET_PREVIOUS": "  " + secret + " "}))
	if len(same.Secrets) != 1 {
		t.Fatalf("a previous secret equal to the current one is ignored: %v", same.Secrets)
	}
}

func TestAppURLFollowsVercel(t *testing.T) {
	cases := []struct {
		env  map[string]string
		want string
	}{
		{map[string]string{"APP_URL": "https://corpus.example"}, "https://corpus.example"},
		{map[string]string{"VERCEL": "1", "VERCEL_ENV": "production", "VERCEL_PROJECT_PRODUCTION_URL": "corpusragagent.vercel.app", "VERCEL_URL": "x.vercel.app"}, "https://corpusragagent.vercel.app"},
		{map[string]string{"VERCEL": "1", "VERCEL_ENV": "preview", "VERCEL_BRANCH_URL": "branch.vercel.app", "VERCEL_URL": "x.vercel.app"}, "https://branch.vercel.app"},
		{map[string]string{"VERCEL": "1", "VERCEL_URL": "x.vercel.app"}, "https://x.vercel.app"},
		{map[string]string{}, ""},
	}
	for _, c := range cases {
		if got := load(env(c.env)).AppURL; got != c.want {
			t.Errorf("AppURL(%v) = %q, want %q", c.env, got, c.want)
		}
	}
}

func TestCoreErrorNamesWhatIsMissing(t *testing.T) {
	err, ok := apperr.As(load(env(map[string]string{})).CoreError())
	if !ok || err.Status != 503 || !strings.Contains(err.Message, "POSTGRES_URL, AUTH_SECRET (min 32 chars)") {
		t.Fatalf("CoreError = %v", err)
	}
	if load(env(map[string]string{"POSTGRES_URL": "postgres://x", "AUTH_SECRET": secret})).CoreError() != nil {
		t.Fatal("complete configuration reported as missing")
	}
}

func TestProductionRefusesUnsafeSettings(t *testing.T) {
	bad := load(env(map[string]string{"VERCEL": "1", "POSTGRES_URL": "pglite:./.data/x"}))
	if problems := bad.StartupProblems(); len(problems) != 3 {
		t.Fatalf("problems = %v", problems)
	}
	good := load(env(map[string]string{"VERCEL": "1", "VERCEL_ENV": "production", "VERCEL_PROJECT_PRODUCTION_URL": "a.vercel.app", "POSTGRES_URL": "postgres://db", "AUTH_SECRET": secret}))
	if problems := good.StartupProblems(); len(problems) != 0 {
		t.Fatalf("problems = %v", problems)
	}
	if problems := load(env(map[string]string{})).StartupProblems(); problems != nil {
		t.Fatalf("development has no startup problems, got %v", problems)
	}
}

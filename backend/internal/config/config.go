// Package config reads the backend's settings from the environment, with the same names and
// rules as server/env.ts, so both backends share one set of Vercel environment variables.
package config

import (
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/ankityadav1asia/Corpus/backend/internal/apperr"
)

const MinSecretLength = 32

type Config struct {
	PostgresURL string
	// Secrets are the accepted AUTH_SECRET keys, current first (AUTH_SECRET_PREVIOUS during a rotation).
	Secrets []string
	// AppURL is the public origin: APP_URL, or on Vercel the deployment's own address.
	AppURL     string
	Port       string
	Production bool
	Vercel     bool
}

type getenv func(string) string

// value treats unset, empty and whitespace-only variables the same way, like server/env.ts.
func value(get getenv, name string) string { return strings.TrimSpace(get(name)) }

// Load reads the process environment.
func Load() Config { return load(os.Getenv) }

func load(get getenv) Config {
	cfg := Config{
		PostgresURL: value(get, "POSTGRES_URL"),
		Port:        value(get, "PORT"),
		Vercel:      value(get, "VERCEL") != "",
	}
	if cfg.Port == "" {
		cfg.Port = "8080"
	}
	// Deployed builds (Vercel production and previews) run with NODE_ENV=production on the
	// Next.js side; the Go side treats any Vercel deployment, or APP_ENV=production, the same way.
	cfg.Production = cfg.Vercel || value(get, "APP_ENV") == "production" || value(get, "NODE_ENV") == "production"
	if current := value(get, "AUTH_SECRET"); len(current) >= MinSecretLength {
		cfg.Secrets = []string{current}
		if previous := value(get, "AUTH_SECRET_PREVIOUS"); len(previous) >= MinSecretLength && previous != current {
			cfg.Secrets = append(cfg.Secrets, previous)
		}
	}
	cfg.AppURL = appURL(get)
	return cfg
}

func appURL(get getenv) string {
	if explicit := value(get, "APP_URL"); explicit != "" {
		return explicit
	}
	if value(get, "VERCEL") == "" {
		return ""
	}
	host := value(get, "VERCEL_URL")
	if value(get, "VERCEL_ENV") == "production" {
		host = value(get, "VERCEL_PROJECT_PRODUCTION_URL")
	} else if branch := value(get, "VERCEL_BRANCH_URL"); branch != "" {
		host = branch
	}
	if host == "" {
		return ""
	}
	return "https://" + host
}

// CoreError is the 503 a request gets when required settings are missing (getCoreEnv).
func (c Config) CoreError() error {
	var missing []string
	if c.PostgresURL == "" {
		missing = append(missing, "POSTGRES_URL")
	}
	if len(c.Secrets) == 0 {
		missing = append(missing, fmt.Sprintf("AUTH_SECRET (min %d chars)", MinSecretLength))
	}
	if len(missing) == 0 {
		return nil
	}
	return apperr.NotConfigured("Server is missing required configuration: " + strings.Join(missing, ", "))
}

// StartupProblems lists what stops a production server from starting (server/config-check.ts).
func (c Config) StartupProblems() []string {
	if !c.Production {
		return nil
	}
	var problems []string
	if len(c.Secrets) == 0 {
		problems = append(problems, fmt.Sprintf("AUTH_SECRET must be set to at least %d characters.", MinSecretLength))
	}
	if c.PostgresURL == "" {
		problems = append(problems, "POSTGRES_URL must point to a PostgreSQL database.")
	} else if strings.HasPrefix(strings.ToLower(c.PostgresURL), "pglite:") {
		problems = append(problems, "POSTGRES_URL points to PGlite, which is for local development only.")
	}
	if parsed, err := url.Parse(c.AppURL); c.AppURL == "" || err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		problems = append(problems, "APP_URL must be the public https address of the app (it is derived automatically on Vercel).")
	}
	return problems
}

// Package handler is the Vercel Go Function that serves the API paths moved to Go. next.config.mjs
// rewrites each of those paths here (GO_API_PATHS); the request keeps its original path, which
// backend/api routes on.
package handler

import (
	"context"
	"net/http"
	"strings"
	"sync"

	"github.com/ankityadav1asia/Corpus/backend/api"
	"github.com/ankityadav1asia/Corpus/backend/apperr"
	"github.com/ankityadav1asia/Corpus/backend/config"
	"github.com/ankityadav1asia/Corpus/backend/httpx"
	"github.com/ankityadav1asia/Corpus/backend/logx"
	"github.com/ankityadav1asia/Corpus/backend/store"
)

var (
	once    sync.Once
	handler http.Handler
	setup   error
)

// build runs once per function instance; the connection pool is reused by later requests.
func build() {
	cfg := config.Load()
	if problems := cfg.StartupProblems(); len(problems) > 0 {
		logx.Warn("Go API configuration is incomplete", logx.Fields{"problems": strings.Join(problems, " ")})
		setup = apperr.NotConfigured("Server is missing required configuration.")
		return
	}
	var db api.Store
	if cfg.PostgresURL != "" {
		opened, err := store.Open(context.Background(), cfg.PostgresURL, 4)
		if err != nil {
			logx.Error("Could not open the database pool", err, nil)
			setup = apperr.NotConfigured("Server is missing required configuration.")
			return
		}
		db = opened
	}
	handler = api.New(cfg, db).Handler()
}

// Handler is the function's entry point.
func Handler(w http.ResponseWriter, r *http.Request) {
	once.Do(build)
	if setup != nil {
		httpx.WriteError(w, r, httpx.NewRequestID(), setup)
		return
	}
	handler.ServeHTTP(w, r)
}

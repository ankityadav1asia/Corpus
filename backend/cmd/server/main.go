// Command server runs the Corpus Go API.
//
//	POSTGRES_URL=… AUTH_SECRET=… go run ./cmd/server     (PORT, default 8080)
//
// It shares the Next.js app's database, session cookie and AUTH_SECRET, so a user signed in on
// the Next.js side is signed in here too.
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/ankityadav1asia/Corpus/backend/internal/api"
	"github.com/ankityadav1asia/Corpus/backend/internal/config"
	"github.com/ankityadav1asia/Corpus/backend/internal/core"
	"github.com/ankityadav1asia/Corpus/backend/internal/logx"
	"github.com/ankityadav1asia/Corpus/backend/internal/store"
)

func main() {
	if err := run(); err != nil {
		logx.Error("Server stopped", err, nil)
		os.Exit(1)
	}
}

func run() error {
	cfg := config.Load()
	if problems := cfg.StartupProblems(); len(problems) > 0 {
		// Refuse to start with unsafe settings instead of failing later, per request.
		return errors.New("Configuration: " + strings.Join(problems, " "))
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	rag, err := core.New(ctx)
	if err != nil {
		return err
	}
	defer rag.Close(context.Background())
	// Loading the Rust core at start proves the embedded module works; routes that need it (search,
	// chat) arrive in the next migration step.
	version, err := rag.Version(ctx)
	if err != nil {
		return err
	}

	var db api.Store
	if cfg.PostgresURL != "" {
		opened, err := store.Open(ctx, cfg.PostgresURL, 4)
		if err != nil {
			return err
		}
		defer opened.Close()
		db = opened
	} else {
		logx.Warn("POSTGRES_URL is not set: database routes answer 503", nil)
	}

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           api.New(cfg, db, version).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      300 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	errs := make(chan error, 1)
	go func() { errs <- server.ListenAndServe() }()
	logx.Info("Corpus Go API listening", logx.Fields{"port": cfg.Port, "core": version, "production": cfg.Production})

	select {
	case err := <-errs:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		// SIGTERM: finish in-flight requests, accept no new ones.
		shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	}
	return nil
}

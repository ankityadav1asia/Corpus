// Command dev runs the Go API on a local port for development: `npm run go:dev`, then start
// Next.js with GO_API_URL=http://localhost:8080 so it proxies the Go paths here. On Vercel the same
// handler runs as a Go Function (api/go.go).
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

	"github.com/ankityadav1asia/Corpus/backend/api"
	"github.com/ankityadav1asia/Corpus/backend/config"
	"github.com/ankityadav1asia/Corpus/backend/logx"
	"github.com/ankityadav1asia/Corpus/backend/store"
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
		return errors.New("Configuration: " + strings.Join(problems, " "))
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

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
		Handler:           api.New(cfg, db).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      300 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	errs := make(chan error, 1)
	go func() { errs <- server.ListenAndServe() }()
	logx.Info("Corpus Go API listening", logx.Fields{"port": cfg.Port})

	select {
	case err := <-errs:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	}
	return nil
}

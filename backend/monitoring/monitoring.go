// Package monitoring reports the Go API's errors to Sentry when SENTRY_DSN (or the browser's
// NEXT_PUBLIC_SENTRY_DSN) is set: errors logged with logx.Error and recovered panics. Like the
// TypeScript side (lib/sentry.ts), no request data, users or local variables are sent.
package monitoring

import (
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/getsentry/sentry-go"

	"github.com/ankityadav1asia/Corpus/backend/httpx"
	"github.com/ankityadav1asia/Corpus/backend/logx"
)

// Init starts reporting; it does nothing without a DSN. Serverless instances may freeze right
// after a response, so events are sent synchronously.
func Init(getenv func(string) string) {
	dsn := getenv("SENTRY_DSN")
	if dsn == "" {
		dsn = getenv("NEXT_PUBLIC_SENTRY_DSN")
	}
	if dsn == "" {
		return
	}
	environment := getenv("VERCEL_ENV")
	if environment == "" {
		environment = "development"
	}
	err := sentry.Init(sentry.ClientOptions{
		Dsn:            dsn,
		Environment:    environment,
		Release:        getenv("VERCEL_GIT_COMMIT_SHA"),
		SendDefaultPII: false,
		Transport:      sentry.NewHTTPSyncTransport(),
	})
	if err != nil {
		logx.Warn("Could not start error reporting", logx.Fields{"error": err.Error()})
		return
	}
	logx.Report = func(err error, message string, fields logx.Fields) {
		hub := sentry.CurrentHub().Clone()
		hub.WithScope(func(scope *sentry.Scope) {
			logged := sentry.Context{"message": message}
			for key, value := range fields {
				logged[key] = value
			}
			scope.SetContext("log", logged)
			hub.CaptureException(err)
		})
	}
}

// FromEnv is Init with the process environment.
func FromEnv() { Init(os.Getenv) }

// Recover turns a panic in next into a logged (and reported) 500 instead of a crashed function.
func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				if recovered == http.ErrAbortHandler {
					panic(recovered)
				}
				httpx.WriteError(w, r, httpx.NewRequestID(), panicError{recovered})
				sentry.Flush(2 * time.Second)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type panicError struct{ value any }

func (p panicError) Error() string { return fmt.Sprint("panic: ", p.value) }

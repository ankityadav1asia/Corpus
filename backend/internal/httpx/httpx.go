// Package httpx holds the request plumbing every handler shares, matching server/http/*.ts:
// JSON responses, the error body, byte-capped JSON bodies, the same-origin check and request ids.
package httpx

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ankityadav1asia/Corpus/backend/internal/apperr"
	"github.com/ankityadav1asia/Corpus/backend/internal/logx"
)

// DefaultJSONLimit is the body cap when a route sets none (64 KB, as in body.ts).
const DefaultJSONLimit = 64 * 1024

// NewRequestID returns a random UUID (version 4).
func NewRequestID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// WriteJSON writes a JSON body like Next.js's NextResponse.json plus the no-store header the
// TypeScript routes add. HTML characters are not escaped, the same as JSON.stringify.
func WriteJSON(w http.ResponseWriter, status int, value any) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		status, buffer = http.StatusInternalServerError, *bytes.NewBufferString(`{"error":{"code":"INTERNAL","message":"Something went wrong. Please try again."}}`)
	}
	header := w.Header()
	header.Set("Content-Type", "application/json")
	header.Set("Cache-Control", "no-store")
	header.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(bytes.TrimSuffix(buffer.Bytes(), []byte("\n")))
}

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Details   any    `json:"details,omitempty"`
	RequestID string `json:"requestId"`
}

// SchemaMissing: Postgres "undefined table / schema / column" means migrations were not run.
func SchemaMissing(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	return pgErr.Code == "42P01" || pgErr.Code == "3F000" || pgErr.Code == "42703"
}

// WriteError turns any error into the API error body. Only *apperr.Error messages reach the
// client; everything else is logged and becomes a generic 500 with the request id.
func WriteError(w http.ResponseWriter, r *http.Request, requestID string, err error) {
	where := logx.Fields{"requestId": requestID, "method": r.Method, "path": r.URL.Path}
	if appErr, ok := apperr.As(err); ok {
		if appErr.Status >= 500 {
			where["code"], where["status"] = appErr.Code, appErr.Status
			logx.Warn("Request failed", where)
		}
		for key, value := range appErr.Headers {
			w.Header().Set(key, value)
		}
		WriteJSON(w, appErr.Status, errorBody{errorDetail{Code: appErr.Code, Message: appErr.Message, Details: appErr.Details, RequestID: requestID}})
		return
	}
	if SchemaMissing(err) {
		logx.Error("Database schema missing — run `npm run db:migrate`", err, where)
		WriteJSON(w, http.StatusServiceUnavailable, errorBody{errorDetail{Code: "SCHEMA_MISSING", Message: "The database schema is missing or out of date. Run `npm run db:migrate` on the server.", RequestID: requestID}})
		return
	}
	logx.Error("Unhandled route error", err, where)
	WriteJSON(w, http.StatusInternalServerError, errorBody{errorDetail{Code: "INTERNAL", Message: "Something went wrong. Please try again.", RequestID: requestID}})
}

// ReadJSON reads a JSON body with a hard byte cap (Content-Length first, then while reading) and
// decodes it into a generic value; the caller validates its shape.
func ReadJSON(r *http.Request, maxBytes int64) (any, error) {
	if !strings.Contains(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		return nil, apperr.UnsupportedMediaType("Expected a JSON request body.")
	}
	tooLarge := apperr.PayloadTooLarge(fmt.Sprintf("Request body exceeds %d KB.", int(math.Round(float64(maxBytes)/1024))))
	if r.ContentLength > maxBytes {
		return nil, tooLarge
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, maxBytes+1))
	if err != nil {
		return nil, apperr.BadRequest("Malformed JSON body.")
	}
	if int64(len(data)) > maxBytes {
		return nil, tooLarge
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, apperr.BadRequest("Malformed JSON body.")
	}
	return value, nil
}

var safeMethods = map[string]bool{http.MethodGet: true, http.MethodHead: true, http.MethodOptions: true}

func hostOf(raw string) (string, bool) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", false
	}
	host := strings.ToLower(parsed.Host)
	// WHATWG URLs drop the scheme's default port; Go keeps it.
	if (parsed.Scheme == "http" && strings.HasSuffix(host, ":80")) || (parsed.Scheme == "https" && strings.HasSuffix(host, ":443")) {
		host = host[:strings.LastIndex(host, ":")]
	}
	return host, true
}

// CheckSameOrigin is CSRF defence in depth on top of SameSite=Lax cookies: browsers send Origin on
// cross-site POST/PATCH/DELETE, so a mismatch means the request came from another site.
func CheckSameOrigin(r *http.Request, appURL string) error {
	if safeMethods[r.Method] {
		return nil
	}
	values, present := r.Header["Origin"]
	if !present || len(values) == 0 {
		return nil
	}
	blocked := apperr.Forbidden("Cross-origin request blocked.")
	originHost, ok := hostOf(values[0])
	if !ok {
		return blocked
	}
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	if host != "" && originHost == host {
		return nil
	}
	if appURL != "" {
		if appHost, ok := hostOf(appURL); ok && appHost == originHost {
			return nil
		}
	}
	return blocked
}

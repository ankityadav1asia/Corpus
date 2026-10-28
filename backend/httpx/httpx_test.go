package httpx

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ankityadav1asia/Corpus/backend/apperr"
)

func request(method, body, contentType string) *http.Request {
	r := httptest.NewRequest(method, "http://localhost:3000/api/x", strings.NewReader(body))
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	return r
}

func status(err error) int {
	if appErr, ok := apperr.As(err); ok {
		return appErr.Status
	}
	return 0
}

func TestReadJSONEnforcesTypeSizeAndSyntax(t *testing.T) {
	if _, err := ReadJSON(request("POST", "name=x", "text/plain"), DefaultJSONLimit); status(err) != 415 {
		t.Fatalf("plain text: %v", err)
	}
	if _, err := ReadJSON(request("POST", `{"name":`, "application/json"), DefaultJSONLimit); status(err) != 400 {
		t.Fatalf("malformed: %v", err)
	}
	big := `{"name":"` + strings.Repeat("x", 70_000) + `"}`
	_, err := ReadJSON(request("POST", big, "application/json; charset=utf-8"), DefaultJSONLimit)
	if appErr, _ := apperr.As(err); appErr == nil || appErr.Status != 413 || appErr.Message != "Request body exceeds 64 KB." {
		t.Fatalf("too large: %v", err)
	}
	value, err := ReadJSON(request("POST", `{"name":"ok"}`, "application/json"), DefaultJSONLimit)
	if err != nil || value.(map[string]any)["name"] != "ok" {
		t.Fatalf("valid: %v %v", value, err)
	}
}

func TestNameBodyMatchesZod(t *testing.T) {
	cases := []struct {
		body any
		path string
		msg  string
	}{
		{map[string]any{}, "name", "Invalid input: expected string, received undefined"},
		{map[string]any{"name": "  "}, "name", "Too small: expected string to have >=1 characters"},
		{map[string]any{"name": strings.Repeat("x", 81)}, "name", "Too big: expected string to have <=80 characters"},
		{map[string]any{"name": 5.0}, "name", "Invalid input: expected string, received number"},
		{map[string]any{"name": nil}, "name", "Invalid input: expected string, received null"},
		{[]any{}, "", "Invalid input: expected object, received array"},
		{nil, "", "Invalid input: expected object, received null"},
	}
	for _, c := range cases {
		_, err := NameBody(c.body, 80)
		appErr, _ := apperr.As(err)
		issues, _ := appErr.Details.([]apperr.Issue)
		if appErr == nil || appErr.Code != "VALIDATION_FAILED" || len(issues) != 1 || issues[0].Path != c.path || issues[0].Message != c.msg {
			t.Errorf("NameBody(%v) = %v %+v", c.body, appErr, issues)
		}
	}
	if name, err := NameBody(map[string]any{"name": "  Bob’s team \u00a0"}, 80); err != nil || name != "Bob’s team" {
		t.Fatalf("trim: %q %v", name, err)
	}
}

func TestSameOriginCheck(t *testing.T) {
	post := func(origin string, set bool) *http.Request {
		r := request("POST", "{}", "application/json")
		if set {
			r.Header.Set("Origin", origin)
		}
		return r
	}
	if CheckSameOrigin(post("", false), "") != nil {
		t.Fatal("no Origin header is allowed (same-origin non-browser clients)")
	}
	if CheckSameOrigin(post("http://localhost:3000", true), "") != nil {
		t.Fatal("same origin blocked")
	}
	for _, bad := range []string{"https://evil.example", "null", ""} {
		if status(CheckSameOrigin(post(bad, true), "")) != 403 {
			t.Errorf("origin %q allowed", bad)
		}
	}
	if CheckSameOrigin(post("https://corpus.example", true), "https://corpus.example") != nil {
		t.Fatal("APP_URL origin blocked")
	}
	if CheckSameOrigin(post("https://corpus.example:443", true), "https://corpus.example") != nil {
		t.Fatal("default port must not matter")
	}
	get := request("GET", "", "")
	get.Header.Set("Origin", "https://evil.example")
	if CheckSameOrigin(get, "") != nil {
		t.Fatal("GET is not checked")
	}
}

func TestErrorsNeverLeakInternals(t *testing.T) {
	r := request("GET", "", "")
	w := httptest.NewRecorder()
	WriteError(w, r, "req-1", errors.New("password=hunter2 in SQL"))
	if w.Code != 500 || strings.Contains(w.Body.String(), "hunter2") || !strings.Contains(w.Body.String(), `"requestId":"req-1"`) {
		t.Fatalf("500 body = %s", w.Body.String())
	}
	w = httptest.NewRecorder()
	WriteError(w, r, "req-2", &pgconn.PgError{Code: "42P01", Message: "relation app.x does not exist"})
	if w.Code != 503 || !strings.Contains(w.Body.String(), "SCHEMA_MISSING") {
		t.Fatalf("schema body = %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	WriteError(w, r, "req-3", apperr.RateLimited(7))
	if w.Code != 429 || w.Header().Get("Retry-After") != "7" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("rate limited = %d %v", w.Code, w.Header())
	}
}

func TestWriteJSONDoesNotEscapeHTML(t *testing.T) {
	w := httptest.NewRecorder()
	WriteJSON(w, 200, map[string]string{"name": "<b>&</b>"})
	if w.Body.String() != `{"name":"<b>&</b>"}` {
		t.Fatalf("body = %q", w.Body.String())
	}
}

func TestIsID(t *testing.T) {
	if !IsID("00000000-0000-4000-8000-000000000001") || !IsID("ABCDEF00-0000-0000-0000-000000000000") || IsID("not-a-uuid") || IsID("") {
		t.Fatal("IsID is wrong")
	}
}

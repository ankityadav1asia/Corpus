package monitoring

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ankityadav1asia/Corpus/backend/logx"
)

func TestInitWithoutADSNReportsNothing(t *testing.T) {
	logx.Report = nil
	Init(func(string) string { return "" })
	if logx.Report != nil {
		t.Fatal("reporting started without a DSN")
	}
}

func TestPanicsBecomeA500AndAreReported(t *testing.T) {
	logx.SetOutput(io.Discard)
	var reported []string
	logx.Report = func(err error, message string, _ logx.Fields) { reported = append(reported, message+": "+err.Error()) }
	t.Cleanup(func() { logx.Report = nil })

	handler := Recover(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("nil map") }))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/usage", nil))
	var body struct {
		Error struct{ Code, Message string } `json:"error"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if w.Code != 500 || body.Error.Code != "INTERNAL" || len(reported) != 1 || reported[0] != "Unhandled route error: panic: nil map" {
		t.Fatalf("status %d body %s reported %v", w.Code, w.Body.String(), reported)
	}

	// Logged errors without an error value are not reports.
	logx.Error("Nothing to report", nil, nil)
	logx.Error("Database down", errors.New("dial tcp: refused"), logx.Fields{"requestId": "r1"})
	if len(reported) != 2 || reported[1] != "Database down: dial tcp: refused" {
		t.Fatalf("reported %v", reported)
	}
}

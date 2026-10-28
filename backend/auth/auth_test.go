package auth

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ankityadav1asia/Corpus/backend/apperr"
)

var secret = strings.Repeat("y", 48)

func claimsAt(now time.Time) map[string]any {
	return map[string]any{"v": 2, "sid": "s1", "sub": "u1", "email": "alice@example.com", "name": "Alice", "iat": now.Unix(), "exp": now.Unix() + 3600}
}

func sign(t *testing.T, payload any, secrets ...string) string {
	t.Helper()
	token, err := Sign(payload, secrets)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestReadsTokensSignedByTheTypeScriptApp(t *testing.T) {
	data, err := os.ReadFile("testdata/tokens.json")
	if err != nil {
		t.Fatalf("run `npm run core:fixtures` first: %v", err)
	}
	var fixture struct {
		Secret  string `json:"secret"`
		NowMs   int64  `json:"nowMs"`
		Valid   string `json:"valid"`
		Guest   string `json:"guest"`
		Expired string `json:"expired"`
		Foreign string `json:"foreign"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(fixture.NowMs)
	claims, ok := ReadSessionToken(fixture.Valid, []string{fixture.Secret}, now)
	if !ok || claims.SessionID == "" || claims.Email != "alice@example.com" || claims.Name == nil || *claims.Name != "Alice" {
		t.Fatalf("valid TypeScript token rejected: %+v", claims)
	}
	if guest, ok := ReadSessionToken(fixture.Guest, []string{fixture.Secret}, now); !ok || guest.Name != nil || !IsGuestEmail(guest.Email) {
		t.Fatalf("guest token: %+v %v", guest, ok)
	}
	if _, ok := ReadSessionToken(fixture.Expired, []string{fixture.Secret}, now); ok {
		t.Fatal("expired token accepted")
	}
	if _, ok := ReadSessionToken(fixture.Foreign, []string{fixture.Secret}, now); ok {
		t.Fatal("token signed with another secret accepted")
	}
}

func TestRejectsTamperedAndMalformedTokens(t *testing.T) {
	now := time.Now()
	token := sign(t, claimsAt(now), secret)
	if _, ok := ReadSessionToken(token, []string{secret}, now); !ok {
		t.Fatal("own token rejected")
	}
	body, signature, _ := strings.Cut(token, ".")
	tampered := body[:len(body)-2] + "AA." + signature
	for _, bad := range []string{"", "abc", token + ".x", tampered, body + ".", body + ".!!!", "." + signature} {
		if _, ok := ReadSessionToken(bad, []string{secret}, now); ok {
			t.Errorf("accepted %q", bad)
		}
	}
	for _, payload := range []map[string]any{
		{"v": 1, "sid": "s", "sub": "u", "email": "e", "name": nil, "iat": now.Unix(), "exp": now.Unix() + 60},
		{"v": 2, "sid": "", "sub": "u", "email": "e", "name": nil, "iat": now.Unix(), "exp": now.Unix() + 60},
		{"v": 2, "sid": "s", "sub": "u", "email": "e", "iat": now.Unix(), "exp": now.Unix() + 60},
		{"v": 2, "sid": "s", "sub": "u", "email": "e", "name": 5, "iat": now.Unix(), "exp": now.Unix() + 60},
		{"v": 2, "sid": "s", "sub": "u", "email": "e", "name": nil, "iat": now.Unix() + 120, "exp": now.Unix() + 600},
	} {
		if _, ok := ReadSessionToken(sign(t, payload, secret), []string{secret}, now); ok {
			t.Errorf("accepted claims %v", payload)
		}
	}
}

func TestAcceptsThePreviousSecretDuringRotation(t *testing.T) {
	now := time.Now()
	old := strings.Repeat("o", 40)
	token := sign(t, claimsAt(now), old)
	if _, ok := ReadSessionToken(token, []string{secret}, now); ok {
		t.Fatal("old secret accepted without rotation")
	}
	if _, ok := ReadSessionToken(token, []string{secret, old}, now); !ok {
		t.Fatal("previous secret rejected during rotation")
	}
}

type fakeSessions struct {
	active bool
	calls  int
	err    error
}

func (f *fakeSessions) SessionActive(context.Context, string, string) (bool, error) {
	f.calls++
	return f.active, f.err
}

func TestSessionsCacheActiveAnswersOnly(t *testing.T) {
	now := time.Now()
	store := &fakeSessions{active: true}
	sessions := NewSessions(store)
	sessions.Now = func() time.Time { return now }
	token := sign(t, claimsAt(now), secret)
	for i := 0; i < 3; i++ {
		user, err := sessions.UserFromToken(context.Background(), token, []string{secret})
		if err != nil || user == nil || user.ID != "u1" || user.Guest {
			t.Fatalf("user = %+v, err = %v", user, err)
		}
	}
	if store.calls != 1 {
		t.Fatalf("active session looked up %d times, want 1", store.calls)
	}
	now = now.Add(31 * time.Second)
	store.active = false
	if user, _ := sessions.UserFromToken(context.Background(), token, []string{secret}); user != nil {
		t.Fatal("revoked session still accepted after the cache expired")
	}
	store.err = errors.New("db down")
	if _, err := sessions.UserFromToken(context.Background(), token, []string{secret}); err == nil {
		t.Fatal("database error swallowed")
	}
}

func TestRoleMatrix(t *testing.T) {
	cases := []struct {
		role       Role
		permission Permission
		want       bool
	}{
		{Viewer, CollectionSearch, true},
		{Viewer, CollectionCreate, false},
		{Editor, CollectionCreate, true},
		{Editor, CollectionManage, false},
		{Admin, MembersManage, true},
		{"", WorkspaceView, false},
		{"owner", WorkspaceView, false},
		{Admin, "made.up", false},
	}
	for _, c := range cases {
		if got := Can(c.role, c.permission); got != c.want {
			t.Errorf("Can(%q, %q) = %v, want %v", c.role, c.permission, got, c.want)
		}
	}
	editor, viewer := Editor, Viewer
	if EffectiveCollectionRole(Admin, &viewer) != Admin || EffectiveCollectionRole(Viewer, &editor) != Editor || EffectiveCollectionRole(Editor, nil) != Editor || EffectiveCollectionRole("", &editor) != "" {
		t.Fatal("effective notebook roles are wrong")
	}
}

func TestGuestsAreReadOnly(t *testing.T) {
	guest := &Access{Role: Admin, IsGuest: true}
	if RequireWorkspacePermission(guest, CollectionSearch) != nil {
		t.Fatal("guests may search")
	}
	err, _ := apperr.As(RequireWorkspacePermission(guest, CollectionCreate))
	if err == nil || err.Status != 403 || err.Message != GuestDeniedMessage {
		t.Fatalf("guest create: %v", err)
	}
	err, _ = apperr.As(RequireWorkspacePermission(&Access{Role: Viewer}, CollectionCreate))
	if err == nil || err.Message != "You need Editor access to create notebooks." {
		t.Fatalf("viewer create: %v", err)
	}
}

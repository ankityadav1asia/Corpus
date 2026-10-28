// Package auth verifies the session cookie the Next.js app issues (server/auth/session.ts), keeps
// the role-permission table (server/auth/permissions.ts) and resolves workspace access.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

// SessionCookie is the cookie both backends read.
const SessionCookie = "corpus_session"

// Claims of a session token (version 2: it names a server-side session in app.sessions).
type Claims struct {
	SessionID string
	UserID    string
	Email     string
	Name      *string
	IssuedAt  float64
	ExpiresAt float64
}

var base64URL = regexp.MustCompile(`^[A-Za-z0-9_-]*$`)

func decodeBase64URL(value string) ([]byte, bool) {
	if !base64URL.MatchString(value) {
		return nil, false
	}
	bytes, err := base64.RawURLEncoding.DecodeString(value)
	return bytes, err == nil
}

// Sign returns `<base64url(json)>.<base64url(hmac)>` with the first (current) secret. Only tests
// sign; the Next.js app creates sessions.
func Sign(payload any, secrets []string) (string, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(data)
	mac := hmac.New(sha256.New, []byte(secrets[0]))
	mac.Write([]byte(body))
	return body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// verify returns the payload when the signature matches one of the accepted secrets. hmac.Equal
// compares in constant time.
func verify(token string, secrets []string) (map[string]any, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 || parts[0] == "" {
		return nil, false
	}
	signature, ok := decodeBase64URL(parts[1])
	if !ok || len(signature) != sha256.Size {
		return nil, false
	}
	valid := false
	for _, secret := range secrets {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte(parts[0]))
		if hmac.Equal(mac.Sum(nil), signature) {
			valid = true
			break
		}
	}
	if !valid {
		return nil, false
	}
	payload, ok := decodeBase64URL(parts[0])
	if !ok {
		return nil, false
	}
	var claims map[string]any
	if json.Unmarshal(payload, &claims) != nil || claims == nil {
		return nil, false
	}
	return claims, true
}

// ReadSessionToken checks signature, format and expiry. Whether the session was revoked is a
// separate, database check (Sessions.Active).
func ReadSessionToken(token string, secrets []string, now time.Time) (*Claims, bool) {
	if len(secrets) == 0 {
		return nil, false
	}
	raw, ok := verify(token, secrets)
	if !ok {
		return nil, false
	}
	claims, ok := parseClaims(raw)
	if !ok {
		return nil, false
	}
	nowMs := float64(now.UnixMilli())
	if claims.ExpiresAt*1000 <= nowMs || claims.IssuedAt*1000 > nowMs+60_000 {
		return nil, false
	}
	return claims, true
}

func parseClaims(raw map[string]any) (*Claims, bool) {
	version, ok := raw["v"].(float64)
	if !ok || version != 2 {
		return nil, false
	}
	sid, ok1 := raw["sid"].(string)
	sub, ok2 := raw["sub"].(string)
	email, ok3 := raw["email"].(string)
	iat, ok4 := raw["iat"].(float64)
	exp, ok5 := raw["exp"].(float64)
	if !ok1 || !ok2 || !ok3 || !ok4 || !ok5 || sid == "" {
		return nil, false
	}
	claims := &Claims{SessionID: sid, UserID: sub, Email: email, IssuedAt: iat, ExpiresAt: exp}
	switch name := raw["name"].(type) {
	case nil:
		if _, present := raw["name"]; !present {
			return nil, false
		}
	case string:
		claims.Name = &name
	default:
		return nil, false
	}
	return claims, true
}

// GuestEmailDomain is the reserved domain of demo visitors (server/auth/guest.ts).
const GuestEmailDomain = "demo.invalid"

func IsGuestEmail(email string) bool {
	return strings.HasSuffix(strings.ToLower(strings.TrimSpace(email)), "@"+GuestEmailDomain)
}

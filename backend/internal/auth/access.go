package auth

import (
	"context"
	"sync"
	"time"

	"github.com/ankityadav1asia/Corpus/backend/internal/apperr"
)

// User is the signed-in caller.
type User struct {
	ID    string  `json:"id"`
	Email string  `json:"email"`
	Name  *string `json:"name"`
	Guest bool    `json:"guest,omitempty"`
}

// Access says who is acting, in which workspace, with which role. Resolved once per request.
type Access struct {
	UserID      string
	WorkspaceID string
	Role        Role
	IsPersonal  bool
	IsGuest     bool
}

// Membership of a user in a workspace.
type Membership struct {
	Role       Role
	IsPersonal bool
}

// SessionStore answers whether a server-side session is still active (not revoked, not expired).
type SessionStore interface {
	SessionActive(ctx context.Context, sessionID, userID string) (bool, error)
}

// MembershipStore finds a user's membership of a workspace (nil when not a member).
type MembershipStore interface {
	Membership(ctx context.Context, workspaceID, userID string) (*Membership, error)
}

// Sessions caches "active" answers briefly, as server/auth/current-user.ts does, so every
// request does not cost a database round trip. Revocations are seen within the TTL.
type Sessions struct {
	Store SessionStore
	TTL   time.Duration
	Max   int
	Now   func() time.Time

	mu     sync.Mutex
	active map[string]time.Time
}

func NewSessions(store SessionStore) *Sessions {
	return &Sessions{Store: store, TTL: 30 * time.Second, Max: 5000, Now: time.Now, active: map[string]time.Time{}}
}

// UserFromToken returns the user behind a session cookie value, or nil when it is missing,
// invalid, expired or revoked.
func (s *Sessions) UserFromToken(ctx context.Context, token string, secrets []string) (*User, error) {
	if token == "" {
		return nil, nil
	}
	claims, ok := ReadSessionToken(token, secrets, s.Now())
	if !ok {
		return nil, nil
	}
	active, err := s.isActive(ctx, claims)
	if err != nil || !active {
		return nil, err
	}
	return &User{ID: claims.UserID, Email: claims.Email, Name: claims.Name, Guest: IsGuestEmail(claims.Email)}, nil
}

func (s *Sessions) isActive(ctx context.Context, claims *Claims) (bool, error) {
	key := claims.SessionID + ":" + claims.UserID
	now := s.Now()
	s.mu.Lock()
	until, cached := s.active[key]
	s.mu.Unlock()
	if cached && until.After(now) {
		return true, nil
	}
	active, err := s.Store.SessionActive(ctx, claims.SessionID, claims.UserID)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if active {
		if len(s.active) >= s.Max {
			s.active = map[string]time.Time{}
		}
		s.active[key] = now.Add(s.TTL)
	} else {
		delete(s.active, key)
	}
	return active, nil
}

// ResolveAccess: non-members get 404 (not 403), so workspace ids cannot be probed.
func ResolveAccess(ctx context.Context, store MembershipStore, user *User, workspaceID string) (*Access, error) {
	membership, err := store.Membership(ctx, workspaceID, user.ID)
	if err != nil {
		return nil, err
	}
	if membership == nil {
		return nil, apperr.NotFound("Workspace")
	}
	return &Access{UserID: user.ID, WorkspaceID: workspaceID, Role: membership.Role, IsPersonal: membership.IsPersonal, IsGuest: user.Guest}, nil
}

// RequirePermission checks a role against the permission table.
func RequirePermission(role Role, permission Permission) error {
	if !Can(role, permission) {
		return apperr.Forbidden(PermissionMessage(permission))
	}
	return nil
}

// RequireWorkspacePermission: demo visitors are held to the read-only guest policy first.
func RequireWorkspacePermission(access *Access, permission Permission) error {
	if access.IsGuest && !GuestCan(permission) {
		return apperr.Forbidden(GuestDeniedMessage)
	}
	return RequirePermission(access.Role, permission)
}

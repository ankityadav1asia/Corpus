// Package apperr is the error model shared by every handler, the same as server/http/errors.ts:
// an Error carries an HTTP status, a stable code and a message that is safe to show. Anything
// else becomes a generic 500, so SQL, stack traces or provider messages never reach a client.
package apperr

import (
	"errors"
	"fmt"
	"strconv"
)

type Error struct {
	Status  int
	Code    string
	Message string
	Details any
	Headers map[string]string
}

func (e *Error) Error() string { return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message) }

// As returns the *Error inside err, if any.
func As(err error) (*Error, bool) {
	var target *Error
	ok := errors.As(err, &target)
	return target, ok
}

// Issue is one failed validation rule (zod's issue: a dotted path and a message).
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

func BadRequest(message string) *Error {
	return &Error{Status: 400, Code: "BAD_REQUEST", Message: message}
}

func Validation(issues []Issue) *Error {
	return &Error{Status: 400, Code: "VALIDATION_FAILED", Message: "Some fields are invalid.", Details: issues}
}

func Unauthenticated() *Error {
	return &Error{Status: 401, Code: "UNAUTHENTICATED", Message: "Please sign in to continue."}
}

func Forbidden(message string) *Error {
	return &Error{Status: 403, Code: "FORBIDDEN", Message: message}
}

func NotFound(what string) *Error {
	return &Error{Status: 404, Code: "NOT_FOUND", Message: what + " not found."}
}

func Conflict(message string) *Error { return &Error{Status: 409, Code: "CONFLICT", Message: message} }

func PayloadTooLarge(message string) *Error {
	return &Error{Status: 413, Code: "PAYLOAD_TOO_LARGE", Message: message}
}

func UnsupportedMediaType(message string) *Error {
	return &Error{Status: 415, Code: "UNSUPPORTED_MEDIA_TYPE", Message: message}
}

func RateLimited(retryAfterSeconds int) *Error {
	return &Error{
		Status:  429,
		Code:    "RATE_LIMITED",
		Message: "Too many requests. Please wait a moment and try again.",
		Details: map[string]int{"retryAfterSeconds": retryAfterSeconds},
		Headers: map[string]string{"Retry-After": strconv.Itoa(retryAfterSeconds)},
	}
}

func NotConfigured(message string) *Error {
	return &Error{Status: 503, Code: "NOT_CONFIGURED", Message: message}
}

// Package logx writes one JSON object per line, the same shape as server/logger.ts:
// {"time", "level", "msg", ...fields}. Never log secrets, tokens or codes.
package logx

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

type Fields map[string]any

var (
	mu     sync.Mutex
	out    io.Writer = os.Stdout
	errOut io.Writer = os.Stderr
)

// SetOutput redirects logs (tests).
func SetOutput(w io.Writer) {
	mu.Lock()
	defer mu.Unlock()
	out, errOut = w, w
}

func emit(level, message string, fields Fields) {
	entry := map[string]any{}
	for key, value := range fields {
		entry[key] = value
	}
	entry["time"] = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	entry["level"] = level
	entry["msg"] = message
	line, err := json.Marshal(entry)
	if err != nil {
		line = []byte(fmt.Sprintf(`{"level":%q,"msg":%q}`, level, message))
	}
	mu.Lock()
	defer mu.Unlock()
	target := out
	if level == "error" || level == "warn" {
		target = errOut
	}
	_, _ = target.Write(append(line, '\n'))
}

func Info(message string, fields Fields) { emit("info", message, fields) }
func Warn(message string, fields Fields) { emit("warn", message, fields) }

// Error logs an error under "error" with its message (no stack, no secrets).
func Error(message string, err error, fields Fields) {
	merged := Fields{}
	for key, value := range fields {
		merged[key] = value
	}
	if err != nil {
		merged["error"] = map[string]any{"message": err.Error()}
	}
	emit("error", message, merged)
}

package httpx

import (
	"fmt"
	"regexp"

	"github.com/ankityadav1asia/Corpus/backend/apperr"
	"github.com/ankityadav1asia/Corpus/backend/jsstr"
)

var guid = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// IsID is zod's z.guid(): any 8-4-4-4-12 hexadecimal id.
func IsID(value string) bool { return guid.MatchString(value) }

func typeName(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "unknown"
}

// Object is zod's z.object(): the body must be a JSON object (unknown keys are ignored).
func Object(body any) (map[string]any, error) {
	object, ok := body.(map[string]any)
	if !ok {
		return nil, apperr.Validation([]apperr.Issue{{Path: "", Message: "Invalid input: expected object, received " + typeName(body)}})
	}
	return object, nil
}

// RequiredText is requiredText(max) from lib/contracts/fields.ts: a string, trimmed, 1..max
// characters (JavaScript lengths). Messages follow zod's.
func RequiredText(object map[string]any, field string, max int) (string, *apperr.Issue) {
	raw, present := object[field]
	text, ok := raw.(string)
	if !present || !ok {
		received := "undefined"
		if present {
			received = typeName(raw)
		}
		return "", &apperr.Issue{Path: field, Message: "Invalid input: expected string, received " + received}
	}
	text = jsstr.Trim(text)
	if jsstr.Len(text) < 1 {
		return "", &apperr.Issue{Path: field, Message: "Too small: expected string to have >=1 characters"}
	}
	if jsstr.Len(text) > max {
		return "", &apperr.Issue{Path: field, Message: fmt.Sprintf("Too big: expected string to have <=%d characters", max)}
	}
	return text, nil
}

// NameBody validates `{ name: requiredText(max) }`, the body of every "create X" route here.
func NameBody(body any, max int) (string, error) {
	object, err := Object(body)
	if err != nil {
		return "", err
	}
	name, issue := RequiredText(object, "name", max)
	if issue != nil {
		return "", apperr.Validation([]apperr.Issue{*issue})
	}
	return name, nil
}

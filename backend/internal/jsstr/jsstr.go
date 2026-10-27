// Package jsstr gives Go the JavaScript string rules the API contract was written with: lengths
// in UTF-16 code units (zod's .max()) and String.prototype.trim (zod's .trim()).
package jsstr

import (
	"strings"
	"unicode/utf16"
)

// Len is JavaScript's string.length: UTF-16 code units, not bytes or runes.
func Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// IsSpace is JavaScript's WhiteSpace or LineTerminator. Unlike unicode.IsSpace it includes
// U+FEFF and excludes U+0085.
func IsSpace(r rune) bool {
	switch r {
	case '\t', '\v', '\f', ' ', '\u00a0', '\ufeff', '\n', '\r', '\u2028', '\u2029', '\u1680', '\u202f', '\u205f', '\u3000':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

// Trim is String.prototype.trim.
func Trim(s string) string {
	return strings.TrimFunc(s, IsSpace)
}

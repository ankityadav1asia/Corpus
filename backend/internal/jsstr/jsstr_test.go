package jsstr

import "testing"

func TestLenCountsUTF16Units(t *testing.T) {
	for input, want := range map[string]int{"": 0, "abc": 3, "é": 1, "😀": 2, "Bob’s team": 10} {
		if got := Len(input); got != want {
			t.Errorf("Len(%q) = %d, want %d", input, got, want)
		}
	}
}

func TestTrimMatchesJavaScript(t *testing.T) {
	cases := map[string]string{
		"  a  ":             "a",
		"\ufeff a \u00a0\n": "a",
		"\u0085a":           "\u0085a",
		"\u2003x\u3000":     "x",
		"\t\r\n inside  \t": "inside",
	}
	for input, want := range cases {
		if got := Trim(input); got != want {
			t.Errorf("Trim(%q) = %q, want %q", input, got, want)
		}
	}
}

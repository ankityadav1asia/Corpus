//! JavaScript string semantics the ported code depends on.

/// `string.length` in JavaScript: UTF-16 code units, not bytes or characters.
pub fn len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// `String.prototype.trim`: WhiteSpace (incl. U+FEFF and the `Zs` spaces) and LineTerminators.
/// Unlike `str::trim`, it keeps U+0085 and keeps U+180E.
pub fn trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}' | '\u{000B}' | '\u{000C}' | '\u{0020}' | '\u{00A0}' | '\u{FEFF}' | '\u{000A}' | '\u{000D}' | '\u{2028}' | '\u{2029}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}'
    )
}

/// `Number.prototype.toFixed(digits)` for finite non-negative and negative numbers: rounds the
/// exact decimal value of the double, with ties away from zero (Rust's `{:.N}` rounds ties to even).
pub fn to_fixed(value: f64, digits: usize) -> String {
    if !value.is_finite() {
        return if value.is_nan() { "NaN".into() } else if value > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let negative = value < 0.0;
    // 40 decimals hold far more digits than any tie can depend on; Rust prints them exactly.
    let exact = format!("{:.40}", value.abs());
    let (int_part, frac_part) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let mut digits_vec: Vec<u8> = int_part.bytes().chain(frac_part.bytes().take(digits)).map(|b| b - b'0').collect();
    let round_up = frac_part.as_bytes().get(digits).is_some_and(|next| *next >= b'5');
    if round_up {
        let mut i = digits_vec.len();
        loop {
            if i == 0 {
                digits_vec.insert(0, 1);
                break;
            }
            i -= 1;
            if digits_vec[i] == 9 {
                digits_vec[i] = 0;
            } else {
                digits_vec[i] += 1;
                break;
            }
        }
    }
    let int_len = digits_vec.len() - digits;
    let mut out = String::new();
    if negative && digits_vec.iter().any(|d| *d != 0) {
        out.push('-');
    }
    out.extend(digits_vec[..int_len].iter().map(|d| char::from(b'0' + d)));
    if digits > 0 {
        out.push('.');
        out.extend(digits_vec[int_len..].iter().map(|d| char::from(b'0' + d)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_counts_utf16_units() {
        assert_eq!(len("abc"), 3);
        assert_eq!(len("é"), 1);
        assert_eq!(len("😀"), 2);
    }

    #[test]
    fn trim_matches_javascript() {
        assert_eq!(trim("\u{FEFF} a \u{00A0}\n"), "a");
        assert_eq!(trim("\u{0085}a"), "\u{0085}a");
    }

    #[test]
    fn to_fixed_rounds_ties_away_from_zero() {
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(0.345, 2), "0.34"); // 0.345 is 0.34499999… as a double
        assert_eq!(to_fixed(0.35, 2), "0.35");
        assert_eq!(to_fixed(0.999, 2), "1.00");
        assert_eq!(to_fixed(1.0, 2), "1.00");
        assert_eq!(to_fixed(0.0, 2), "0.00");
    }
}

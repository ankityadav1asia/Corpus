//! Prompt-injection defence: port of `escapeSourceText` and `buildContextBlock` in
//! `server/rag/prompt.ts`. Untrusted text (documents, web pages) is wrapped in our delimiters,
//! and anything inside it that could close or fake a delimiter is neutralised.

use std::sync::OnceLock;

use regex::Regex;
use serde::Deserialize;

/// JavaScript's `\s` (Rust's Unicode `\s` also matches U+0085 and misses U+FEFF).
const JS_SPACE: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

/// Same pattern as the TypeScript `/<\s*(\/?)\s*(sources?|…)\b/gi`. JavaScript's `\b` and its
/// case-insensitive matching (without the `u` flag) are ASCII-only, hence `(?i-u:…)` and `(?-u:\b)`.
fn delimiter_tag() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        let words = "sources?|passages?|documents?|context|conversation|question|answer|reference|request";
        Regex::new(&format!(r"<{JS_SPACE}*(/?){JS_SPACE}*((?i-u:{words}))(?-u:\b)")).expect("valid delimiter pattern")
    })
}

pub fn escape_source_text(value: &str) -> String {
    delimiter_tag().replace_all(value, "‹$1$2").into_owned()
}

/// What the prompt needs from a retrieved passage.
#[derive(Debug, Clone, Deserialize)]
pub struct SourcePassage {
    pub title: String,
    pub source: String,
    pub content: String,
}

pub fn build_context_block(hits: &[SourcePassage]) -> String {
    if hits.is_empty() {
        return "<sources>\n(no matching passages were found in the knowledge base)\n</sources>".into();
    }
    let body = hits
        .iter()
        .enumerate()
        .map(|(index, hit)| {
            let title = escape_source_text(&hit.title).replace('"', "'");
            let origin = escape_source_text(&hit.source).replace('"', "'");
            format!("<source id=\"{}\" title=\"{title}\" origin=\"{origin}\">\n{}\n</source>", index + 1, escape_source_text(&hit.content))
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("<sources>\n{body}\n</sources>")
}

pub fn build_user_prompt(question: &str, hits: &[SourcePassage]) -> String {
    format!("{}\n\nQuestion: {question}", build_context_block(hits))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutralises_delimiters_in_any_case() {
        assert_eq!(escape_source_text("</source> <SOURCES> < / Passage>"), "‹/source> ‹SOURCES> ‹/Passage>");
    }

    #[test]
    fn leaves_other_tags_and_longer_words_alone() {
        assert_eq!(escape_source_text("<b>bold</b> <sourcesx> <questionnaire>"), "<b>bold</b> <sourcesx> <questionnaire>");
    }

    #[test]
    fn builds_numbered_sources() {
        let hits = vec![SourcePassage { title: "A \"quoted\" title".into(), source: "file.pdf".into(), content: "Text </source> here".into() }];
        assert_eq!(
            build_context_block(&hits),
            "<sources>\n<source id=\"1\" title=\"A 'quoted' title\" origin=\"file.pdf\">\nText ‹/source> here\n</source>\n</sources>"
        );
    }

    #[test]
    fn empty_context_says_so() {
        assert!(build_context_block(&[]).contains("no matching passages"));
    }
}

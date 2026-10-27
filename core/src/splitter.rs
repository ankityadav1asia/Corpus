//! Recursive character splitter: port of `server/rag/text-splitter.ts`.
//!
//! Tries paragraph, line, sentence, word and finally character boundaries so chunks stay under
//! `chunk_size` while keeping `chunk_overlap` characters of context. Sizes are JavaScript string
//! lengths (UTF-16 code units), so both implementations cut at the same places.

use crate::js;

pub const DEFAULT_CHUNK_SIZE: usize = 1000;
pub const DEFAULT_CHUNK_OVERLAP: usize = 150;
pub const DEFAULT_SEPARATORS: [&str; 5] = ["\n\n", "\n", ". ", " ", ""];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitError(pub String);

impl std::fmt::Display for SplitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub fn split_text(text: &str, chunk_size: usize, chunk_overlap: usize, separators: &[&str]) -> Result<Vec<String>, SplitError> {
    if chunk_overlap >= chunk_size {
        return Err(SplitError("chunkOverlap must be smaller than chunkSize".into()));
    }
    Ok(recursive_split(text, separators, chunk_size, chunk_overlap))
}

/// Keeps the separator at the start of the following piece, so no text is lost.
fn split_keeping_separator<'a>(text: &'a str, separator: &str) -> Vec<&'a str> {
    if separator.is_empty() {
        // `Array.from(text)` splits by code point.
        return text.char_indices().map(|(i, c)| &text[i..i + c.len_utf8()]).collect();
    }
    let mut pieces = Vec::new();
    let mut start = 0;
    // Same as `text.split(/(?=separator)/)`: cut before every occurrence, scanning one
    // character at a time so overlapping occurrences (e.g. "\n\n\n") are all cut points.
    for (i, _) in text.char_indices() {
        if i > 0 && text[i..].starts_with(separator) {
            pieces.push(&text[start..i]);
            start = i;
        }
    }
    pieces.push(&text[start..]);
    pieces.into_iter().filter(|piece| !piece.is_empty()).collect()
}

fn recursive_split(text: &str, separators: &[&str], chunk_size: usize, chunk_overlap: usize) -> Vec<String> {
    let mut separator = *separators.last().unwrap_or(&"");
    let mut remaining: &[&str] = &[];
    for (i, candidate) in separators.iter().enumerate() {
        if candidate.is_empty() {
            separator = *candidate;
            break;
        }
        if text.contains(candidate) {
            separator = *candidate;
            remaining = &separators[i + 1..];
            break;
        }
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut pending: Vec<&str> = Vec::new();
    for piece in split_keeping_separator(text, separator) {
        if js::len(piece) < chunk_size {
            pending.push(piece);
            continue;
        }
        if !pending.is_empty() {
            chunks.extend(merge_pieces(&pending, chunk_size, chunk_overlap));
            pending.clear();
        }
        if remaining.is_empty() {
            chunks.push(js::trim(piece).to_string());
        } else {
            chunks.extend(recursive_split(piece, remaining, chunk_size, chunk_overlap));
        }
    }
    if !pending.is_empty() {
        chunks.extend(merge_pieces(&pending, chunk_size, chunk_overlap));
    }
    chunks.into_iter().filter(|chunk| !chunk.is_empty()).collect()
}

/// Greedily packs small pieces into chunks, carrying the tail of the previous chunk as overlap.
fn merge_pieces(pieces: &[&str], chunk_size: usize, chunk_overlap: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut window: std::collections::VecDeque<&str> = std::collections::VecDeque::new();
    let mut total = 0usize;
    for piece in pieces {
        let piece_len = js::len(piece);
        if total + piece_len > chunk_size && !window.is_empty() {
            let joined: String = window.iter().copied().collect();
            let chunk = js::trim(&joined);
            if !chunk.is_empty() {
                chunks.push(chunk.to_string());
            }
            while total > chunk_overlap || (total + piece_len > chunk_size && total > 0) {
                let removed = window.pop_front().expect("window holds the counted pieces");
                total -= js::len(removed);
            }
        }
        window.push_back(piece);
        total += piece_len;
    }
    let joined: String = window.iter().copied().collect();
    let last = js::trim(&joined);
    if !last.is_empty() {
        chunks.push(last.to_string());
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(text: &str, size: usize, overlap: usize) -> Vec<String> {
        split_text(text, size, overlap, &DEFAULT_SEPARATORS).unwrap()
    }

    #[test]
    fn short_text_is_one_chunk() {
        assert_eq!(split("Hello world.", 1000, 150), vec!["Hello world."]);
    }

    #[test]
    fn rejects_overlap_not_smaller_than_size() {
        assert!(split_text("x", 10, 10, &DEFAULT_SEPARATORS).is_err());
    }

    #[test]
    fn chunks_stay_within_size() {
        let text = "word ".repeat(500);
        for chunk in split(&text, 100, 20) {
            assert!(js::len(&chunk) <= 100, "{chunk:?}");
        }
    }

    #[test]
    fn separator_stays_with_the_following_piece() {
        assert_eq!(split_keeping_separator("a\n\nb\n\nc", "\n\n"), vec!["a", "\n\nb", "\n\nc"]);
        assert_eq!(split_keeping_separator("\n\n\nx", "\n\n"), vec!["\n", "\n\nx"]);
    }
}

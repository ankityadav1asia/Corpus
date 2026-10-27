//! Reciprocal Rank Fusion: port of `fuseRankedLists` in `server/rag/retrieval.ts`.
//!
//! `score(p) = Σ 1 / (k + rank)`. Rank-based, so it needs no normalisation between cosine
//! similarity and full-text scores. A hit is any JSON object with a string `chunkId` and a
//! `similarity` (number or null); every other field is carried through unchanged.

use serde_json::{Map, Value};

pub const RRF_K: f64 = 60.0;

#[derive(Debug, Clone, PartialEq)]
pub struct FusionError(pub String);

impl std::fmt::Display for FusionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

struct Entry {
    hit: Map<String, Value>,
    chunk_id: String,
    score: f64,
    order: usize,
}

fn similarity(hit: &Map<String, Value>) -> Option<f64> {
    hit.get("similarity").and_then(Value::as_f64)
}

/// Fuses ranked lists into one list of at most `limit` hits, best first. Ties are broken by
/// `chunkId` (byte order; ids are lower-case UUIDs, for which it equals JavaScript's
/// `localeCompare`), so the order is deterministic. The best similarity seen for a chunk is kept.
pub fn fuse_ranked_lists(lists: &[Vec<Value>], limit: usize, k: f64) -> Result<Vec<Value>, FusionError> {
    let mut entries: Vec<Entry> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for list in lists {
        for (rank, value) in list.iter().enumerate() {
            let hit = value.as_object().ok_or_else(|| FusionError("every hit must be an object".into()))?;
            let chunk_id = hit
                .get("chunkId")
                .and_then(Value::as_str)
                .ok_or_else(|| FusionError("every hit needs a string chunkId".into()))?
                .to_string();
            let increment = 1.0 / (k + rank as f64 + 1.0);
            match index.get(&chunk_id) {
                None => {
                    index.insert(chunk_id.clone(), entries.len());
                    entries.push(Entry { hit: hit.clone(), chunk_id, score: increment, order: entries.len() });
                }
                Some(&at) => {
                    let entry = &mut entries[at];
                    entry.score += increment;
                    if let Some(candidate) = similarity(hit) {
                        if similarity(&entry.hit).is_none_or(|current| candidate > current) {
                            entry.hit.insert("similarity".into(), hit["similarity"].clone());
                        }
                    }
                }
            }
        }
    }
    entries.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.chunk_id.cmp(&b.chunk_id))
            .then_with(|| a.order.cmp(&b.order))
    });
    Ok(entries.into_iter().take(limit).map(|entry| Value::Object(entry.hit)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ids(hits: &[Value]) -> Vec<&str> {
        hits.iter().map(|hit| hit["chunkId"].as_str().unwrap()).collect()
    }

    #[test]
    fn chunks_found_by_several_searches_rise() {
        let vector = vec![json!({"chunkId": "a", "similarity": 0.9}), json!({"chunkId": "b", "similarity": 0.8})];
        let text = vec![json!({"chunkId": "b", "similarity": null}), json!({"chunkId": "c", "similarity": null})];
        let fused = fuse_ranked_lists(&[vector, text], 10, RRF_K).unwrap();
        assert_eq!(ids(&fused), vec!["b", "a", "c"]);
        assert_eq!(fused[0]["similarity"], json!(0.8));
    }

    #[test]
    fn keeps_the_best_similarity_and_the_limit() {
        let first = vec![json!({"chunkId": "a", "similarity": 0.4})];
        let second = vec![json!({"chunkId": "a", "similarity": 0.7}), json!({"chunkId": "b", "similarity": 0.1})];
        let fused = fuse_ranked_lists(&[first, second], 1, RRF_K).unwrap();
        assert_eq!(fused.len(), 1);
        assert_eq!(fused[0]["similarity"], json!(0.7));
    }

    #[test]
    fn rejects_hits_without_an_id() {
        assert!(fuse_ranked_lists(&[vec![json!({"similarity": 1})]], 5, RRF_K).is_err());
    }
}

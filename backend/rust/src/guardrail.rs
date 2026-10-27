//! Relevance guardrail: port of `server/rag/guardrail.ts`.
//!
//! If even the best retrieved passage is not relevant enough, the model is not called and the user
//! gets "Insufficient context in knowledge base." instead of a plausible-sounding guess.
//! Re-ranker relevance is preferred; cosine similarity is the fallback. Fusion scores are
//! rank-based and never used as relevance.

use serde::{Deserialize, Serialize};

use crate::js;

pub const INSUFFICIENT_CONTEXT_MESSAGE: &str = "Insufficient context in knowledge base.";

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardrailSettings {
    pub enabled: bool,
    pub min_relevance: f64,
    pub min_similarity: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardrailInput {
    pub settings: GuardrailSettings,
    pub candidate_count: u64,
    pub best_relevance: Option<f64>,
    pub best_similarity: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardrailBasis {
    Relevance,
    Similarity,
    NoCandidates,
    Unscored,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GuardrailResult {
    pub pass: bool,
    pub basis: GuardrailBasis,
    pub score: Option<f64>,
    pub threshold: Option<f64>,
}

pub fn check_guardrail(input: &GuardrailInput) -> GuardrailResult {
    let settings = input.settings;
    if !settings.enabled {
        return GuardrailResult { pass: true, basis: GuardrailBasis::Disabled, score: None, threshold: None };
    }
    if input.candidate_count == 0 {
        return GuardrailResult { pass: false, basis: GuardrailBasis::NoCandidates, score: None, threshold: None };
    }
    if let Some(relevance) = input.best_relevance {
        return GuardrailResult { pass: relevance >= settings.min_relevance, basis: GuardrailBasis::Relevance, score: Some(relevance), threshold: Some(settings.min_relevance) };
    }
    if let Some(similarity) = input.best_similarity {
        return GuardrailResult { pass: similarity >= settings.min_similarity, basis: GuardrailBasis::Similarity, score: Some(similarity), threshold: Some(settings.min_similarity) };
    }
    // Only keyword matches and no re-ranker: there is no calibrated score to judge by.
    GuardrailResult { pass: true, basis: GuardrailBasis::Unscored, score: None, threshold: None }
}

fn format(value: Option<f64>) -> String {
    value.map_or_else(|| "—".to_string(), |v| js::to_fixed(v, 2))
}

/// The human-readable research step shown under an answer.
pub fn describe_guardrail(result: &GuardrailResult) -> String {
    let (score, threshold) = (format(result.score), format(result.threshold));
    match result.basis {
        GuardrailBasis::Disabled => "Relevance guardrail is turned off for this workspace".into(),
        GuardrailBasis::NoCandidates => "No passages matched the question — answer withheld".into(),
        GuardrailBasis::Unscored => "Only keyword matches were found; no relevance score available".into(),
        GuardrailBasis::Relevance if result.pass => format!("Best re-ranker relevance {score} ≥ threshold {threshold}"),
        GuardrailBasis::Relevance => format!("Best re-ranker relevance {score} < threshold {threshold} — answer withheld"),
        GuardrailBasis::Similarity if result.pass => format!("Best similarity {score} ≥ threshold {threshold}"),
        GuardrailBasis::Similarity => format!("Best similarity {score} < threshold {threshold} — answer withheld"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON: GuardrailSettings = GuardrailSettings { enabled: true, min_relevance: 0.35, min_similarity: 0.45 };

    fn input(relevance: Option<f64>, similarity: Option<f64>) -> GuardrailInput {
        GuardrailInput { settings: ON, candidate_count: 3, best_relevance: relevance, best_similarity: similarity }
    }

    #[test]
    fn relevance_wins_over_similarity() {
        let result = check_guardrail(&input(Some(0.2), Some(0.99)));
        assert!(!result.pass);
        assert_eq!(result.basis, GuardrailBasis::Relevance);
        assert_eq!(describe_guardrail(&result), "Best re-ranker relevance 0.20 < threshold 0.35 — answer withheld");
    }

    #[test]
    fn similarity_is_the_fallback() {
        let result = check_guardrail(&input(None, Some(0.5)));
        assert!(result.pass);
        assert_eq!(describe_guardrail(&result), "Best similarity 0.50 ≥ threshold 0.45");
    }

    #[test]
    fn no_candidates_fails_and_disabled_passes() {
        let mut none = input(None, None);
        none.candidate_count = 0;
        assert_eq!(check_guardrail(&none).basis, GuardrailBasis::NoCandidates);
        let mut off = input(Some(0.0), None);
        off.settings.enabled = false;
        assert!(check_guardrail(&off).pass);
    }
}

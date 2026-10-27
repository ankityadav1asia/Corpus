//! Corpus RAG core.
//!
//! Pure, deterministic pieces of the retrieval pipeline, ported from the TypeScript originals in
//! `server/rag/` and kept byte-for-byte compatible with them (golden tests in `tests/golden.rs`
//! compare against fixtures produced by the TypeScript code):
//!
//! - [`splitter`]: recursive character splitter (1 000 / 150 by default)
//! - [`fusion`]: Reciprocal Rank Fusion of ranked search results
//! - [`guardrail`]: the relevance guardrail that withholds weak answers
//! - [`prompt`]: escaping untrusted text and building the `<sources>` block
//!
//! JavaScript measures string length in UTF-16 code units, so lengths here do too ([`js`]).
//! The crate builds to WebAssembly (`wasm32-unknown-unknown`) with one JSON entry point
//! ([`ffi`]), which the Go backend runs in-process.

pub mod ffi;
pub mod fusion;
pub mod guardrail;
pub mod js;
pub mod prompt;
pub mod splitter;

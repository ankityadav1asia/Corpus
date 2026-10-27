//! Corpus RAG core.
//!
//! Pure, deterministic pieces of the retrieval pipeline. They replaced the TypeScript originals in
//! `server/rag/` and stay byte-for-byte compatible with them: `tests/fixtures/golden.json` holds the
//! outputs the TypeScript code gave, checked by `tests/golden.rs` and by `tests/core.test.ts`:
//!
//! - [`splitter`]: recursive character splitter (1 000 / 150 by default)
//! - [`fusion`]: Reciprocal Rank Fusion of ranked search results
//! - [`guardrail`]: the relevance guardrail that withholds weak answers
//! - [`prompt`]: escaping untrusted text and building the `<sources>` block
//!
//! JavaScript measures string length in UTF-16 code units, so lengths here do too ([`js`]).
//! The crate builds to WebAssembly (`wasm32-unknown-unknown`) with one JSON entry point
//! ([`ffi`]), which the Node.js server loads in-process (`server/core`).

pub mod ffi;
pub mod fusion;
pub mod guardrail;
pub mod js;
pub mod prompt;
pub mod splitter;

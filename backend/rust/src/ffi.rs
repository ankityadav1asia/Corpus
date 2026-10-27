//! The WebAssembly boundary: one JSON-in / JSON-out entry point.
//!
//! The host (the Go backend) writes a request into memory it got from [`alloc`], calls [`invoke`]
//! with its pointer and length, reads the response it gets back (pointer and length packed into
//! one `u64`) and frees both with [`dealloc`]. Requests are `{"fn": "<name>", "args": {...}}`;
//! responses are `{"ok": <result>}` or `{"error": "<message>"}`.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::{fusion, guardrail, prompt, splitter};

#[derive(Deserialize)]
struct Request {
    #[serde(rename = "fn")]
    function: String,
    #[serde(default)]
    args: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitArgs {
    text: String,
    chunk_size: Option<usize>,
    chunk_overlap: Option<usize>,
}

#[derive(Deserialize)]
struct FuseArgs {
    lists: Vec<Vec<Value>>,
    limit: usize,
    k: Option<f64>,
}

#[derive(Deserialize)]
struct EscapeArgs {
    value: String,
}

#[derive(Deserialize)]
struct ContextArgs {
    hits: Vec<prompt::SourcePassage>,
}

#[derive(Deserialize)]
struct UserPromptArgs {
    question: String,
    hits: Vec<prompt::SourcePassage>,
}

fn args<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| format!("invalid arguments: {error}"))
}

/// Runs one request; also used directly by the Rust tests.
pub fn dispatch(input: &str) -> Value {
    match run(input) {
        Ok(value) => json!({ "ok": value }),
        Err(message) => json!({ "error": message }),
    }
}

fn run(input: &str) -> Result<Value, String> {
    let request: Request = serde_json::from_str(input).map_err(|error| format!("invalid request: {error}"))?;
    match request.function.as_str() {
        "version" => Ok(json!(env!("CARGO_PKG_VERSION"))),
        "split_text" => {
            let a: SplitArgs = args(request.args)?;
            let chunks = splitter::split_text(
                &a.text,
                a.chunk_size.unwrap_or(splitter::DEFAULT_CHUNK_SIZE),
                a.chunk_overlap.unwrap_or(splitter::DEFAULT_CHUNK_OVERLAP),
                &splitter::DEFAULT_SEPARATORS,
            )
            .map_err(|error| error.to_string())?;
            Ok(json!(chunks))
        }
        "fuse_ranked_lists" => {
            let a: FuseArgs = args(request.args)?;
            fusion::fuse_ranked_lists(&a.lists, a.limit, a.k.unwrap_or(fusion::RRF_K)).map(Value::Array).map_err(|error| error.to_string())
        }
        "check_guardrail" => {
            let input: guardrail::GuardrailInput = args(request.args)?;
            let result = guardrail::check_guardrail(&input);
            Ok(json!({ "result": result, "description": guardrail::describe_guardrail(&result) }))
        }
        "escape_source_text" => {
            let a: EscapeArgs = args(request.args)?;
            Ok(json!(prompt::escape_source_text(&a.value)))
        }
        "build_context_block" => {
            let a: ContextArgs = args(request.args)?;
            Ok(json!(prompt::build_context_block(&a.hits)))
        }
        "build_user_prompt" => {
            let a: UserPromptArgs = args(request.args)?;
            Ok(json!(prompt::build_user_prompt(&a.question, &a.hits)))
        }
        other => Err(format!("unknown function: {other}")),
    }
}

/// Reserves `len` bytes for the host to write a request into.
#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len as usize);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// Frees memory handed out by [`alloc`] or returned by [`invoke`].
///
/// # Safety
/// `pointer` and `len` must come from one earlier `alloc(len)` or `invoke` result, freed once.
#[no_mangle]
pub unsafe extern "C" fn dealloc(pointer: *mut u8, len: u32) {
    drop(Vec::from_raw_parts(pointer, 0, len as usize));
}

/// Handles the request at `pointer`/`len` and returns the response as `(pointer << 32) | len`.
///
/// # Safety
/// `pointer` must point to `len` readable bytes the host wrote.
#[no_mangle]
pub unsafe extern "C" fn invoke(pointer: *const u8, len: u32) -> u64 {
    let input = std::slice::from_raw_parts(pointer, len as usize);
    let response = match std::str::from_utf8(input) {
        Ok(text) => dispatch(text),
        Err(_) => json!({ "error": "request is not UTF-8" }),
    };
    let mut bytes = response.to_string().into_bytes();
    bytes.shrink_to_fit();
    let (out_pointer, out_len) = (bytes.as_mut_ptr(), bytes.len());
    std::mem::forget(bytes);
    ((out_pointer as u64) << 32) | out_len as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatches_by_name() {
        assert_eq!(dispatch(r#"{"fn":"escape_source_text","args":{"value":"</source>"}}"#), json!({ "ok": "‹/source>" }));
        assert_eq!(dispatch(r#"{"fn":"split_text","args":{"text":"a b"}}"#), json!({ "ok": ["a b"] }));
    }

    #[test]
    fn reports_errors_as_values() {
        assert!(dispatch("not json")["error"].is_string());
        assert!(dispatch(r#"{"fn":"nope"}"#)["error"].as_str().unwrap().contains("unknown function"));
        assert!(dispatch(r#"{"fn":"split_text","args":{"text":"x","chunkSize":5,"chunkOverlap":5}}"#)["error"].is_string());
    }
}

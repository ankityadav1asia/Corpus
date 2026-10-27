//! Every case in `fixtures/golden.json` (the outputs of the TypeScript implementations this crate
//! replaced) must come out of the Rust core exactly the same.

use corpus_core::ffi::dispatch;
use serde_json::{json, Value};

fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/golden.json")).expect("golden.json parses")
}

fn cases<'a>(golden: &'a Value, name: &str) -> &'a Vec<Value> {
    golden[name].as_array().unwrap_or_else(|| panic!("golden.json has no {name}"))
}

fn run(function: &str, args: Value) -> Value {
    let response = dispatch(&json!({ "fn": function, "args": args }).to_string());
    match response.get("ok") {
        Some(value) => value.clone(),
        None => panic!("{function} failed: {response}"),
    }
}

/// Numbers are compared as numbers (1 and 1.0 are the same value in JSON).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(key, value)| y.get(key).is_some_and(|other| same(value, other))),
        _ => a == b,
    }
}

fn check(name: &str, function: &str, args: impl Fn(&Value) -> Value) {
    let golden = golden();
    let all = cases(&golden, name);
    assert!(!all.is_empty());
    for (index, case) in all.iter().enumerate() {
        let actual = run(function, args(&case["input"]));
        assert!(same(&actual, &case["output"]), "{name} case {index} differs\nexpected: {}\nactual:   {actual}", case["output"]);
    }
}

#[test]
fn split_text_matches_typescript() {
    check("splitText", "split_text", |input| input.clone());
}

#[test]
fn fuse_ranked_lists_matches_typescript() {
    check("fuseRankedLists", "fuse_ranked_lists", |input| input.clone());
}

#[test]
fn check_guardrail_matches_typescript() {
    check("checkGuardrail", "check_guardrail", |input| input.clone());
}

#[test]
fn escape_source_text_matches_typescript() {
    check("escapeSourceText", "escape_source_text", |input| json!({ "value": input }));
}

#[test]
fn build_context_block_matches_typescript() {
    check("buildContextBlock", "build_context_block", |input| json!({ "hits": input }));
}

#[test]
fn build_user_prompt_matches_typescript() {
    check("buildUserPrompt", "build_user_prompt", |input| input.clone());
}

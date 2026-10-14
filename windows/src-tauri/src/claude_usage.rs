// Claude Code usage — counted from the transcripts Claude Code already writes.
//
// Claude Code keeps one JSONL file per session under ~/.claude/projects. Coucou
// reads them only while the "Usage stats" setting is on, looks back 30 days, and
// returns numbers and nothing else: tokens per hour, tokens per model and how
// often each tool was called. Prompts, answers, paths and commands are never
// kept or sent to the webview. Nothing leaves the computer.
//
// Files are cached by path, size and modified time, so a scan only parses what
// changed since the last one. It runs off the main thread, at most once at a
// time, and is skipped while Coucou is paused.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{self, AtomicBool};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::platform;

/// How far back the card looks.
const WINDOW_HOURS: i64 = 30 * 24;
/// Tool results can be large, so a transcript line may be long; longer ones are skipped.
const MAX_LINE: usize = 4 * 1024 * 1024;
/// ~/.claude/projects/<project>/<session>.jsonl sits two folders down; allow a little more.
const MAX_DEPTH: usize = 4;
/// Names are only ever labels in the card, so long ones are cut short.
const MAX_NAME: usize = 64;
const TOP_TOOLS: usize = 20;
const TOP_MODELS: usize = 8;

static BUSY: AtomicBool = AtomicBool::new(false);

struct NotBusy;
impl Drop for NotBusy {
    fn drop(&mut self) {
        BUSY.store(false, atomic::Ordering::Release);
    }
}

/// What one transcript file contributes. Kept whole so the cache can answer any window.
#[derive(Default, Clone)]
struct FileUsage {
    mtime: u64,
    size: u64,
    /// Hour since the epoch -> [input, output, cache write, cache read] tokens.
    hours: HashMap<i64, [u64; 4]>,
    /// Model name -> all tokens it used.
    models: HashMap<String, u64>,
    /// Tool name -> calls.
    tools: HashMap<String, u64>,
}

static CACHE: OnceLock<Mutex<HashMap<PathBuf, FileUsage>>> = OnceLock::new();

/// The usage card's numbers for the last 30 days, or `None` when there are no
/// transcripts, Coucou is paused, or a scan is already running. Blocking: call
/// it off the main thread.
pub fn read() -> Option<Value> {
    if crate::integrations::PAUSED.load(atomic::Ordering::Relaxed) {
        return None;
    }
    if BUSY.swap(true, atomic::Ordering::AcqRel) {
        return None;
    }
    let _busy = NotBusy;

    let now = now_secs();
    let cutoff_secs = (now - WINDOW_HOURS * 3600).max(0) as u64;
    let root = platform::home_dir().join(".claude").join("projects");
    let mut files = Vec::new();
    collect(&root, 0, &mut files);

    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut hours: HashMap<i64, [u64; 4]> = HashMap::new();
    let mut models: HashMap<String, u64> = HashMap::new();
    let mut tools: HashMap<String, u64> = HashMap::new();
    let mut seen_paths = HashSet::new();
    let mut scanned = 0usize;

    for (path, mtime, size) in files {
        // A file nobody has touched for the whole window has nothing in it we want.
        if mtime < cutoff_secs {
            continue;
        }
        if crate::integrations::PAUSED.load(atomic::Ordering::Relaxed) {
            return None;
        }
        seen_paths.insert(path.clone());
        let cached = cache.lock().ok()?.get(&path).filter(|u| u.mtime == mtime && u.size == size).cloned();
        let usage = match cached {
            Some(usage) => usage,
            None => {
                let usage = scan_file(&path, mtime, size)?;
                cache.lock().ok()?.insert(path.clone(), usage.clone());
                usage
            }
        };
        scanned += 1;
        for (hour, tokens) in &usage.hours {
            if *hour < now / 3600 - WINDOW_HOURS {
                continue;
            }
            let total = hours.entry(*hour).or_insert([0; 4]);
            for (sum, value) in total.iter_mut().zip(tokens) {
                *sum += value;
            }
        }
        for (name, count) in &usage.models {
            *models.entry(name.clone()).or_insert(0) += count;
        }
        for (name, count) in &usage.tools {
            *tools.entry(name.clone()).or_insert(0) += count;
        }
    }
    // Forget files that were deleted or fell out of the window.
    cache.lock().ok()?.retain(|path, _| seen_paths.contains(path));

    let mut hour_rows: Vec<(i64, [u64; 4])> = hours.into_iter().collect();
    hour_rows.sort_by_key(|(hour, _)| *hour);
    let mut models: Vec<(String, u64)> = models.into_iter().collect();
    models.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    models.truncate(TOP_MODELS);
    let mut tools: Vec<(String, u64)> = tools.into_iter().collect();
    tools.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    tools.truncate(TOP_TOOLS);

    Some(json!({
        // [hour, input, output, cache write, cache read]; hours are UTC, the webview groups them by local day.
        "hours": hour_rows.iter().map(|(h, t)| json!([h, t[0], t[1], t[2], t[3]])).collect::<Vec<_>>(),
        "models": models.iter().map(|(name, n)| json!([name, n])).collect::<Vec<_>>(),
        "tools": tools.iter().map(|(name, n)| json!([name, n])).collect::<Vec<_>>(),
        "files": scanned,
    }))
}

/// Every `.jsonl` under `dir`, with its modified time (seconds) and size.
fn collect(dir: &Path, depth: usize, out: &mut Vec<(PathBuf, u64, u64)>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect(&path, depth + 1, out);
        } else if path.extension().is_some_and(|ext| ext == "jsonl") {
            let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
            out.push((path, mtime, meta.len()));
        }
    }
}

/// Parses one transcript file. `None` only when the file cannot be opened.
fn scan_file(path: &Path, mtime: u64, size: u64) -> Option<FileUsage> {
    let file = fs::File::open(path).ok()?;
    let mut usage = scan_reader(BufReader::new(file));
    usage.mtime = mtime;
    usage.size = size;
    Some(usage)
}

/// Reads JSONL lines and counts them. Lines over `MAX_LINE` are skipped whole.
fn scan_reader(mut reader: impl BufRead) -> FileUsage {
    let mut usage = FileUsage::default();
    let mut seen_messages = HashSet::new();
    let mut seen_tools = HashSet::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        let Ok(n) = reader.by_ref().take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line) else { break };
        if n == 0 {
            break;
        }
        if line.len() > MAX_LINE {
            skip_rest_of_line(&mut reader);
            continue;
        }
        record(&line, &mut usage, &mut seen_messages, &mut seen_tools);
    }
    usage
}

/// Drops the remainder of an oversized line without holding it in memory.
fn skip_rest_of_line(reader: &mut impl BufRead) {
    let mut sink = Vec::new();
    loop {
        sink.clear();
        match reader.by_ref().take(MAX_LINE as u64).read_until(b'\n', &mut sink) {
            Ok(0) | Err(_) => return,
            Ok(_) if sink.ends_with(b"\n") => return,
            Ok(_) => continue,
        }
    }
}

/// Counts one transcript line. Claude Code writes one line per content block of a
/// reply, and each line repeats the reply's usage, so tokens are counted once per
/// message id and tool calls once per tool-use id.
fn record(line: &[u8], usage: &mut FileUsage, seen_messages: &mut HashSet<String>, seen_tools: &mut HashSet<String>) {
    if !line.windows(11).any(|w| w == b"\"assistant\"") {
        return;
    }
    let Ok(value) = serde_json::from_slice::<Value>(line) else { return };
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return;
    }
    let Some(message) = value.get("message") else { return };
    let Some(hour) = value.get("timestamp").and_then(Value::as_str).and_then(parse_hour) else { return };

    if let Some(id) = message.get("id").and_then(Value::as_str) {
        if seen_messages.insert(id.to_string()) {
            if let Some(tokens) = message.get("usage") {
                let field = |key: &str| tokens.get(key).and_then(Value::as_u64).unwrap_or(0);
                let parts = [
                    field("input_tokens"),
                    field("output_tokens"),
                    field("cache_creation_input_tokens"),
                    field("cache_read_input_tokens"),
                ];
                let sum: u64 = parts.iter().sum();
                let total = usage.hours.entry(hour).or_insert([0; 4]);
                for (slot, value) in total.iter_mut().zip(parts) {
                    *slot += value;
                }
                let model = message.get("model").and_then(Value::as_str).unwrap_or("unknown");
                *usage.models.entry(truncate(model)).or_insert(0) += sum;
            }
        }
    }

    for block in message.get("content").and_then(Value::as_array).into_iter().flatten() {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let Some(name) = block.get("name").and_then(Value::as_str) else { continue };
        let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
        if id.is_empty() || seen_tools.insert(id.to_string()) {
            *usage.tools.entry(truncate(name)).or_insert(0) += 1;
        }
    }
}

fn truncate(name: &str) -> String {
    name.chars().take(MAX_NAME).collect()
}

/// Hours since the epoch for a UTC timestamp like `2026-10-14T11:20:33.123Z`.
fn parse_hour(ts: &str) -> Option<i64> {
    if !ts.ends_with('Z') || ts.len() < 13 || ts.as_bytes()[10] != b'T' {
        return None;
    }
    let year: i64 = ts.get(0..4)?.parse().ok()?;
    let month: i64 = ts.get(5..7)?.parse().ok()?;
    let day: i64 = ts.get(8..10)?.parse().ok()?;
    let hour: i64 = ts.get(11..13)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 {
        return None;
    }
    Some(days_from_civil(year, month, day) * 24 + hour)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(text: &str) -> FileUsage {
        scan_reader(text.as_bytes())
    }

    #[test]
    fn timestamps_become_hours_since_the_epoch() {
        assert_eq!(parse_hour("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_hour("1970-01-02T05:59:59.999Z"), Some(29));
        assert_eq!(
            parse_hour("2026-10-15T00:00:00Z").unwrap() - parse_hour("2026-10-14T00:00:00Z").unwrap(),
            24
        );
        assert_eq!(parse_hour("2026-10-14T11:20:33+02:00"), None);
        assert_eq!(parse_hour("not a date"), None);
    }

    #[test]
    fn tokens_models_and_tools_are_counted_once_per_message() {
        let line = concat!(
            r#"{"type":"assistant","timestamp":"1970-01-01T01:00:00.000Z","message":{"id":"m1","model":"claude-x","#,
            r#""usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":2,"cache_read_input_tokens":3},"#,
            r#""content":[{"type":"tool_use","id":"t1","name":"Bash"},{"type":"text","text":"hi"}]}}"#,
        );
        // The same reply written again for its second content block.
        let second = concat!(
            r#"{"type":"assistant","timestamp":"1970-01-01T01:00:01.000Z","message":{"id":"m1","model":"claude-x","#,
            r#""usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":2,"cache_read_input_tokens":3},"#,
            r#""content":[{"type":"tool_use","id":"t2","name":"Edit"}]}}"#,
        );
        let usage = scan(&format!("{line}\n{second}\n"));
        assert_eq!(usage.hours.get(&1), Some(&[10, 5, 2, 3]));
        assert_eq!(usage.models.get("claude-x"), Some(&20));
        assert_eq!(usage.tools.get("Bash"), Some(&1));
        assert_eq!(usage.tools.get("Edit"), Some(&1));
    }

    #[test]
    fn other_lines_and_broken_lines_are_ignored() {
        let usage = scan(concat!(
            "not json\n",
            r#"{"type":"user","timestamp":"1970-01-01T01:00:00.000Z","message":{"content":"hello"}}"#, "\n",
            r#"{"type":"assistant","timestamp":"bad","message":{"id":"x","usage":{"input_tokens":9}}}"#, "\n",
        ));
        assert!(usage.hours.is_empty());
        assert!(usage.tools.is_empty());
    }

    #[test]
    fn oversized_lines_are_skipped_without_losing_the_next_one() {
        let big = "x".repeat(MAX_LINE + 10);
        let good = r#"{"type":"assistant","timestamp":"1970-01-01T02:00:00.000Z","message":{"id":"ok","usage":{"input_tokens":1},"content":[]}}"#;
        let usage = scan(&format!("{big}\n{good}\n"));
        assert_eq!(usage.hours.get(&2), Some(&[1, 0, 0, 0]));
    }
}

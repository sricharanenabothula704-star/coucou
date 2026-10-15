// Quick notes — one scratchpad that is always there, kept in
// %APPDATA%\Coucou\notes.json. It is yours: nothing reads it but the dashboard
// (and the chat only if you paste from it).

use std::path::PathBuf;

/// More than this is cut (a scratchpad, not a document store).
const MAX_CHARS: usize = 100_000;

fn path() -> PathBuf {
    crate::platform::config_dir().join("notes.json")
}

pub fn clamp(text: &str) -> String {
    text.chars().take(MAX_CHARS).collect()
}

#[tauri::command]
pub fn notes_get() -> String {
    std::fs::read(path())
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v["text"].as_str().map(str::to_string))
        .unwrap_or_default()
}

#[tauri::command]
pub fn notes_set(text: String) -> bool {
    let _ = crate::platform::ensure_private_dir(&crate::platform::config_dir());
    let json = serde_json::json!({ "text": clamp(&text) }).to_string();
    let p = path();
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, json).is_ok() && std::fs::rename(&tmp, &p).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_note_is_cut_at_the_limit_on_a_character() {
        assert_eq!(clamp("hello"), "hello");
        let long = "é".repeat(MAX_CHARS + 10);
        assert_eq!(clamp(&long).chars().count(), MAX_CHARS);
    }
}

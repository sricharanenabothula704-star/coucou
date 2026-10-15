// Clipboard history — the last text you copied, to pick one up again.
//
// Off until turned on in Settings → Dashboard. While on, Windows tells a hidden
// window whenever the clipboard changes (no polling) and the text is read once.
// What it keeps stays in memory: never written to disk, gone when Coucou quits
// or the setting goes off. Anything a password manager marks "exclude from
// history" is skipped, and so is anything that isn't text.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

const MAX_ENTRIES: usize = 30;
/// Longer text is cut here.
const MAX_CHARS: usize = 10_000;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: u64,
    pub text: String,
    /// Unix ms.
    pub at: u64,
}

// ── Pure rules ────────────────────────────────────────────────────────────────

/// Adds `text` at the front: blank text is ignored, long text is cut, a copy of
/// something already there moves it to the front, and only the newest 30 stay.
/// True when the list changed.
pub fn push_entry(list: &mut Vec<Entry>, text: &str, at: u64, id: u64) -> bool {
    let trimmed = text.trim_end_matches(['\r', '\n', '\0']);
    if trimmed.trim().is_empty() {
        return false;
    }
    let text: String = trimmed.chars().take(MAX_CHARS).collect();
    if list.first().is_some_and(|e| e.text == text) {
        return false;
    }
    list.retain(|e| e.text != text);
    list.insert(0, Entry { id, text, at });
    list.truncate(MAX_ENTRIES);
    true
}

static ENABLED: AtomicBool = AtomicBool::new(false);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static LIST: Mutex<Vec<Entry>> = Mutex::new(Vec::new());

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn record(text: &str) {
    let mut list = LIST.lock().unwrap_or_else(|e| e.into_inner());
    push_entry(&mut list, text, now_ms(), NEXT_ID.fetch_add(1, Ordering::Relaxed));
}

/// Starts or stops watching to match the setting; turning it off forgets everything.
pub fn sync(on: bool) {
    ENABLED.store(on, Ordering::Release);
    if on {
        imp::ensure_listener();
    } else {
        LIST.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

#[tauri::command]
pub fn clipboard_list() -> Vec<Entry> {
    if !ENABLED.load(Ordering::Acquire) {
        return Vec::new();
    }
    LIST.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Puts an entry back on the clipboard (the user pastes it).
#[tauri::command]
pub fn clipboard_copy(id: u64) -> bool {
    let text = LIST.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|e| e.id == id).map(|e| e.text.clone());
    text.is_some_and(|t| imp::write(&t))
}

#[tauri::command]
pub fn clipboard_clear() {
    LIST.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::DataExchange::{
        AddClipboardFormatListener, CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
        OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_UNICODETEXT;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, HWND_MESSAGE, MSG,
        WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLIPBOARDUPDATE, WNDCLASSW,
    };

    static STARTED: AtomicBool = AtomicBool::new(false);

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// Opens the clipboard, trying a few times: another app may hold it for a moment.
    unsafe fn open(hwnd: Option<HWND>) -> bool {
        for _ in 0..8 {
            if OpenClipboard(hwnd).is_ok() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        false
    }

    /// The text on the clipboard, unless it is marked private.
    unsafe fn read_text(hwnd: HWND) -> Option<String> {
        if !open(Some(hwnd)) {
            return None;
        }
        let excluded = RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing"));
        let out = (|| {
            if excluded != 0 && IsClipboardFormatAvailable(excluded).is_ok() {
                return None;
            }
            if IsClipboardFormatAvailable(u32::from(CF_UNICODETEXT.0)).is_err() {
                return None;
            }
            let handle = GetClipboardData(u32::from(CF_UNICODETEXT.0)).ok()?;
            let global = HGLOBAL(handle.0);
            let size = GlobalSize(global) / 2;
            let ptr = GlobalLock(global) as *const u16;
            if ptr.is_null() {
                return None;
            }
            let units = std::slice::from_raw_parts(ptr, size);
            let len = units.iter().position(|&c| c == 0).unwrap_or(units.len());
            let text = String::from_utf16_lossy(&units[..len]);
            let _ = GlobalUnlock(global);
            Some(text)
        })();
        let _ = CloseClipboard();
        out
    }

    pub fn ensure_listener() {
        if STARTED.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = std::thread::Builder::new().name("coucou-clipboard".into()).spawn(|| unsafe {
            let instance = GetModuleHandleW(None).map(|m| m.into()).unwrap_or_default();
            let class = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: instance, lpszClassName: w!("CoucouClip"), ..Default::default() };
            RegisterClassW(&class);
            let hwnd = match CreateWindowExW(
                WINDOW_EX_STYLE::default(), w!("CoucouClip"), w!("Coucou clipboard"), WINDOW_STYLE::default(),
                0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(instance), None,
            ) {
                Ok(h) => h,
                Err(err) => {
                    crate::log::line(format!("clipboard history unavailable: {err}"));
                    STARTED.store(false, Ordering::Release);
                    return;
                }
            };
            if AddClipboardFormatListener(hwnd).is_err() {
                crate::log::line("clipboard history unavailable: no listener");
                STARTED.store(false, Ordering::Release);
                return;
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if msg.message == WM_CLIPBOARDUPDATE && ENABLED.load(Ordering::Acquire) {
                    if let Some(text) = read_text(hwnd) {
                        record(&text);
                    }
                }
                DispatchMessageW(&msg);
            }
        });
    }

    pub fn write(text: &str) -> bool {
        unsafe {
            if !open(None) {
                return false;
            }
            let mut units: Vec<u16> = text.encode_utf16().collect();
            units.push(0);
            let bytes = units.len() * 2;
            let ok = (|| {
                EmptyClipboard().ok()?;
                let global = GlobalAlloc(GMEM_MOVEABLE, bytes).ok()?;
                let ptr = GlobalLock(global) as *mut u16;
                if ptr.is_null() {
                    return None;
                }
                std::ptr::copy_nonoverlapping(units.as_ptr(), ptr, units.len());
                let _ = GlobalUnlock(global);
                // The clipboard owns the memory from here.
                SetClipboardData(u32::from(CF_UNICODETEXT.0), Some(HANDLE(global.0))).ok()?;
                Some(())
            })()
            .is_some();
            let _ = CloseClipboard();
            let _ = PCWSTR::null();
            ok
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn ensure_listener() {}
    pub fn write(_text: &str) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Uses the real clipboard (it replaces what you copied!): `cargo test live_clipboard -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_clipboard_records_what_is_copied() {
        sync(true);
        std::thread::sleep(std::time::Duration::from_millis(600));
        assert!(clipboard_copy_text_for_test("coucou live test one"));
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(clipboard_copy_text_for_test("coucou live test two"));
        std::thread::sleep(std::time::Duration::from_millis(800));
        let list = clipboard_list();
        println!("{:?}", list.iter().map(|e| e.text.as_str()).collect::<Vec<_>>());
        assert_eq!(list.first().map(|e| e.text.as_str()), Some("coucou live test two"));
        assert!(list.iter().any(|e| e.text == "coucou live test one"));
        // Giving one back puts it on the clipboard again and moves it up.
        let id = list.iter().find(|e| e.text == "coucou live test one").unwrap().id;
        assert!(clipboard_copy(id));
        std::thread::sleep(std::time::Duration::from_millis(800));
        assert_eq!(clipboard_list()[0].text, "coucou live test one");
        sync(false);
        assert!(clipboard_list().is_empty(), "turning it off forgets everything");
    }

    fn clipboard_copy_text_for_test(text: &str) -> bool {
        imp::write(text)
    }

    #[test]
    fn newest_first_without_blanks_or_repeats() {
        let mut list = Vec::new();
        assert!(push_entry(&mut list, "one\r\n", 1, 1));
        assert!(push_entry(&mut list, "two", 2, 2));
        assert!(!push_entry(&mut list, "   \n", 3, 3), "blank is ignored");
        assert!(!push_entry(&mut list, "two", 4, 4), "same as the last is ignored");
        assert!(push_entry(&mut list, "one", 5, 5), "an older one moves to the front");
        assert_eq!(list.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["one", "two"]);
    }

    #[test]
    fn thirty_entries_and_long_text_is_cut() {
        let mut list = Vec::new();
        for i in 0..40 {
            push_entry(&mut list, &format!("item {i}"), i, i);
        }
        assert_eq!(list.len(), MAX_ENTRIES);
        assert_eq!(list[0].text, "item 39");
        push_entry(&mut list, &"x".repeat(MAX_CHARS + 500), 99, 99);
        assert_eq!(list[0].text.chars().count(), MAX_CHARS);
    }
}

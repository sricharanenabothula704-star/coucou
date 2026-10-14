// Screen time — which app is in front, and for how long. Off until the user
// turns on Settings → Dashboard → Screen time.
//
// While it is on, one thread looks at the foreground window every 5 s. A
// computer nobody has touched for 2 minutes is not counted, unless something
// is playing (a film watched without touching the mouse is still screen time).
// Only the executable's name and seconds are kept — never a window title, a
// page or a document — in %APPDATA%\Coucou\screentime.json, 30 days.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

const TICK_SECS: u64 = 5;
/// No input for this long: away.
pub const IDLE_SECS: u64 = 120;
const KEEP_DAYS: usize = 30;
/// Written at most this often (and when tracking stops).
const SAVE_EVERY_TICKS: u32 = 12;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    /// Executable → seconds in front.
    pub apps: BTreeMap<String, u64>,
    /// Seconds someone was there.
    pub active: u64,
    /// First and last activity, minutes since local midnight.
    pub first: Option<u32>,
    pub last: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct History {
    /// "YYYY-MM-DD" → that day.
    pub days: BTreeMap<String, Day>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScreenTime {
    pub tracking: bool,
    pub today: String,
    pub days: BTreeMap<String, Day>,
    /// In front right now.
    pub current: Option<String>,
    /// The app used before it.
    pub previous: Option<String>,
    pub idle_secs: u64,
}

// ── Pure rules ────────────────────────────────────────────────────────────────

/// One tick in front of `app`, at `minute` of `day`.
pub fn record(history: &mut History, day: &str, minute: u32, app: &str, secs: u64) {
    let d = history.days.entry(day.to_string()).or_default();
    *d.apps.entry(app.to_string()).or_insert(0) += secs;
    d.active += secs;
    d.first = Some(d.first.map_or(minute, |f| f.min(minute)));
    d.last = Some(d.last.map_or(minute, |l| l.max(minute)));
}

/// Keeps the newest `keep` days.
pub fn prune(history: &mut History, keep: usize) {
    while history.days.len() > keep {
        let oldest = history.days.keys().next().cloned();
        match oldest {
            Some(k) => history.days.remove(&k),
            None => break,
        };
    }
}

/// Coucou's own windows are not "an app you used".
pub fn counts(app: &str) -> bool {
    let lower = app.to_ascii_lowercase();
    !(lower.is_empty() || lower == "coucou.exe" || lower == "lockapp.exe" || lower == "searchhost.exe")
}

// ── State ─────────────────────────────────────────────────────────────────────

static RUNNING: AtomicBool = AtomicBool::new(false);
static LIVE: Mutex<Option<History>> = Mutex::new(None);
static NOW: Mutex<(Option<String>, Option<String>, u64)> = Mutex::new((None, None, 0));

fn path() -> PathBuf {
    crate::platform::config_dir().join("screentime.json")
}

fn load() -> History {
    std::fs::read(path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save(history: &History) {
    let path = path();
    if let Some(dir) = path.parent() {
        let _ = crate::platform::ensure_private_dir(dir);
    }
    if let Ok(json) = serde_json::to_vec(history) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

fn with_history<T>(f: impl FnOnce(&mut History) -> T) -> T {
    let mut guard = LIVE.lock().unwrap_or_else(|e| e.into_inner());
    let h = guard.get_or_insert_with(load);
    f(h)
}

/// Starts or stops the tracker to match the setting.
pub fn sync(on: bool) {
    if on && !RUNNING.swap(true, Ordering::AcqRel) {
        let _ = std::thread::Builder::new().name("coucou-screentime".into()).spawn(run);
    } else if !on {
        RUNNING.store(false, Ordering::Release);
    }
}

fn run() {
    let mut ticks = 0u32;
    while RUNNING.load(Ordering::Acquire) {
        std::thread::sleep(std::time::Duration::from_secs(TICK_SECS));
        if !RUNNING.load(Ordering::Acquire) {
            break;
        }
        let idle = imp::idle_secs();
        let front = imp::foreground_exe();
        {
            let mut now = NOW.lock().unwrap_or_else(|e| e.into_inner());
            now.2 = idle;
            if let Some(app) = front.as_ref().filter(|a| counts(a)) {
                if now.0.as_deref() != Some(app.as_str()) {
                    let prev = now.0.replace(app.clone());
                    if prev.is_some() {
                        now.1 = prev;
                    }
                }
            }
        }
        let here = idle < IDLE_SECS || super::media::playing();
        if let (true, Some(app)) = (here, front.filter(|a| counts(a))) {
            let t = crate::platform::local_time();
            let day = format!("{:04}-{:02}-{:02}", t.year, t.month, t.day);
            with_history(|h| record(h, &day, t.hour * 60 + t.minute, &app, TICK_SECS));
        }
        ticks += 1;
        if ticks % SAVE_EVERY_TICKS == 0 {
            with_history(|h| {
                prune(h, KEEP_DAYS);
                save(h);
            });
        }
    }
    with_history(|h| save(h));
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn screentime_get() -> ScreenTime {
    let t = crate::platform::local_time();
    let today = format!("{:04}-{:02}-{:02}", t.year, t.month, t.day);
    let days = with_history(|h| {
        // The last week is all any view shows.
        h.days.iter().rev().take(8).map(|(k, v)| (k.clone(), v.clone())).collect()
    });
    let now = NOW.lock().unwrap_or_else(|e| e.into_inner()).clone();
    ScreenTime {
        tracking: RUNNING.load(Ordering::Acquire),
        today,
        days,
        current: now.0,
        previous: now.1,
        idle_secs: if RUNNING.load(Ordering::Acquire) { now.2 } else { imp::idle_secs() },
    }
}

#[tauri::command]
pub fn screentime_clear() {
    with_history(|h| {
        h.days.clear();
        save(h);
    });
}

/// Seconds since the last key or mouse input, for the focus timer too.
pub fn idle_secs() -> u64 {
    imp::idle_secs()
}

// ── Windows ───────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    pub fn idle_secs() -> u64 {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
            return 0;
        }
        let now = unsafe { GetTickCount() };
        (now.wrapping_sub(info.dwTime) / 1000) as u64
    }

    pub fn foreground_exe() -> Option<String> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return None;
            }
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(handle);
            if !ok {
                return None;
            }
            let full = String::from_utf16_lossy(&buf[..len as usize]);
            full.rsplit('\\').next().map(str::to_string)
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn idle_secs() -> u64 {
        0
    }
    pub fn foreground_exe() -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_add_up_per_app_and_per_day() {
        let mut h = History::default();
        record(&mut h, "2026-10-14", 9 * 60, "Code.exe", 5);
        record(&mut h, "2026-10-14", 9 * 60 + 1, "Code.exe", 5);
        record(&mut h, "2026-10-14", 8 * 60, "chrome.exe", 5);
        let d = &h.days["2026-10-14"];
        assert_eq!(d.apps["Code.exe"], 10);
        assert_eq!(d.active, 15);
        assert_eq!(d.first, Some(8 * 60));
        assert_eq!(d.last, Some(9 * 60 + 1));
    }

    #[test]
    fn only_the_newest_days_are_kept() {
        let mut h = History::default();
        for d in 1..=40 {
            record(&mut h, &format!("2026-09-{d:02}"), 0, "a.exe", 5);
        }
        prune(&mut h, 30);
        assert_eq!(h.days.len(), 30);
        assert!(!h.days.contains_key("2026-09-01"));
    }

    #[test]
    fn coucou_itself_is_not_screen_time() {
        assert!(!counts("Coucou.exe"));
        assert!(!counts(""));
        assert!(counts("chrome.exe"));
    }
}

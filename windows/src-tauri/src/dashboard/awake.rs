// Keep awake — stop the PC (and its screen) from going to sleep for a while.
//
// One thread holds Windows' "execution state" (the same thing a video player or
// PowerToys Awake sets) while the timer runs, and lets go when it ends or is
// turned off. It sleeps on a condition variable: no polling. Nothing is kept
// across a restart, so Coucou never leaves the PC awake behind your back.

use serde::Serialize;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const EVENT: &str = "awake";
const MAX_MINUTES: u32 = 24 * 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Off,
    Until(Instant),
    Forever,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AwakeState {
    pub on: bool,
    pub forever: bool,
    /// Milliseconds left; 0 when off or forever.
    pub left_ms: u64,
}

/// What a request means: `forever`, or `minutes` (0 = off, up to a day).
pub fn mode_for(minutes: u32, forever: bool, now: Instant) -> Mode {
    if forever {
        Mode::Forever
    } else if minutes == 0 {
        Mode::Off
    } else {
        Mode::Until(now + Duration::from_secs(u64::from(minutes.min(MAX_MINUTES)) * 60))
    }
}

pub fn state_of(mode: Mode, now: Instant) -> AwakeState {
    match mode {
        Mode::Off => AwakeState { on: false, forever: false, left_ms: 0 },
        Mode::Forever => AwakeState { on: true, forever: true, left_ms: 0 },
        Mode::Until(t) if t > now => AwakeState { on: true, forever: false, left_ms: (t - now).as_millis() as u64 },
        Mode::Until(_) => AwakeState { on: false, forever: false, left_ms: 0 },
    }
}

static MODE: Mutex<Mode> = Mutex::new(Mode::Off);
static WAKE: Condvar = Condvar::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
static STARTED: OnceLock<()> = OnceLock::new();

pub fn setup(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

fn ensure_thread() {
    STARTED.get_or_init(|| {
        let _ = std::thread::Builder::new().name("coucou-awake".into()).spawn(run);
    });
}

fn run() {
    let mut guard = MODE.lock().unwrap_or_else(|e| e.into_inner());
    let mut holding = false;
    loop {
        if matches!(*guard, Mode::Until(t) if t <= Instant::now()) {
            *guard = Mode::Off;
            if let Some(app) = APP.get() {
                let _ = app.emit(EVENT, state_of(Mode::Off, Instant::now()));
            }
        }
        let want = !matches!(*guard, Mode::Off);
        if want != holding {
            imp::hold(want);
            holding = want;
        }
        guard = match *guard {
            Mode::Until(t) => {
                let wait = t.saturating_duration_since(Instant::now()).max(Duration::from_millis(50));
                WAKE.wait_timeout(guard, wait).unwrap_or_else(|e| e.into_inner()).0
            }
            _ => WAKE.wait(guard).unwrap_or_else(|e| e.into_inner()),
        };
    }
}

#[tauri::command]
pub fn awake_get() -> AwakeState {
    state_of(*MODE.lock().unwrap_or_else(|e| e.into_inner()), Instant::now())
}

/// `minutes` 0 turns it off; `forever` keeps it on until turned off.
#[tauri::command]
pub fn awake_set(minutes: u32, forever: bool) -> AwakeState {
    ensure_thread();
    let mode = mode_for(minutes, forever, Instant::now());
    *MODE.lock().unwrap_or_else(|e| e.into_inner()) = mode;
    WAKE.notify_all();
    crate::log::line(format!("keep awake: {mode:?}"));
    state_of(mode, Instant::now())
}

#[cfg(windows)]
mod imp {
    use windows::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
    };

    /// Called from the awake thread only: the state belongs to the thread that sets it.
    pub fn hold(on: bool) {
        let flags = if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED } else { ES_CONTINUOUS };
        unsafe {
            SetThreadExecutionState(flags);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn hold(_on: bool) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_is_off_for_a_time_or_forever() {
        let now = Instant::now();
        assert_eq!(mode_for(0, false, now), Mode::Off);
        assert_eq!(mode_for(30, true, now), Mode::Forever);
        assert_eq!(mode_for(30, false, now), Mode::Until(now + Duration::from_secs(1800)));
        // A day at most.
        assert_eq!(mode_for(99_999, false, now), Mode::Until(now + Duration::from_secs(24 * 3600)));
    }

    /// Holds the real execution state for a moment: `cargo test live_awake -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_awake_turns_on_and_off() {
        let on = awake_set(1, false);
        assert!(on.on && on.left_ms > 50_000);
        std::thread::sleep(Duration::from_millis(400));
        assert!(awake_get().on);
        assert!(!awake_set(0, false).on);
        assert!(!awake_get().on);
        println!("mic/camera in use now: {:?}", crate::dashboard::privacy::privacy_in_use());
    }

    #[test]
    fn the_state_counts_down_and_ends() {
        let now = Instant::now();
        let s = state_of(Mode::Until(now + Duration::from_secs(60)), now);
        assert!(s.on && !s.forever && s.left_ms == 60_000);
        assert!(!state_of(Mode::Until(now), now).on);
        assert!(state_of(Mode::Forever, now).forever);
        assert!(!state_of(Mode::Off, now).on);
    }
}

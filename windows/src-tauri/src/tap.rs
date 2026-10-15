// Tap Ctrl+Shift — press Ctrl and Shift together and let go, with no other key
// in between — to open or close the island (the "toggleIsland" action).
//
// Global shortcuts need a key besides the modifiers, so this one is watched by
// a low-level keyboard hook instead. The hook only looks: every key goes on to
// the app in front, untouched, and nothing typed is kept. Ctrl+Shift+T,
// Ctrl+Shift+Esc and the like never count as a tap, because another key came
// in between. Off in Settings → Shortcuts; while off the hook isn't there.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// Longer than this from the second modifier to the release is a hold, not a tap.
const TAP_WINDOW: Duration = Duration::from_millis(700);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Ctrl,
    Shift,
    Other,
}

/// The tap's rule, apart from the hook so it can be tested.
#[derive(Default, Debug)]
pub struct Tap {
    ctrl: bool,
    shift: bool,
    both_at: Option<Instant>,
    spoiled: bool,
}

impl Tap {
    /// One key event; true when it completes a tap.
    pub fn on_key(&mut self, key: Key, down: bool, now: Instant) -> bool {
        match (key, down) {
            (Key::Other, true) => {
                self.spoiled = true;
                false
            }
            (Key::Other, false) => false,
            (modifier, true) => {
                if !self.ctrl && !self.shift {
                    // A fresh start: nothing of a previous chord counts.
                    self.spoiled = false;
                    self.both_at = None;
                }
                match modifier {
                    Key::Ctrl => self.ctrl = true,
                    _ => self.shift = true,
                }
                if self.ctrl && self.shift && self.both_at.is_none() {
                    self.both_at = Some(now);
                }
                false
            }
            (modifier, false) => {
                match modifier {
                    Key::Ctrl => self.ctrl = false,
                    _ => self.shift = false,
                }
                if self.ctrl || self.shift {
                    return false;
                }
                let fired = !self.spoiled && self.both_at.is_some_and(|at| now.duration_since(at) <= TAP_WINDOW);
                self.both_at = None;
                self.spoiled = false;
                fired
            }
        }
    }
}

static ENABLED: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Starts or stops watching to match the setting.
pub fn sync(app: &AppHandle, on: bool) {
    let _ = APP.set(app.clone());
    ENABLED.store(on, Ordering::Release);
    if on {
        imp::ensure_hook();
    }
}

fn fire() {
    if let Some(app) = APP.get() {
        // Off the hook's thread: the hook must return at once.
        let app = app.clone();
        std::thread::spawn(move || crate::shortcuts::dispatch(&app, "toggleIsland"));
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::Mutex;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_CONTROL, VK_LCONTROL, VK_LSHIFT, VK_RCONTROL, VK_RSHIFT, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, HC_ACTION, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN,
        WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    static STARTED: AtomicBool = AtomicBool::new(false);
    static STATE: Mutex<Option<Tap>> = Mutex::new(None);

    unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 && ENABLED.load(Ordering::Acquire) {
            let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let vk = info.vkCode as u16;
            let key = if [VK_LCONTROL.0, VK_RCONTROL.0, VK_CONTROL.0].contains(&vk) {
                Key::Ctrl
            } else if [VK_LSHIFT.0, VK_RSHIFT.0, VK_SHIFT.0].contains(&vk) {
                Key::Shift
            } else {
                Key::Other
            };
            let msg = wparam.0 as u32;
            let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            if down || up {
                let fired = STATE
                    .try_lock()
                    .map(|mut s| s.get_or_insert_with(Tap::default).on_key(key, down, Instant::now()))
                    .unwrap_or(false);
                if fired {
                    fire();
                }
            }
        }
        // Never swallowed: the key always goes on.
        CallNextHookEx(None, code, wparam, lparam)
    }

    pub fn ensure_hook() {
        if STARTED.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = std::thread::Builder::new().name("coucou-tap".into()).spawn(|| unsafe {
            let module = GetModuleHandleW(None).ok().map(|m| m.into());
            match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), module, 0) {
                Ok(_) => {
                    // A low-level hook is called on the thread that set it, through its messages.
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
                }
                Err(err) => {
                    crate::log::line(format!("Ctrl+Shift tap unavailable: {err}"));
                    STARTED.store(false, Ordering::Release);
                }
            }
        });
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn ensure_hook() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(events: &[(Key, bool, u64)]) -> Vec<bool> {
        let start = Instant::now();
        let mut tap = Tap::default();
        events.iter().map(|&(k, d, ms)| tap.on_key(k, d, start + Duration::from_millis(ms))).collect()
    }

    #[test]
    fn ctrl_and_shift_pressed_and_let_go_is_a_tap() {
        let fired = run(&[(Key::Ctrl, true, 0), (Key::Shift, true, 40), (Key::Shift, false, 150), (Key::Ctrl, false, 170)]);
        assert_eq!(fired, [false, false, false, true]);
        // Either order, and key repeat while held.
        let fired = run(&[(Key::Shift, true, 0), (Key::Shift, true, 30), (Key::Ctrl, true, 50), (Key::Ctrl, false, 200), (Key::Shift, false, 210)]);
        assert_eq!(fired.last(), Some(&true));
    }

    #[test]
    fn a_shortcut_that_uses_them_is_not_a_tap() {
        // Ctrl+Shift+T, Ctrl+Shift+Esc…
        let fired = run(&[(Key::Ctrl, true, 0), (Key::Shift, true, 20), (Key::Other, true, 60), (Key::Other, false, 90), (Key::Shift, false, 120), (Key::Ctrl, false, 130)]);
        assert!(fired.iter().all(|f| !f));
        // Ctrl or Shift alone.
        assert!(run(&[(Key::Ctrl, true, 0), (Key::Ctrl, false, 50)]).iter().all(|f| !f));
        assert!(run(&[(Key::Shift, true, 0), (Key::Shift, false, 50)]).iter().all(|f| !f));
    }

    #[test]
    fn holding_them_is_not_a_tap_and_the_next_tap_starts_clean() {
        let start = Instant::now();
        let mut tap = Tap::default();
        let at = |ms| start + Duration::from_millis(ms);
        tap.on_key(Key::Ctrl, true, at(0));
        tap.on_key(Key::Shift, true, at(10));
        tap.on_key(Key::Shift, false, at(1500));
        assert!(!tap.on_key(Key::Ctrl, false, at(1510)));
        // A spoiled chord doesn't spoil the next one.
        tap.on_key(Key::Ctrl, true, at(2000));
        tap.on_key(Key::Other, true, at(2010));
        tap.on_key(Key::Ctrl, false, at(2020));
        tap.on_key(Key::Ctrl, true, at(3000));
        tap.on_key(Key::Shift, true, at(3010));
        tap.on_key(Key::Ctrl, false, at(3100));
        assert!(tap.on_key(Key::Shift, false, at(3110)));
    }
}

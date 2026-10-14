// The Focus pill — a Pomodoro timer that runs itself.
//
// Focus 25 min, short break 5, a long break 15 after every 4 focus rounds (all
// set in Settings). "Automatic" means: the next phase starts on its own; a
// focus round starts by itself when a Claude Code session starts working (the
// island asks, `focus_command("auto")`); and a focus round pauses when nobody
// has touched the computer for 2 minutes, then carries on when they're back.
//
// The timer lives here, not in a page, so the island and the dashboard show
// the same one and it keeps going while the island is hidden. One thread
// sleeps until the phase ends; it only wakes earlier (every 15 s) during a
// focus round to notice someone left. Every change goes to the pages as
// "focus"; a phase that ends goes as "focus-end" (Mochi's sound, a peek).

use serde::{Deserialize, Serialize};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const STATE_EVENT: &str = "focus";
pub const END_EVENT: &str = "focus-end";
const IDLE_CHECK: Duration = Duration::from_secs(15);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    Focus,
    Short,
    Long,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FocusPrefs {
    pub focus_min: u32,
    pub short_min: u32,
    pub long_min: u32,
    pub rounds: u32,
    /// The next phase starts by itself.
    pub auto_advance: bool,
    /// A focus round starts when an agent starts working.
    pub auto_start: bool,
    /// A focus round pauses while nobody is there.
    pub idle_pause: bool,
}

impl Default for FocusPrefs {
    fn default() -> Self {
        FocusPrefs { focus_min: 25, short_min: 5, long_min: 15, rounds: 4, auto_advance: true, auto_start: true, idle_pause: true }
    }
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FocusState {
    pub phase: Phase,
    pub running: bool,
    /// Unix ms the phase ends at, while running.
    pub ends_at: u64,
    /// Milliseconds left, while paused.
    pub left_ms: u64,
    /// Whole phase, ms (for the ring).
    pub total_ms: u64,
    /// Focus rounds done since the last long break.
    pub round: u32,
    pub rounds: u32,
    /// Paused because nobody was there; it resumes on its own.
    pub away: bool,
    /// Today: focus rounds finished, and minutes focused.
    pub today_rounds: u32,
    pub today_min: u32,
    pub day: String,
}

// ── Pure rules ────────────────────────────────────────────────────────────────

/// What follows a phase that ended: (phase, focus rounds done in this cycle).
pub fn next_phase(ended: Phase, round: u32, rounds: u32) -> (Phase, u32) {
    match ended {
        Phase::Focus => {
            let done = round + 1;
            if done >= rounds.max(1) { (Phase::Long, done) } else { (Phase::Short, done) }
        }
        Phase::Long => (Phase::Focus, 0),
        Phase::Short | Phase::Idle => (Phase::Focus, round),
    }
}

pub fn phase_ms(phase: Phase, p: &FocusPrefs) -> u64 {
    let min = match phase {
        Phase::Focus => p.focus_min,
        Phase::Short => p.short_min,
        Phase::Long => p.long_min,
        Phase::Idle => 0,
    };
    u64::from(min.clamp(1, 180)) * 60_000
}

// ── The timer ─────────────────────────────────────────────────────────────────

struct Timer {
    state: FocusState,
    prefs: FocusPrefs,
}

static TIMER: Mutex<Option<Timer>> = Mutex::new(None);
static WAKE: Condvar = Condvar::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn path() -> std::path::PathBuf {
    crate::platform::config_dir().join("focus.json")
}

/// Today's totals survive a restart; another day starts from zero.
fn load_today(day: &str) -> (u32, u32) {
    let v: serde_json::Value = std::fs::read(path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    if v["day"].as_str() == Some(day) {
        (v["rounds"].as_u64().unwrap_or(0) as u32, v["minutes"].as_u64().unwrap_or(0) as u32)
    } else {
        (0, 0)
    }
}

fn save_today(s: &FocusState) {
    let _ = crate::platform::ensure_private_dir(&crate::platform::config_dir());
    let _ = std::fs::write(
        path(),
        serde_json::json!({ "day": s.day, "rounds": s.today_rounds, "minutes": s.today_min }).to_string(),
    );
}

fn with<T>(f: impl FnOnce(&mut Timer) -> T) -> T {
    let mut guard = TIMER.lock().unwrap_or_else(|e| e.into_inner());
    let timer = guard.get_or_insert_with(|| {
        let day = super::media::today();
        let (today_rounds, today_min) = load_today(&day);
        let prefs = FocusPrefs::default();
        Timer {
            state: FocusState { rounds: prefs.rounds, today_rounds, today_min, day, ..Default::default() },
            prefs,
        }
    });
    let out = f(timer);
    WAKE.notify_all();
    out
}

fn emit(s: &FocusState) {
    if let Some(app) = APP.get() {
        let _ = app.emit(STATE_EVENT, s);
    }
}

fn start_phase(t: &mut Timer, phase: Phase) {
    let total = phase_ms(phase, &t.prefs);
    t.state.phase = phase;
    t.state.total_ms = total;
    t.state.running = true;
    t.state.away = false;
    t.state.ends_at = now_ms() + total;
    t.state.left_ms = total;
}

fn left(s: &FocusState) -> u64 {
    if s.running { s.ends_at.saturating_sub(now_ms()) } else { s.left_ms }
}

/// The phase that just ran out: count it, then the next one (or stop).
fn finish(t: &mut Timer) {
    let ended = t.state.phase;
    let day = super::media::today();
    if t.state.day != day {
        t.state.day = day;
        t.state.today_rounds = 0;
        t.state.today_min = 0;
    }
    if ended == Phase::Focus {
        t.state.today_rounds += 1;
        t.state.today_min += (t.state.total_ms / 60_000) as u32;
        save_today(&t.state);
    }
    let (next, round) = next_phase(ended, t.state.round, t.prefs.rounds);
    t.state.round = round;
    if t.prefs.auto_advance {
        start_phase(t, next);
    } else {
        t.state.phase = next;
        t.state.running = false;
        t.state.total_ms = phase_ms(next, &t.prefs);
        t.state.left_ms = t.state.total_ms;
    }
    if let Some(app) = APP.get() {
        let _ = app.emit(END_EVENT, serde_json::json!({ "ended": ended, "next": next }));
    }
}

fn run() {
    let mut guard = TIMER.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        let wait = match guard.as_mut() {
            Some(t) => {
                let s = &mut t.state;
                // Someone left during a focus round: hold it; back: carry on.
                if t.prefs.idle_pause && s.phase == Phase::Focus {
                    let idle = super::screentime::idle_secs() >= super::screentime::IDLE_SECS;
                    if s.running && idle && !super::media::playing() {
                        s.left_ms = left(s);
                        s.running = false;
                        s.away = true;
                        emit(s);
                    } else if s.away && !idle {
                        s.running = true;
                        s.away = false;
                        s.ends_at = now_ms() + s.left_ms;
                        emit(s);
                    }
                }
                if t.state.running && left(&t.state) == 0 {
                    finish(t);
                    emit(&t.state);
                }
                let s = &t.state;
                let until_end = if s.running { Duration::from_millis(left(s).max(50)) } else { Duration::MAX };
                let idle_watch = s.phase == Phase::Focus && t.prefs.idle_pause && (s.running || s.away);
                if idle_watch { until_end.min(IDLE_CHECK) } else { until_end }
            }
            None => Duration::MAX,
        };
        guard = if wait == Duration::MAX {
            WAKE.wait(guard).unwrap_or_else(|e| e.into_inner())
        } else {
            WAKE.wait_timeout(guard, wait).unwrap_or_else(|e| e.into_inner()).0
        };
    }
}

pub fn setup(app: &AppHandle, prefs: FocusPrefs) {
    if APP.set(app.clone()).is_ok() {
        let _ = std::thread::Builder::new().name("coucou-focus".into()).spawn(run);
    }
    set_prefs(prefs);
}

pub fn set_prefs(prefs: FocusPrefs) {
    with(|t| {
        t.prefs = prefs;
        t.state.rounds = prefs.rounds;
        if !t.state.running && t.state.phase != Phase::Idle {
            t.state.total_ms = phase_ms(t.state.phase, &prefs);
            t.state.left_ms = t.state.total_ms;
        }
        emit(&t.state);
    });
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub enum FocusAction {
    /// Starts a focus round (or carries on a paused one).
    Start,
    Pause,
    /// Ends this phase now and moves to the next.
    Skip,
    /// Back to idle; today's totals stay.
    Reset,
    /// An agent started working: a focus round, if nothing runs and the user wants it.
    Auto,
}

#[tauri::command]
pub fn focus_get() -> FocusState {
    with(|t| {
        let mut s = t.state.clone();
        s.left_ms = left(&s);
        s
    })
}

#[tauri::command]
pub fn focus_command(action: FocusAction) -> FocusState {
    with(|t| {
        match action {
            FocusAction::Start => {
                if t.state.phase == Phase::Idle {
                    start_phase(t, Phase::Focus);
                } else if !t.state.running {
                    t.state.running = true;
                    t.state.away = false;
                    t.state.ends_at = now_ms() + t.state.left_ms;
                }
            }
            FocusAction::Pause => {
                if t.state.running {
                    t.state.left_ms = left(&t.state);
                    t.state.running = false;
                    t.state.away = false;
                }
            }
            FocusAction::Skip => {
                if t.state.phase != Phase::Idle {
                    // A skipped focus round is not counted as focused.
                    if t.state.phase == Phase::Focus {
                        t.state.phase = Phase::Short;
                    }
                    let (next, round) = next_phase(t.state.phase, t.state.round, t.prefs.rounds);
                    t.state.round = round;
                    start_phase(t, next);
                    if !t.prefs.auto_advance {
                        t.state.running = false;
                    }
                }
            }
            FocusAction::Reset => {
                let keep = (t.state.today_rounds, t.state.today_min, t.state.day.clone());
                t.state = FocusState {
                    rounds: t.prefs.rounds,
                    today_rounds: keep.0,
                    today_min: keep.1,
                    day: keep.2,
                    ..Default::default()
                };
            }
            FocusAction::Auto => {
                if t.prefs.auto_start && t.state.phase == Phase::Idle {
                    start_phase(t, Phase::Focus);
                }
            }
        }
        emit(&t.state);
        let mut s = t.state.clone();
        s.left_ms = left(&s);
        s
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn four_focus_rounds_then_a_long_break_then_it_starts_over() {
        let mut phase = Phase::Idle;
        let mut round = 0;
        let mut seen = Vec::new();
        for _ in 0..9 {
            let (p, r) = next_phase(phase, round, 4);
            phase = p;
            round = r;
            seen.push(p);
        }
        assert_eq!(
            seen,
            vec![
                Phase::Focus, Phase::Short, Phase::Focus, Phase::Short, Phase::Focus,
                Phase::Short, Phase::Focus, Phase::Long, Phase::Focus,
            ]
        );
    }

    #[test]
    fn lengths_come_from_the_settings_and_stay_sensible() {
        let p = FocusPrefs { focus_min: 50, short_min: 0, long_min: 999, ..Default::default() };
        assert_eq!(phase_ms(Phase::Focus, &p), 50 * 60_000);
        assert_eq!(phase_ms(Phase::Short, &p), 60_000);
        assert_eq!(phase_ms(Phase::Long, &p), 180 * 60_000);
    }

    #[test]
    fn one_round_cycles_go_straight_to_the_long_break() {
        assert_eq!(next_phase(Phase::Focus, 0, 1), (Phase::Long, 1));
        assert_eq!(next_phase(Phase::Focus, 0, 0), (Phase::Long, 1));
    }
}

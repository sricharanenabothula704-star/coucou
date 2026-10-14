// Claude jobs — work handed to Claude Code, now or at a set time.
//
// A job is a prompt and a folder. At its time (once, every day, or on
// weekdays) Coucou runs `claude -p "<prompt>"` in that folder, the way you
// would in a terminal: Claude Code's own hooks still ask Coucou before a tool
// runs, so its permission requests show in the island with Allow / Deny like
// any session (unless the job lets it edit files without asking). The answer
// is kept with the job and shown in the dashboard.
//
// Jobs live in %APPDATA%\Coucou\jobs.json. While at least one is on, one
// thread looks at the clock every 30 s; with none, nothing runs.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const EVENT: &str = "job";
const TICK: Duration = Duration::from_secs(30);
/// A run that takes longer is stopped.
const TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// What is kept of an answer.
const MAX_OUTPUT: usize = 8000;
const MAX_JOBS: usize = 50;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Repeat {
    #[default]
    Once,
    Daily,
    Weekdays,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Job {
    pub id: String,
    pub prompt: String,
    /// Where Claude Code runs; the home folder when empty.
    pub folder: String,
    /// Local time, "HH:MM".
    pub at: String,
    /// For a one-off: the local day, "YYYY-MM-DD" (today when empty).
    pub date: String,
    pub repeat: Repeat,
    pub enabled: bool,
    /// `--permission-mode acceptEdits`: edits without asking (commands still ask).
    pub auto_edit: bool,
    /// "YYYY-MM-DD HH:MM" of the last run, so a minute never runs twice.
    pub last_slot: String,
    pub last_run: Option<u64>,
    pub last_ok: Option<bool>,
    pub last_output: String,
    #[serde(skip_deserializing)]
    pub running: bool,
}

// ── Pure rules ────────────────────────────────────────────────────────────────

/// 0 = Sunday … 6 = Saturday (Sakamoto).
pub fn weekday(y: u32, m: u32, d: u32) -> u32 {
    const T: [u32; 12] = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let y = if m < 3 { y - 1 } else { y };
    (y + y / 4 - y / 100 + y / 400 + T[(m - 1) as usize] + d) % 7
}

pub fn parse_hm(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.trim().split_once(':')?;
    let (h, m) = (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?);
    (h < 24 && m < 60).then_some((h, m))
}

/// Is `job` due at this local minute? `day` is "YYYY-MM-DD", `dow` 0 = Sunday.
pub fn due(job: &Job, day: &str, dow: u32, hour: u32, minute: u32) -> bool {
    if !job.enabled || job.running {
        return false;
    }
    let Some((h, m)) = parse_hm(&job.at) else { return false };
    if (h, m) != (hour, minute) {
        return false;
    }
    let slot = format!("{day} {h:02}:{m:02}");
    if job.last_slot == slot {
        return false;
    }
    match job.repeat {
        Repeat::Daily => true,
        Repeat::Weekdays => (1..=5).contains(&dow),
        Repeat::Once => job.date.is_empty() || job.date == day,
    }
}

/// The end of what Claude said, cut to MAX_OUTPUT on a char boundary.
pub fn keep_tail(text: &str) -> String {
    let t = text.trim();
    if t.len() <= MAX_OUTPUT {
        return t.to_string();
    }
    let mut start = t.len() - MAX_OUTPUT;
    while !t.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &t[start..])
}

// ── Store ─────────────────────────────────────────────────────────────────────

static JOBS: Mutex<Option<Vec<Job>>> = Mutex::new(None);
static RUNNING: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<AppHandle> = OnceLock::new();

fn path() -> PathBuf {
    crate::platform::config_dir().join("jobs.json")
}

fn with<T>(f: impl FnOnce(&mut Vec<Job>) -> T) -> T {
    let mut guard = JOBS.lock().unwrap_or_else(|e| e.into_inner());
    let jobs = guard.get_or_insert_with(|| {
        std::fs::read(path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    });
    f(jobs)
}

fn save(jobs: &[Job]) {
    let _ = crate::platform::ensure_private_dir(&crate::platform::config_dir());
    if let Ok(json) = serde_json::to_vec_pretty(jobs) {
        let p = path();
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn emit_all() {
    if let Some(app) = APP.get() {
        let list = with(|j| j.clone());
        let _ = app.emit(EVENT, list);
    }
}

/// Claude Code's command: on PATH, else where its installer puts it.
pub fn claude_exe() -> Option<PathBuf> {
    crate::platform::find_on_path("claude").or_else(|| {
        let home = crate::platform::home_dir();
        [home.join(".local").join("bin").join("claude.exe"), home.join(".claude").join("local").join("claude.exe")]
            .into_iter()
            .find(|p| p.is_file())
    })
}

// ── The clock ─────────────────────────────────────────────────────────────────

pub fn setup(app: &AppHandle) {
    let _ = APP.set(app.clone());
    sync();
}

/// The clock thread runs while at least one job is on.
fn sync() {
    let any = with(|j| j.iter().any(|x| x.enabled));
    if any && !RUNNING.swap(true, Ordering::AcqRel) {
        let _ = std::thread::Builder::new().name("coucou-jobs".into()).spawn(|| {
            while RUNNING.load(Ordering::Acquire) {
                let t = crate::platform::local_time();
                let day = format!("{:04}-{:02}-{:02}", t.year, t.month, t.day);
                let dow = weekday(t.year, t.month, t.day);
                let ready: Vec<String> =
                    with(|jobs| jobs.iter().filter(|j| due(j, &day, dow, t.hour, t.minute)).map(|j| j.id.clone()).collect());
                for id in ready {
                    start(&id, Some(format!("{day} {:02}:{:02}", t.hour, t.minute)));
                }
                if !with(|j| j.iter().any(|x| x.enabled)) {
                    RUNNING.store(false, Ordering::Release);
                    break;
                }
                std::thread::sleep(TICK);
            }
        });
    }
}

/// Runs a job on its own thread; `slot` marks the scheduled minute it took.
fn start(id: &str, slot: Option<String>) {
    let job = with(|jobs| {
        let j = jobs.iter_mut().find(|j| j.id == id)?;
        if j.running {
            return None;
        }
        j.running = true;
        if let Some(slot) = slot {
            j.last_slot = slot;
            if j.repeat == Repeat::Once {
                j.enabled = false;
            }
        }
        Some(j.clone())
    });
    let Some(job) = job else { return };
    with(|jobs| save(jobs));
    emit_all();
    let id = id.to_string();
    let _ = std::thread::Builder::new().name("coucou-job-run".into()).spawn(move || {
        let (ok, output) = run(&job);
        with(|jobs| {
            if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
                j.running = false;
                j.last_run = Some(now_ms());
                j.last_ok = Some(ok);
                j.last_output = keep_tail(&output);
            }
            save(jobs);
        });
        emit_all();
        if let Some(app) = APP.get() {
            let _ = app.emit("job-done", serde_json::json!({ "id": id, "ok": ok, "prompt": job.prompt }));
        }
        crate::log::line(format!("claude job {} {}", id, if ok { "done" } else { "failed" }));
    });
}

fn run(job: &Job) -> (bool, String) {
    let Some(exe) = claude_exe() else {
        return (false, "Claude Code was not found. Install it, or add `claude` to your PATH.".into());
    };
    let folder = if job.folder.trim().is_empty() { crate::platform::home_dir() } else { PathBuf::from(job.folder.trim()) };
    if !folder.is_dir() {
        return (false, format!("Folder not found: {}", folder.display()));
    }
    let mut cmd = Command::new(exe);
    cmd.arg("-p").arg(&job.prompt).args(["--output-format", "text"]);
    if job.auto_edit {
        cmd.args(["--permission-mode", "acceptEdits"]);
    }
    cmd.current_dir(&folder).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::platform::no_console(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return (false, format!("Could not start Claude Code: {e}")),
    };
    // Read both pipes on their own threads so a full pipe never blocks Claude.
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_string(&mut s);
        }
        s
    });
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() > TIMEOUT => {
                let _ = child.kill();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(500)),
            Err(_) => break None,
        }
    };
    let stdout = out_t.join().unwrap_or_default();
    let stderr = err_t.join().unwrap_or_default();
    match status {
        Some(s) if s.success() => (true, stdout),
        Some(_) => (false, if stdout.trim().is_empty() { stderr } else { stdout }),
        None => (false, "Stopped after 30 minutes.".into()),
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsView {
    pub jobs: Vec<Job>,
    /// Where `claude` was found, if it was.
    pub claude: Option<String>,
}

#[tauri::command]
pub fn jobs_list() -> JobsView {
    JobsView { jobs: with(|j| j.clone()), claude: claude_exe().map(|p| p.display().to_string()) }
}

/// Adds or replaces a job (an empty id is a new one). Returns it as stored.
#[tauri::command]
pub fn job_save(mut job: Job) -> Result<Job, String> {
    job.prompt = job.prompt.trim().to_string();
    if job.prompt.is_empty() {
        return Err("empty prompt".into());
    }
    if parse_hm(&job.at).is_none() {
        return Err("time must be HH:MM".into());
    }
    let saved = with(|jobs| {
        if job.id.is_empty() {
            if jobs.len() >= MAX_JOBS {
                return Err("too many jobs".to_string());
            }
            job.id = format!("j{}", now_ms());
            jobs.push(job.clone());
        } else if let Some(j) = jobs.iter_mut().find(|j| j.id == job.id) {
            let keep = (j.last_slot.clone(), j.last_run, j.last_ok, j.last_output.clone(), j.running);
            *j = job.clone();
            (j.last_slot, j.last_run, j.last_ok, j.last_output, j.running) = keep;
        } else {
            return Err("unknown job".to_string());
        }
        save(jobs);
        Ok(job.clone())
    })?;
    sync();
    emit_all();
    Ok(saved)
}

#[tauri::command]
pub fn job_delete(id: String) {
    with(|jobs| {
        jobs.retain(|j| j.id != id || j.running);
        save(jobs);
    });
    emit_all();
}

/// Runs a job now, whatever its time.
#[tauri::command]
pub fn job_run(id: String) {
    start(&id, None);
}

/// Hands a prompt to Claude Code right away; kept in the list with its answer.
#[tauri::command]
pub fn claude_prompt(prompt: String, folder: String, auto_edit: bool) -> Result<String, String> {
    let t = crate::platform::local_time();
    let job = job_save(Job {
        prompt,
        folder,
        at: format!("{:02}:{:02}", t.hour, t.minute),
        repeat: Repeat::Once,
        enabled: false,
        auto_edit,
        ..Default::default()
    })?;
    start(&job.id, None);
    Ok(job.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weekdays_are_right() {
        assert_eq!(weekday(2026, 10, 14), 3); // a Wednesday
        assert_eq!(weekday(2024, 1, 1), 1); // a Monday
        assert_eq!(weekday(2026, 3, 1), 0); // a Sunday
    }

    #[test]
    fn a_job_is_due_once_in_its_minute_on_its_days() {
        let mut j = Job { prompt: "x".into(), at: "09:30".into(), enabled: true, repeat: Repeat::Daily, ..Default::default() };
        assert!(due(&j, "2026-10-14", 3, 9, 30));
        assert!(!due(&j, "2026-10-14", 3, 9, 31));
        j.last_slot = "2026-10-14 09:30".into();
        assert!(!due(&j, "2026-10-14", 3, 9, 30));
        assert!(due(&j, "2026-10-15", 4, 9, 30));
        j.repeat = Repeat::Weekdays;
        j.last_slot.clear();
        assert!(!due(&j, "2026-10-18", 0, 9, 30));
        j.repeat = Repeat::Once;
        j.date = "2026-10-20".into();
        assert!(!due(&j, "2026-10-14", 3, 9, 30));
        assert!(due(&j, "2026-10-20", 2, 9, 30));
        j.enabled = false;
        assert!(!due(&j, "2026-10-20", 2, 9, 30));
    }

    #[test]
    fn times_and_long_answers() {
        assert_eq!(parse_hm("07:05"), Some((7, 5)));
        assert_eq!(parse_hm("24:00"), None);
        assert_eq!(parse_hm("nope"), None);
        let long = "é".repeat(MAX_OUTPUT);
        let kept = keep_tail(&long);
        assert!(kept.starts_with('…'));
        assert!(kept.len() <= MAX_OUTPUT + '…'.len_utf8());
    }
}

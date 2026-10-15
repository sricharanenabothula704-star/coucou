// The dashboard: Coucou's own big window with every tile at once — music,
// focus, Claude usage, the PC's vitals, screen time, news, weather — plus the
// System, Now Playing, Focus, Screen Time and News pills in the island.
//
// What each part reads, and when, is in its own file:
// - system.rs     — CPU, temperature, memory, disk, network, apps (only when asked)
// - media.rs      — whatever plays through Windows' media controls (events only)
// - screentime.rs — the app in front, every 5 s, only once the user turned it on
// - focus.rs      — the Pomodoro timer
// Here: the window, the preferences, and the few network calls, each to a
// place the user picked (their RSS feeds, their city, the speed test server)
// and only when a page asks.

pub mod awake;
pub mod cleanup;
pub mod clipboard;
pub mod focus;
pub mod jobs;
pub mod media;
pub mod notes;
pub mod privacy;
pub mod voice;
pub mod screentime;
pub mod system;

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const WINDOW_LABEL: &str = "dashboard";
/// Feeds, weather: a body this big is not what we asked for.
const MAX_BODY: usize = 2 * 1024 * 1024;
const MAX_FEEDS: usize = 12;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DashboardPrefs {
    /// screentime.rs runs only while this is on. Off by default.
    pub screen_time: bool,
    pub focus: focus::FocusPrefs,
    /// RSS or Atom feeds, read every 10 minutes while the News pill or the dashboard is on.
    pub news_feeds: Vec<String>,
    /// A headline with one of these, less than an hour old, is urgent.
    pub news_keywords: Vec<String>,
    /// An urgent headline peeks out of the island.
    pub news_alerts: bool,
    /// Open-Meteo is asked about this city, and only once it is set.
    pub weather_city: String,
    /// Where the speed test downloads from and uploads to; only when clicked.
    pub speed_test_url: String,
    /// Warn when memory, the system drive or the temperature run high.
    pub system_alerts: bool,
    /// Tile ids in the user's order; unknown ones are ignored, missing ones appended.
    pub tiles: Vec<String>,
    /// The chat gets a snapshot of the PC (what the dashboard shows) with each message.
    pub share_with_chat: bool,
    /// The chat may play music, run the focus timer, open the dashboard and
    /// propose Claude Code jobs (which wait for a click).
    pub let_chat_act: bool,
    /// Keep the last 30 texts you copied (clipboard.rs). Off by default; memory only.
    pub clipboard_history: bool,
}

impl Default for DashboardPrefs {
    fn default() -> Self {
        DashboardPrefs {
            screen_time: false,
            focus: focus::FocusPrefs::default(),
            news_feeds: vec![
                "https://feeds.bbci.co.uk/news/world/rss.xml".into(),
                "https://www.thehindu.com/news/national/feeder/default.rss".into(),
                "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en".into(),
            ],
            news_keywords: [
                "breaking", "live", "urgent", "earthquake", "explosion", "attack", "tsunami",
                "cyclone", "evacuat*", "killed", "dies", "dead", "deadly", "crash", "war",
            ]
            .map(String::from)
            .to_vec(),
            news_alerts: true,
            weather_city: String::new(),
            speed_test_url: "https://speed.cloudflare.com".into(),
            system_alerts: true,
            tiles: Vec::new(),
            share_with_chat: true,
            let_chat_act: true,
            clipboard_history: false,
        }
    }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

pub fn setup(app: &AppHandle, prefs: &DashboardPrefs) {
    create_window(app);
    awake::setup(app);
    clipboard::sync(prefs.clipboard_history);
    jobs::setup(app);
    focus::setup(app, prefs.focus);
    screentime::sync(prefs.screen_time);
}

pub fn settings_saved(prefs: &DashboardPrefs) {
    clipboard::sync(prefs.clipboard_history);
    focus::set_prefs(prefs.focus);
    screentime::sync(prefs.screen_time);
}

fn page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/dashboard.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("dashboard.html".into())
}

/// Like the settings window: made hidden at launch, before the island, and only
/// shown and hidden afterwards (a WebView2 window made later comes up blank).
fn create_window(app: &AppHandle) {
    match WebviewWindowBuilder::new(app, WINDOW_LABEL, page_url(app))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title(crate::i18n::t("Dashboard — Coucou"))
        .inner_size(1180.0, 760.0)
        .min_inner_size(720.0, 520.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => crate::log::line(format!("dashboard window failed: {err}")),
    }
}

pub fn show_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
        crate::log::line("dashboard window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
pub fn open_dashboard(app: AppHandle) {
    show_window(&app);
}

// ── Network: only what the user set up, only when a page asks ─────────────────

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("Coucou/", env!("CARGO_PKG_VERSION"), " (+https://github.com/Louis-CFM/coucou)"))
        .build()
        .unwrap_or_default()
}

pub fn is_web_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://")) && lower.len() > 10 && !lower.contains(char::is_whitespace)
}

async fn get_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BODY {
        return Err("too large".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    pub url: String,
    pub body: Option<String>,
    pub error: Option<String>,
}

/// The feeds in Settings, as text: the page parses them (DOMParser), so no XML
/// parser ships here. Only the saved feeds are fetched, whatever a page asks.
#[tauri::command]
pub async fn news_fetch(app: AppHandle) -> Vec<Feed> {
    let feeds = {
        let shared = app.state::<crate::Shared>();
        let settings = shared.settings.lock().unwrap_or_else(|e| e.into_inner());
        settings.dashboard.news_feeds.clone()
    };
    let client = client();
    let mut out = Vec::new();
    for url in feeds.into_iter().filter(|u| is_web_url(u)).take(MAX_FEEDS) {
        match get_text(&client, &url).await {
            Ok(body) => out.push(Feed { url, body: Some(body), error: None }),
            Err(e) => out.push(Feed { url, body: None, error: Some(e) }),
        }
    }
    out
}

/// Open-Meteo (no account, no key) for the city in Settings: where it is, then
/// the weather now and the next days.
#[tauri::command]
pub async fn weather_fetch(app: AppHandle) -> Result<serde_json::Value, String> {
    let city = {
        let shared = app.state::<crate::Shared>();
        let settings = shared.settings.lock().unwrap_or_else(|e| e.into_inner());
        settings.dashboard.weather_city.trim().to_string()
    };
    if city.is_empty() {
        return Err("no city".into());
    }
    let client = client();
    let geo: serde_json::Value = client
        .get("https://geocoding-api.open-meteo.com/v1/search")
        .query(&[("name", city.as_str()), ("count", "1")])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let place = &geo["results"][0];
    let (Some(lat), Some(lon)) = (place["latitude"].as_f64(), place["longitude"].as_f64()) else {
        return Err("city not found".into());
    };
    let forecast: serde_json::Value = client
        .get("https://api.open-meteo.com/v1/forecast")
        .query(&[
            ("latitude", lat.to_string()),
            ("longitude", lon.to_string()),
            ("current", "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day".into()),
            ("daily", "weather_code,temperature_2m_max,temperature_2m_min".into()),
            ("timezone", "auto".into()),
            ("forecast_days", "5".into()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "place": place["name"],
        "country": place["country_code"],
        "current": forecast["current"],
        "daily": forecast["daily"],
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedResult {
    pub ping_ms: f64,
    pub down_mbps: f64,
    pub up_mbps: f64,
}

pub fn mbps(bytes: usize, elapsed: Duration) -> f64 {
    let secs = elapsed.as_secs_f64().max(0.001);
    ((bytes as f64 * 8.0 / secs / 1_000_000.0) * 10.0).round() / 10.0
}

/// Only on a click: a small request for the ping, ~25 MB down, ~5 MB up, to the
/// server in Settings (Cloudflare's speed test by default).
#[tauri::command]
pub async fn speed_test(app: AppHandle) -> Result<SpeedResult, String> {
    let base = {
        let shared = app.state::<crate::Shared>();
        let settings = shared.settings.lock().unwrap_or_else(|e| e.into_inner());
        settings.dashboard.speed_test_url.trim().trim_end_matches('/').to_string()
    };
    if !is_web_url(&base) {
        return Err("no server".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(40))
        .build()
        .map_err(|e| e.to_string())?;

    let mut pings = Vec::new();
    for _ in 0..3 {
        let t = Instant::now();
        client.get(format!("{base}/__down?bytes=0")).send().await.map_err(|e| e.to_string())?;
        pings.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    pings.sort_by(f64::total_cmp);

    let t = Instant::now();
    let body = client
        .get(format!("{base}/__down?bytes=25000000"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    let down = mbps(body.len(), t.elapsed());

    let payload = vec![0u8; 5_000_000];
    let t = Instant::now();
    client
        .post(format!("{base}/__up"))
        .body(payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let up = mbps(5_000_000, t.elapsed());

    Ok(SpeedResult { ping_ms: (pings[0] * 10.0).round() / 10.0, down_mbps: down, up_mbps: up })
}

// ── Quick actions ─────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub enum QuickAction {
    TaskManager,
    Lock,
    /// The page asked the user to confirm first.
    EmptyRecycleBin,
    Snip,
    SoundSettings,
}

#[tauri::command]
pub fn quick_action(action: QuickAction) -> bool {
    imp_actions::run(action)
}

#[cfg(windows)]
mod imp_actions {
    use super::QuickAction;
    use std::process::Command;

    pub fn run(action: QuickAction) -> bool {
        match action {
            QuickAction::TaskManager => Command::new("taskmgr.exe").spawn().is_ok(),
            QuickAction::Lock => unsafe { windows::Win32::System::Shutdown::LockWorkStation().is_ok() },
            QuickAction::EmptyRecycleBin => unsafe {
                use windows::Win32::UI::Shell::{SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI};
                // S_OK, or "already empty" (E_UNEXPECTED on some builds): both mean empty now.
                let _ = SHEmptyRecycleBinW(None, windows::core::PCWSTR::null(), SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI);
                true
            },
            QuickAction::Snip => {
                crate::platform::open_url("ms-screenclip:");
                true
            }
            QuickAction::SoundSettings => {
                crate::platform::open_url("ms-settings:sound");
                true
            }
        }
    }
}

#[cfg(not(windows))]
mod imp_actions {
    pub fn run(_action: super::QuickAction) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_addresses_are_fetched() {
        assert!(is_web_url("https://feeds.bbci.co.uk/news/world/rss.xml"));
        assert!(is_web_url("http://example.com/feed"));
        assert!(!is_web_url("file:///C:/Windows/win.ini"));
        assert!(!is_web_url("javascript:alert(1)"));
        assert!(!is_web_url("https://exa mple.com"));
        assert!(!is_web_url(""));
    }

    #[test]
    fn megabits_per_second() {
        assert_eq!(mbps(12_500_000, Duration::from_secs(1)), 100.0);
        assert_eq!(mbps(0, Duration::from_secs(0)), 0.0);
    }

    #[test]
    fn an_older_settings_file_gets_the_defaults() {
        let p: DashboardPrefs = serde_json::from_str(r#"{ "screenTime": true }"#).unwrap();
        assert!(p.screen_time);
        assert_eq!(p.focus.focus_min, 25);
        assert!(!p.news_feeds.is_empty());
        assert_eq!(p.speed_test_url, "https://speed.cloudflare.com");
    }
}

// Now Playing on Windows: whatever plays through the system media controls —
// Spotify, YouTube in Edge or Chrome, VLC, Media Player… — the same source as
// the volume flyout in the taskbar.
//
// Nothing runs on a timer. One thread holds the session manager and wakes only
// when Windows signals that the current player, its track, its playback or its
// timeline changed; it then reads the player once and reports to every window
// ("media", and "media-artwork" when the cover changes). The page runs the
// position on from a timestamp, as the Spotify card does.
//
// Tracks heard for at least 30 s go to %APPDATA%\Coucou\listening.json (title,
// artist, app, seconds — nothing else) for "music played" in the dashboard.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Island and dashboard events.
pub const STATE_EVENT: &str = "media";
pub const ARTWORK_EVENT: &str = "media-artwork";
/// The biggest cover read (players hand over a few hundred KB at most).
const ARTWORK_LIMIT: u64 = 3 * 1024 * 1024;
/// Heard this long, a track counts as played.
const COUNTED_SECS: f64 = 30.0;
/// listening.json keeps this many tracks, oldest dropped first.
const MAX_PLAYS: usize = 3000;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    /// A player is there at all.
    pub active: bool,
    /// "Spotify", "Chrome", "Edge"…
    pub source: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    /// Seconds at `position_at` (Unix ms).
    pub position: f64,
    pub position_at: u64,
    /// Seconds; 0 when the player doesn't say (a live stream).
    pub duration: f64,
    pub can_next: bool,
    pub can_previous: bool,
    pub can_seek: bool,
    /// Matches the "media-artwork" event that carries this track's cover.
    pub art_key: String,
    /// 0…100, the default output device.
    pub volume: u8,
    pub muted: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Play {
    /// Local day, "YYYY-MM-DD".
    pub day: String,
    pub title: String,
    pub artist: String,
    pub source: String,
    pub secs: u32,
}

// ── Pure rules ────────────────────────────────────────────────────────────────

/// The app behind an App User Model ID, as a person would name it.
pub fn friendly_source(aumid: &str) -> String {
    let lower = aumid.to_ascii_lowercase();
    let known = [
        ("spotify", "Spotify"),
        ("msedge", "Edge"),
        ("chrome", "Chrome"),
        ("firefox", "Firefox"),
        // Firefox registers under its install hash.
        ("308046b0af4a39cb", "Firefox"),
        ("brave", "Brave"),
        ("opera", "Opera"),
        ("vlc", "VLC"),
        ("zunemusic", "Media Player"),
        ("zunevideo", "Films & TV"),
        ("applemusic", "Apple Music"),
        ("itunes", "iTunes"),
        ("amazonmusic", "Amazon Music"),
        ("deezer", "Deezer"),
        ("tidal", "TIDAL"),
        ("youtube", "YouTube Music"),
        ("foobar", "foobar2000"),
        ("musicbee", "MusicBee"),
        ("aimp", "AIMP"),
        ("discord", "Discord"),
    ];
    for (needle, name) in known {
        if lower.contains(needle) {
            return name.to_string();
        }
    }
    // "Some.App_8wekyb3d8bbwe!App" or "C:\…\player.exe" → "player".
    let tail = aumid.rsplit(['\\', '/']).next().unwrap_or(aumid);
    let tail = tail.split('!').next().unwrap_or(tail);
    let tail = tail.split('_').next().unwrap_or(tail);
    let tail = tail.trim_end_matches(".exe").trim_end_matches(".EXE");
    let tail = tail.rsplit('.').next().unwrap_or(tail);
    if tail.is_empty() { "Media".into() } else { tail.to_string() }
}

/// Windows DateTime (100 ns since 1601) → Unix ms.
pub fn filetime_to_unix_ms(ticks: i64) -> u64 {
    const EPOCH_DIFF: i64 = 116_444_736_000_000_000;
    if ticks <= EPOCH_DIFF { 0 } else { ((ticks - EPOCH_DIFF) / 10_000) as u64 }
}

pub fn art_key(s: &MediaState) -> String {
    if !s.active || (s.title.is_empty() && s.artist.is_empty()) {
        return String::new();
    }
    format!("{}\u{1f}{}\u{1f}{}", s.source, s.artist, s.title)
}

/// Adds a play, dropping the oldest past the cap.
pub fn push_play(plays: &mut Vec<Play>, play: Play) {
    plays.push(play);
    if plays.len() > MAX_PLAYS {
        let excess = plays.len() - MAX_PLAYS;
        plays.drain(..excess);
    }
}

fn plays_path() -> PathBuf {
    crate::platform::config_dir().join("listening.json")
}

pub fn read_plays() -> Vec<Play> {
    std::fs::read(plays_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_plays(plays: &[Play]) {
    let path = plays_path();
    if let Some(dir) = path.parent() {
        let _ = crate::platform::ensure_private_dir(dir);
    }
    if let Ok(json) = serde_json::to_vec(plays) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

pub fn today() -> String {
    let t = crate::platform::local_time();
    format!("{:04}-{:02}-{:02}", t.year, t.month, t.day)
}

/// Something is playing through the system media controls (screen time, focus).
pub fn playing() -> bool {
    imp::playing()
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub enum MediaAction {
    PlayPause,
    Next,
    Previous,
    /// `value`: seconds.
    Seek,
    /// `value`: 0…100.
    Volume,
    Mute,
}

#[tauri::command]
pub fn media_refresh(app: tauri::AppHandle) -> Option<MediaState> {
    imp::ensure_started(&app);
    imp::current()
}

#[tauri::command]
pub async fn media_control(app: tauri::AppHandle, action: MediaAction, value: Option<f64>) -> bool {
    imp::ensure_started(&app);
    tauri::async_runtime::spawn_blocking(move || imp::control(action, value))
        .await
        .unwrap_or(false)
}

/// Every track heard ≥ 30 s, oldest first.
#[tauri::command]
pub fn media_plays() -> Vec<Play> {
    read_plays()
}

// ── Windows ───────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};
    use windows::Foundation::TypedEventHandler;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

    static STARTED: OnceLock<Sender<()>> = OnceLock::new();
    static LAST: Mutex<Option<MediaState>> = Mutex::new(None);

    pub fn ensure_started(app: &AppHandle) {
        STARTED.get_or_init(|| {
            let (tx, rx) = channel();
            let app = app.clone();
            let wake = tx.clone();
            let _ = std::thread::Builder::new()
                .name("coucou-media".into())
                .spawn(move || run(app, wake, rx));
            tx
        });
    }

    pub fn playing() -> bool {
        LAST.lock().ok().and_then(|l| l.as_ref().map(|s| s.playing)).unwrap_or(false)
    }

    pub fn current() -> Option<MediaState> {
        // Ask the thread to read again (a seek made in the player is not always signalled).
        if let Some(tx) = STARTED.get() {
            let _ = tx.send(());
        }
        LAST.lock().ok()?.clone()
    }

    fn manager() -> Option<Manager> {
        Manager::RequestAsync().ok()?.get().ok()
    }

    struct Hooked {
        session: Session,
        tokens: [i64; 3],
    }

    impl Drop for Hooked {
        fn drop(&mut self) {
            let _ = self.session.RemoveMediaPropertiesChanged(self.tokens[0]);
            let _ = self.session.RemovePlaybackInfoChanged(self.tokens[1]);
            let _ = self.session.RemoveTimelinePropertiesChanged(self.tokens[2]);
        }
    }

    fn hook(session: &Session, tx: &Sender<()>) -> Option<Hooked> {
        let (a, b, c) = (tx.clone(), tx.clone(), tx.clone());
        let t0 = session
            .MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
                let _ = a.send(());
                Ok(())
            }))
            .ok()?;
        let t1 = session
            .PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
                let _ = b.send(());
                Ok(())
            }))
            .ok()?;
        let t2 = session
            .TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| {
                let _ = c.send(());
                Ok(())
            }))
            .ok()?;
        Some(Hooked { session: session.clone(), tokens: [t0, t1, t2] })
    }

    /// Track bookkeeping for listening.json.
    #[derive(Default)]
    struct Listening {
        key: String,
        title: String,
        artist: String,
        source: String,
        heard: f64,
        since: Option<Instant>,
        logged: bool,
    }

    impl Listening {
        fn update(&mut self, s: &MediaState) {
            let key = art_key(s);
            if let Some(since) = self.since.take() {
                self.heard += since.elapsed().as_secs_f64();
            }
            if key != self.key {
                self.flush();
                *self = Listening {
                    key,
                    title: s.title.clone(),
                    artist: s.artist.clone(),
                    source: s.source.clone(),
                    ..Default::default()
                };
            }
            if s.playing && !self.key.is_empty() {
                self.since = Some(Instant::now());
            }
        }

        fn flush(&mut self) {
            if self.logged || self.key.is_empty() || self.heard < COUNTED_SECS {
                return;
            }
            self.logged = true;
            let mut plays = read_plays();
            push_play(&mut plays, Play {
                day: today(),
                title: self.title.clone(),
                artist: self.artist.clone(),
                source: self.source.clone(),
                secs: self.heard.round() as u32,
            });
            write_plays(&plays);
        }
    }

    fn run(app: AppHandle, tx: Sender<()>, rx: Receiver<()>) {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let Some(manager) = manager() else {
            crate::log::line("media: no system media controls");
            return;
        };
        let wake = tx.clone();
        let _changed = manager.CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
            let _ = wake.send(());
            Ok(())
        }));
        let wake = tx.clone();
        let _sessions = manager.SessionsChanged(&TypedEventHandler::new(move |_, _| {
            let _ = wake.send(());
            Ok(())
        }));

        let mut hooked: Option<Hooked> = None;
        let mut listening = Listening::default();
        let mut art_sent = String::new();
        let _ = tx.send(());
        while rx.recv().is_ok() {
            // Players send a burst of changes for one skip: read once after it settles.
            std::thread::sleep(Duration::from_millis(120));
            while rx.try_recv().is_ok() {}

            let session = manager.GetCurrentSession().ok();
            let same = match (&hooked, &session) {
                (Some(h), Some(s)) => h.session == *s,
                (None, None) => true,
                _ => false,
            };
            if !same {
                hooked = session.as_ref().and_then(|s| hook(s, &tx));
            }

            let state = read(session.as_ref());
            listening.update(&state);
            let changed = {
                let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
                let changed = last.as_ref() != Some(&state);
                *last = Some(state.clone());
                changed
            };
            if changed {
                let _ = app.emit(STATE_EVENT, &state);
            }
            if !state.art_key.is_empty() && state.art_key != art_sent {
                if let Some(url) = session.as_ref().and_then(artwork) {
                    art_sent = state.art_key.clone();
                    let _ = app.emit(ARTWORK_EVENT, serde_json::json!({ "key": state.art_key, "dataUrl": url }));
                }
            }
        }
    }

    fn read(session: Option<&Session>) -> MediaState {
        let (volume, muted) = endpoint().and_then(|v| unsafe {
            Some(((v.GetMasterVolumeLevelScalar().ok()? * 100.0).round() as u8, v.GetMute().ok()?.as_bool()))
        }).unwrap_or((0, false));
        let mut s = MediaState { volume, muted, ..Default::default() };
        let Some(session) = session else { return s };
        s.active = true;
        s.source = session.SourceAppUserModelId().map(|id| friendly_source(&id.to_string())).unwrap_or_default();
        if let Some(props) = session.TryGetMediaPropertiesAsync().ok().and_then(|op| op.get().ok()) {
            s.title = props.Title().map(|v| v.to_string()).unwrap_or_default();
            s.artist = props.Artist().map(|v| v.to_string()).unwrap_or_default();
            s.album = props.AlbumTitle().map(|v| v.to_string()).unwrap_or_default();
        }
        if let Ok(info) = session.GetPlaybackInfo() {
            s.playing = info.PlaybackStatus().is_ok_and(|p| p == Status::Playing);
            if let Ok(c) = info.Controls() {
                s.can_next = c.IsNextEnabled().unwrap_or(false);
                s.can_previous = c.IsPreviousEnabled().unwrap_or(false);
                s.can_seek = c.IsPlaybackPositionEnabled().unwrap_or(false);
            }
        }
        if let Ok(tl) = session.GetTimelineProperties() {
            let secs = |ticks: i64| ticks as f64 / 10_000_000.0;
            let start = tl.StartTime().map(|t| t.Duration).unwrap_or(0);
            s.duration = tl.EndTime().map(|t| secs(t.Duration - start)).unwrap_or(0.0).max(0.0);
            s.position = tl.Position().map(|t| secs(t.Duration - start)).unwrap_or(0.0).max(0.0);
            let updated = tl.LastUpdatedTime().map(|t| filetime_to_unix_ms(t.UniversalTime)).unwrap_or(0);
            s.position_at = if updated > 0 { updated } else { now_ms() };
        } else {
            s.position_at = now_ms();
        }
        s.art_key = art_key(&s);
        s
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn artwork(session: &Session) -> Option<String> {
        let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
        let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
        let size = stream.Size().ok()?;
        if size == 0 || size > ARTWORK_LIMIT {
            return None;
        }
        let kind = stream.ContentType().map(|c| c.to_string()).unwrap_or_default();
        let kind = if kind.starts_with("image/") { kind } else { "image/png".into() };
        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
        let loaded = reader.LoadAsync(size as u32).ok()?.get().ok()?;
        let mut bytes = vec![0u8; loaded as usize];
        reader.ReadBytes(&mut bytes).ok()?;
        Some(format!("data:{kind};base64,{}", crate::claude::base64_for(&bytes)))
    }

    fn endpoint() -> Option<IAudioEndpointVolume> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let device = devices.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
            device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok()
        }
    }

    pub fn control(action: MediaAction, value: Option<f64>) -> bool {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let done = match action {
            MediaAction::Volume => endpoint().is_some_and(|v| unsafe {
                let level = (value.unwrap_or(50.0) / 100.0).clamp(0.0, 1.0) as f32;
                v.SetMasterVolumeLevelScalar(level, std::ptr::null()).is_ok()
            }),
            MediaAction::Mute => endpoint().is_some_and(|v| unsafe {
                let muted = v.GetMute().map(|m| m.as_bool()).unwrap_or(false);
                v.SetMute(!muted, std::ptr::null()).is_ok()
            }),
            _ => {
                let Some(session) = manager().and_then(|m| m.GetCurrentSession().ok()) else { return false };
                let op = match action {
                    MediaAction::PlayPause => session.TryTogglePlayPauseAsync(),
                    MediaAction::Next => session.TrySkipNextAsync(),
                    MediaAction::Previous => session.TrySkipPreviousAsync(),
                    MediaAction::Seek => {
                        let start = session.GetTimelineProperties().and_then(|t| t.StartTime()).map(|t| t.Duration).unwrap_or(0);
                        session.TryChangePlaybackPositionAsync(start + (value.unwrap_or(0.0).max(0.0) * 10_000_000.0) as i64)
                    }
                    _ => return false,
                };
                op.ok().and_then(|o| o.get().ok()).unwrap_or(false)
            }
        };
        // Volume isn't a media session event: read again so the page sees it.
        if let Some(tx) = STARTED.get() {
            let _ = tx.send(());
        }
        done
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn ensure_started(_app: &tauri::AppHandle) {}
    pub fn playing() -> bool {
        false
    }
    pub fn current() -> Option<MediaState> {
        None
    }
    pub fn control(_action: MediaAction, _value: Option<f64>) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn players_get_the_names_people_know_them_by() {
        assert_eq!(friendly_source("Spotify.exe"), "Spotify");
        assert_eq!(friendly_source("MSEdge"), "Edge");
        assert_eq!(friendly_source("Chrome"), "Chrome");
        assert_eq!(friendly_source("308046B0AF4A39CB"), "Firefox");
        assert_eq!(friendly_source("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Media Player");
        assert_eq!(friendly_source(r"C:\Tools\Winamp\winamp.exe"), "winamp");
        assert_eq!(friendly_source(""), "Media");
    }

    #[test]
    fn windows_time_becomes_unix_time() {
        // 2024-01-01T00:00:00Z
        assert_eq!(filetime_to_unix_ms(133_485_408_000_000_000), 1_704_067_200_000);
        assert_eq!(filetime_to_unix_ms(0), 0);
    }

    #[test]
    fn the_play_log_keeps_the_newest() {
        let mut plays = Vec::new();
        for i in 0..(MAX_PLAYS + 5) {
            push_play(&mut plays, Play {
                day: "2026-10-14".into(), title: format!("t{i}"), artist: "a".into(), source: "s".into(), secs: 40,
            });
        }
        assert_eq!(plays.len(), MAX_PLAYS);
        assert_eq!(plays[0].title, "t5");
    }

    #[test]
    fn nothing_playing_has_no_cover_key() {
        assert_eq!(art_key(&MediaState::default()), "");
        let s = MediaState { active: true, source: "Spotify".into(), title: "Song".into(), ..Default::default() };
        assert!(!art_key(&s).is_empty());
    }
}

// The dashboard and its pills on the page: what src-tauri/src/dashboard/ sends,
// and the pure rules both the island cards and the dashboard window follow
// (formatting, app names, the focus ring, levels). No DOM, no Tauri:
// tests/dashboard.test.mjs runs it as it is.

import { N_, t } from "../i18n/i18n";

// ── Pill IDs (contract values: never renamed once shipped) ───────────────────

export const SYSTEM_ID = "integration_system";
export const NOWPLAYING_ID = "integration_nowplaying";
export const FOCUS_ID = "integration_focus";
export const NEWS_ID = "integration_news";
export const SCREENTIME_ID = "integration_screentime";
export const HUB_PILLS = [SYSTEM_ID, NOWPLAYING_ID, FOCUS_ID, NEWS_ID, SCREENTIME_ID] as const;

// ── What Rust sends ───────────────────────────────────────────────────────────

export interface SystemApp {
  name: string;
  mem: number;
  processes: number;
  windowed: boolean;
  canEnd: boolean;
}

export interface SystemStats {
  cpu: number | null;
  tempC: number | null;
  memUsed: number;
  memTotal: number;
  disk: string;
  diskFree: number;
  diskTotal: number;
  uptimeSecs: number;
  netDown: number | null;
  netUp: number | null;
  battery: { percent: number; charging: boolean; secsLeft: number | null } | null;
  apps: SystemApp[] | null;
  cores: number;
}

export interface MediaState {
  active: boolean;
  source: string;
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  position: number;
  positionAt: number;
  duration: number;
  canNext: boolean;
  canPrevious: boolean;
  canSeek: boolean;
  artKey: string;
  volume: number;
  muted: boolean;
}

export type MediaAction = "playPause" | "next" | "previous" | "seek" | "volume" | "mute";

export interface Play {
  day: string;
  title: string;
  artist: string;
  source: string;
  secs: number;
}

export type FocusPhase = "idle" | "focus" | "short" | "long";
export type FocusAction = "start" | "pause" | "skip" | "reset" | "auto";

export interface FocusState {
  phase: FocusPhase;
  running: boolean;
  endsAt: number;
  leftMs: number;
  totalMs: number;
  round: number;
  rounds: number;
  away: boolean;
  todayRounds: number;
  todayMin: number;
  day: string;
}

export interface ScreenDay {
  apps: Record<string, number>;
  active: number;
  first: number | null;
  last: number | null;
}

export interface ScreenTime {
  tracking: boolean;
  today: string;
  days: Record<string, ScreenDay>;
  current: string | null;
  previous: string | null;
  idleSecs: number;
}

export interface Weather {
  place: string;
  country: string;
  current: {
    temperature_2m: number;
    apparent_temperature: number;
    weather_code: number;
    wind_speed_10m: number;
    relative_humidity_2m: number;
    is_day: number;
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
  };
}

export interface SpeedResult {
  pingMs: number;
  downMbps: number;
  upMbps: number;
}

export type QuickAction = "taskManager" | "lock" | "emptyRecycleBin" | "snip" | "soundSettings";

export interface FocusPrefs {
  focusMin: number;
  shortMin: number;
  longMin: number;
  rounds: number;
  autoAdvance: boolean;
  autoStart: boolean;
  idlePause: boolean;
}

export interface DashboardPrefs {
  screenTime: boolean;
  focus: FocusPrefs;
  newsFeeds: string[];
  newsKeywords: string[];
  newsAlerts: boolean;
  weatherCity: string;
  speedTestUrl: string;
  systemAlerts: boolean;
  tiles: string[];
  /** The chat gets a snapshot of the PC with each message. */
  shareWithChat: boolean;
  /** The chat may play music, run the focus timer, and propose Claude Code jobs. */
  letChatAct: boolean;
}

export const DEFAULT_DASHBOARD: DashboardPrefs = {
  screenTime: false,
  focus: { focusMin: 25, shortMin: 5, longMin: 15, rounds: 4, autoAdvance: true, autoStart: true, idlePause: true },
  newsFeeds: [
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.thehindu.com/news/national/feeder/default.rss",
    "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en",
  ],
  newsKeywords: [
    "breaking", "live", "urgent", "earthquake", "explosion", "attack", "tsunami",
    "cyclone", "evacuat*", "killed", "dies", "dead", "deadly", "crash", "war",
  ],
  newsAlerts: true,
  weatherCity: "",
  speedTestUrl: "https://speed.cloudflare.com",
  systemAlerts: true,
  tiles: [],
  shareWithChat: true,
  letChatAct: true,
};

// ── Formatting ────────────────────────────────────────────────────────────────

/** 1536 → "1.5 KB"; GB keep one decimal, TB two. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i <= 1 ? 0 : i === 4 ? 2 : 1;
  return `${v.toFixed(digits)} ${units[i]}`;
}

/** Bytes per second → "1.2 MB/s". */
export function formatRate(bytesPerSec: number | null): string {
  return bytesPerSec == null ? "–" : `${formatBytes(bytesPerSec)}/s`;
}

/** A length of time, the two biggest units: "2 h 05 min", "12 min", "40 s". */
export function formatDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return t("{d} d {h} h", { d, h });
  if (h > 0) return t("{h} h {m} min", { h, m: String(m).padStart(2, "0") });
  if (m > 0) return t("{m} min", { m });
  return t("{s} s", { s });
}

/** A countdown: "24:59", or "1:02:03" past an hour. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** 0…1 of something used, for gauges; 0 when there is no total. */
export function ratio(used: number, total: number): number {
  return total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
}

export type Level = "ok" | "warn" | "hot";

/** Green, amber, red: the colour a gauge takes. */
export function level(fraction: number, warn = 0.75, hot = 0.9): Level {
  return fraction >= hot ? "hot" : fraction >= warn ? "warn" : "ok";
}

export function tempLevel(c: number | null): Level {
  if (c == null) return "ok";
  return c >= 90 ? "hot" : c >= 75 ? "warn" : "ok";
}

/** Low free space on the system drive: under 10 % or 10 GB. */
export function diskLow(s: Pick<SystemStats, "diskFree" | "diskTotal">): boolean {
  return s.diskTotal > 0 && (s.diskFree < 10 * 1024 ** 3 || s.diskFree / s.diskTotal < 0.1);
}

// ── App names ─────────────────────────────────────────────────────────────────

const APP_NAMES: Record<string, string> = {
  "chrome.exe": "Chrome",
  "msedge.exe": "Edge",
  "firefox.exe": "Firefox",
  "brave.exe": "Brave",
  "opera.exe": "Opera",
  "code.exe": "VS Code",
  "cursor.exe": "Cursor",
  "explorer.exe": "File Explorer",
  "windowsterminal.exe": "Terminal",
  "cmd.exe": "Command Prompt",
  "powershell.exe": "PowerShell",
  "pwsh.exe": "PowerShell",
  "claude.exe": "Claude",
  "spotify.exe": "Spotify",
  "discord.exe": "Discord",
  "slack.exe": "Slack",
  "teams.exe": "Teams",
  "ms-teams.exe": "Teams",
  "whatsapp.exe": "WhatsApp",
  "telegram.exe": "Telegram",
  "winword.exe": "Word",
  "excel.exe": "Excel",
  "powerpnt.exe": "PowerPoint",
  "outlook.exe": "Outlook",
  "onenote.exe": "OneNote",
  "notepad.exe": "Notepad",
  "notepad++.exe": "Notepad++",
  "vlc.exe": "VLC",
  "obs64.exe": "OBS",
  "steam.exe": "Steam",
  "taskmgr.exe": "Task Manager",
  "applicationframehost.exe": "Windows app",
  "systemsettings.exe": "Settings",
  "idea64.exe": "IntelliJ IDEA",
  "pycharm64.exe": "PyCharm",
  "devenv.exe": "Visual Studio",
  "figma.exe": "Figma",
  "notion.exe": "Notion",
  "obsidian.exe": "Obsidian",
  "zoom.exe": "Zoom",
  "acrobat.exe": "Acrobat",
  "msedgewebview2.exe": "WebView2",
  "node.exe": "Node.js",
  "python.exe": "Python",
  "opencode.exe": "OpenCode",
};

/** "chrome.exe" → "Chrome"; an unknown one loses ".exe" and gets a capital. */
export function appName(exe: string): string {
  const known = APP_NAMES[exe.toLowerCase()];
  if (known) return known;
  const bare = exe.replace(/\.exe$/i, "");
  return bare ? bare[0].toUpperCase() + bare.slice(1) : exe;
}

/** A steady colour per app, for its bar. */
export function appColor(exe: string): string {
  const palette = ["#6366F1", "#22D3EE", "#F472B6", "#F5A524", "#22C55E", "#A78BFA", "#F4505E", "#2DD4BF", "#FACC15", "#60A5FA"];
  let hash = 0;
  for (const ch of exe.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

// ── Screen time ───────────────────────────────────────────────────────────────

/** [app, seconds] for a day, most used first. */
export function topApps(day: ScreenDay | undefined, n = 6): [string, number][] {
  if (!day) return [];
  return Object.entries(day.apps).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

/** "YYYY-MM-DD" of `today` minus `back` days. */
export function dayBefore(today: string, back: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d - back));
  return date.toISOString().slice(0, 10);
}

/** The last seven days, oldest first, with their active seconds (0 when absent). */
export function week(st: Pick<ScreenTime, "today" | "days">): { day: string; secs: number }[] {
  const out = [];
  for (let back = 6; back >= 0; back--) {
    const day = dayBefore(st.today, back);
    out.push({ day, secs: st.days[day]?.active ?? 0 });
  }
  return out;
}

// ── Focus ─────────────────────────────────────────────────────────────────────

/** Milliseconds left at `nowMs`. */
export function focusLeft(s: FocusState, nowMs: number): number {
  return s.running ? Math.max(0, s.endsAt - nowMs) : s.leftMs;
}

/** 0…1 of the phase done, for the ring. */
export function focusProgress(s: FocusState, nowMs: number): number {
  if (s.phase === "idle" || s.totalMs <= 0) return 0;
  return 1 - focusLeft(s, nowMs) / s.totalMs;
}

export function phaseLabel(phase: FocusPhase): string {
  switch (phase) {
    case "focus": return t("Focus");
    case "short": return t("Short break");
    case "long": return t("Long break");
    default: return t("Ready");
  }
}

export const PHASE_COLOR: Record<FocusPhase, string> = {
  idle: "#9398A1",
  focus: "#F4505E",
  short: "#22C55E",
  long: "#22D3EE",
};

// ── Music ─────────────────────────────────────────────────────────────────────

/** Position now, run on from the timestamp while playing, capped at the end. */
export function mediaPosition(s: MediaState, nowMs: number): number {
  const elapsed = s.playing ? Math.max(0, (nowMs - s.positionAt) / 1000) : 0;
  const p = s.position + elapsed;
  return s.duration > 0 ? Math.min(p, s.duration) : p;
}

/** Plays of the last `days` days: minutes heard and the top artists. */
export function listeningSummary(plays: Play[], today: string, days = 7): {
  minutes: number;
  tracks: number;
  artists: [string, number][];
} {
  const since = dayBefore(today, days - 1);
  const recent = plays.filter((p) => p.day >= since && p.day <= today);
  const byArtist = new Map<string, number>();
  for (const p of recent) {
    const a = p.artist.trim();
    if (a) byArtist.set(a, (byArtist.get(a) ?? 0) + p.secs);
  }
  return {
    minutes: Math.round(recent.reduce((n, p) => n + p.secs, 0) / 60),
    tracks: recent.length,
    artists: [...byArtist].sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

// ── Weather ───────────────────────────────────────────────────────────────────

/** WMO weather code → an emoji and an English key. */
export function weatherInfo(code: number, day = true): { icon: string; label: string } {
  if (code === 0) return { icon: day ? "☀️" : "🌙", label: N_("Clear sky") };
  if (code <= 2) return { icon: day ? "🌤️" : "☁️", label: N_("Partly cloudy") };
  if (code === 3) return { icon: "☁️", label: N_("Cloudy") };
  if (code === 45 || code === 48) return { icon: "🌫️", label: N_("Fog") };
  if (code >= 51 && code <= 67) return { icon: "🌧️", label: N_("Rain") };
  if (code >= 71 && code <= 77) return { icon: "❄️", label: N_("Snow") };
  if (code >= 80 && code <= 82) return { icon: "🌦️", label: N_("Showers") };
  if (code >= 85 && code <= 86) return { icon: "🌨️", label: N_("Snow") };
  if (code >= 95) return { icon: "⛈️", label: N_("Thunderstorm") };
  return { icon: "🌡️", label: N_("Weather") };
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

export interface CleanupItem {
  id: string;
  kind: "temp" | "browser" | "dev" | "recycle" | "project";
  label: string;
  path: string;
  bytes: number;
}

/** What a scan finds that is safe to tick by default: caches yes, a project's build folder no (it costs a rebuild). */
export function cleanupDefault(item: CleanupItem): boolean {
  return item.kind !== "project";
}

/** Total bytes of the ticked items. */
export function cleanupTotal(items: readonly CleanupItem[], picked: ReadonlySet<string>): number {
  return items.reduce((n, i) => n + (picked.has(i.id) ? i.bytes : 0), 0);
}

// ── Tiles ─────────────────────────────────────────────────────────────────────

export const TILE_IDS = [
  "music", "jobs", "focus", "cleanup", "claude", "cpu", "memory", "disk", "network", "uptime",
  "screentime", "apps", "news", "weather", "speed", "actions", "listening",
] as const;
export type TileId = (typeof TILE_IDS)[number];

/** The user's order: known ids they kept, then every tile they never placed. */
export function tileOrder(saved: readonly string[]): TileId[] {
  const known = new Set<string>(TILE_IDS);
  const seen = new Set<string>();
  const out: TileId[] = [];
  for (const id of saved) {
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id as TileId);
    }
  }
  for (const id of TILE_IDS) if (!seen.has(id)) out.push(id);
  return out;
}

/** Moves `id` to where `before` is (or the end). */
export function moveTile(order: readonly TileId[], id: TileId, before: TileId | null): TileId[] {
  const rest = order.filter((x) => x !== id);
  const at = before == null ? rest.length : rest.indexOf(before);
  rest.splice(at < 0 ? rest.length : at, 0, id);
  return rest;
}

// ── Mochi ─────────────────────────────────────────────────────────────────────

export interface MoodInput {
  cpu: number | null;
  tempC: number | null;
  playing: boolean;
  focus: Pick<FocusState, "phase" | "running"> | null;
  urgentNews: boolean;
}

export interface Mood {
  /** One of BotEngine's states. */
  state: "idle" | "working" | "approval" | "ratelimit" | "sleeping";
  dancing: boolean;
  /** Round glasses while focusing. */
  studious: boolean;
}

/**
 * How the dashboard's Mochi feels, most pressing first: urgent news alarms
 * him, a hot or busy PC makes him sweat, a focus round puts him to work, a
 * break puts him to sleep, and music makes him dance.
 */
export function mochiMood(i: MoodInput): Mood {
  const focusing = i.focus?.phase === "focus" && i.focus.running;
  const resting = (i.focus?.phase === "short" || i.focus?.phase === "long") && i.focus.running;
  const dance = i.playing;
  if (i.urgentNews) return { state: "approval", dancing: false, studious: focusing };
  if ((i.tempC ?? 0) >= 85 || (i.cpu ?? 0) >= 85) return { state: "ratelimit", dancing: false, studious: focusing };
  if (focusing) return { state: "working", dancing: false, studious: true };
  if (resting) return { state: "sleeping", dancing: false, studious: false };
  return { state: "idle", dancing: dance, studious: false };
}

// The dashboard pills in the island (src-tauri/src/dashboard): what reaches the
// page, and when the island asks for more.
//
// - Now Playing and Focus arrive as events. Music starting shows the compact
//   island without a sound, like Spotify; a focus phase ending peeks with
//   Mochi's "finish" sound.
// - System and Screen Time are only read while their card is on screen.
// - News is read every 10 minutes while the News pill is declared; a new
//   urgent headline opens the island on it (Settings → Dashboard → alerts).
// - With "Warn me" on and the System pill declared, the PC is read once a
//   minute: memory, the system drive or the temperature running high opens the
//   island on the System card, once per episode.
// - Focus starts by itself when an agent starts working (Settings → Dashboard).

import { Bridge, onEvent } from "../core/bridge";
import {
  FOCUS_ID, NEWS_ID, NOWPLAYING_ID, SCREENTIME_ID, SYSTEM_ID, diskLow, ratio,
  type FocusState, type MediaState,
} from "../core/dashboard";
import { Hub } from "../core/hub";
import { pillDefinition } from "../core/pills";
import { Sound } from "../core/sound";
import { State, dashboardPrefs } from "../core/state";
import { mergeFeeds, parseFeed, storyKey } from "../news/news";
import { parseUsage } from "../usage/usage";
import type { BotEmoteName } from "../core/layout";

export interface HubHost {
  revealSilently(): void;
  reveal(): void;
  alert(view: "overview"): void;
  /** Mochi reacts: a focus round done, breaking news, a Claude job finished. */
  emote(name: BotEmoteName): void;
}

const NEWS_EVERY_MS = 10 * 60_000;
const SYSTEM_CARD_MS = 2000;
const SYSTEM_WATCH_MS = 60_000;

function declared(id: string): boolean {
  return State.settings.activeIntegrations.includes(id);
}

function shown(id: string): boolean {
  return State.mode === "expanded" && State.view === "overview" && State.focusTask?.id === id;
}

/** The dashboard tab is open in the island. */
function dashOpen(): boolean {
  return State.mode === "expanded" && State.view === "dashboard";
}

/** Music on a declared Now Playing pill: Mochi dances, as for Spotify. */
export function hubMusicPlaying(): boolean {
  return !!Hub.media?.playing && declared(NOWPLAYING_ID);
}

function syncNames() {
  const task = State.tasks.find((x) => x.id === NOWPLAYING_ID);
  if (!task) return;
  const m = Hub.media;
  const name = m?.active && m.title ? m.title : (pillDefinition(NOWPLAYING_ID)?.name ?? task.name);
  if (task.name !== name) task.name = name;
}

export function registerHubHandlers(island: HubHost) {
  void onEvent<MediaState>("media", (m) => {
    const was = hubMusicPlaying();
    Hub.media = m;
    syncNames();
    if (!was && hubMusicPlaying() && !State.paused && State.mode === "hidden") island.revealSilently();
    State.notify();
  });
  void onEvent<{ key: string; dataUrl: string }>("media-artwork", (a) => {
    Hub.art = a;
    State.notify();
  });
  void onEvent<FocusState>("focus", (f) => {
    Hub.focus = f;
    State.notify();
  });
  void onEvent<{ ended: string; next: string }>("focus-end", (e) => {
    if (State.paused) return;
    Sound.play("finish");
    // Proud after a focus round, a yawn when a break is over.
    island.emote(e.ended === "focus" ? "proud" : "yawn");
    if (declared(FOCUS_ID)) {
      State.setFocus(FOCUS_ID);
      if (State.mode === "hidden") island.reveal();
    }
  });

  // A Claude Code job (dashboard/jobs.rs) finished: Mochi says so.
  void onEvent<{ id: string; ok: boolean; prompt: string }>("job-done", (d) => {
    if (State.paused) return;
    Sound.play(d.ok ? "finish" : "error");
    if (State.mode === "hidden") island.reveal();
    island.emote(d.ok ? "happy" : "annoyed");
  });

  // Ask once: the media thread and the timer may have spoken before this page listened.
  if (declared(NOWPLAYING_ID)) void Bridge.mediaRefresh().then((m) => m && ((Hub.media = m), syncNames(), State.notify()));
  void Bridge.focusGet().then((f) => f && ((Hub.focus = f), State.notify()));

  let wasWorking = false;
  let systemTimer: number | null = null;
  let tickTimer: number | null = null;
  let lastSystem = 0;
  let lastWatch = 0;
  let lastScreen = 0;
  let lastNews = 0;
  let lastWeather = 0;
  let lastClaude = 0;
  let systemReads = 0;
  let wasDash = false;
  const seenUrgent = new Set<string>();
  let newsPrimed = false;
  const raised = { mem: false, disk: false, temp: false };

  const readSystem = async (detail: boolean) => {
    const st = await Bridge.systemStats(detail);
    if (!st) return;
    Hub.stats = { ...st, apps: st.apps ?? Hub.stats?.apps ?? null };
    State.notify();
    watchHealth();
  };

  const watchHealth = () => {
    const st = Hub.stats;
    if (!st || !dashboardPrefs(State.settings).systemAlerts || !declared(SYSTEM_ID) || State.paused) return;
    const mem = ratio(st.memUsed, st.memTotal) >= 0.92;
    const disk = diskLow(st);
    const temp = (st.tempC ?? 0) >= 90;
    const fresh = (mem && !raised.mem) || (disk && !raised.disk) || (temp && !raised.temp);
    // Once per episode: it must come back down before it warns again.
    raised.mem = mem;
    raised.disk = disk;
    raised.temp = temp;
    if (fresh) {
      State.setFocus(SYSTEM_ID);
      island.alert("overview");
    }
  };

  const loadNews = async () => {
    lastNews = Date.now();
    const feeds = await Bridge.newsFetch();
    if (!feeds) return;
    const prefs = dashboardPrefs(State.settings);
    const now = Date.now();
    Hub.news = mergeFeeds(feeds.filter((f) => f.body).map((f) => parseFeed(f.body!, f.url, prefs.newsKeywords, now)));
    // The first read only learns what is already out there.
    const fresh = Hub.news.filter((n) => n.urgent && !seenUrgent.has(storyKey(n.title)));
    for (const n of Hub.news) if (n.urgent) seenUrgent.add(storyKey(n.title));
    const first = !newsPrimed;
    newsPrimed = true;
    if (!first && fresh.length && prefs.newsAlerts && !State.paused) {
      State.setFocus(NEWS_ID);
      Sound.play("question");
      island.alert("overview");
      island.emote("surprised");
    }
    State.notify();
  };

  const loop = () => {
    const now = Date.now();
    if (State.paused) return;
    if ((shown(SYSTEM_ID) || dashOpen()) && now - lastSystem >= SYSTEM_CARD_MS - 100) {
      lastSystem = now;
      // The dashboard's memory tile names the biggest app: the process list every third read.
      void readSystem(dashOpen() && systemReads++ % 3 === 0);
    } else if (declared(SYSTEM_ID) && dashboardPrefs(State.settings).systemAlerts && now - lastWatch >= SYSTEM_WATCH_MS) {
      lastWatch = now;
      void readSystem(false);
    }
    if ((shown(SCREENTIME_ID) || dashOpen()) && now - lastScreen >= 30_000) {
      lastScreen = now;
      void Bridge.screenTime().then((s) => s && ((Hub.screen = s), State.notify()));
    }
    if ((declared(NEWS_ID) || dashOpen()) && now - lastNews >= NEWS_EVERY_MS) void loadNews();
    if (dashOpen()) {
      if (dashboardPrefs(State.settings).weatherCity.trim() && now - lastWeather >= 30 * 60_000) {
        lastWeather = now;
        void Bridge.weather().then((w) => w && ((Hub.weather = w), State.notify()));
      }
      if (State.settings.showUsageStats && now - lastClaude >= 60_000) {
        lastClaude = now;
        void Bridge.claudeUsageStats().then((raw) => ((Hub.claude = parseUsage(raw)), State.notify()));
      }
    }
  };

  State.subscribe(() => {
    // An agent starting to work starts a focus round (focus.rs checks the setting).
    const working = State.tasks.some((task) => (!task.isIntegration || task.source === "claudeCode")
      && (task.state === "working" || task.state === "thinking" || task.state === "searching"));
    if (working && !wasWorking && !State.paused) void Bridge.focusCommand("auto");
    wasWorking = working;

    // Something to watch: one quiet 2 s timer; nothing declared, no timer at all.
    const dash = dashOpen();
    const needed = dash || [SYSTEM_ID, NEWS_ID, SCREENTIME_ID].some(declared);
    if (needed && systemTimer == null) {
      systemTimer = window.setInterval(loop, SYSTEM_CARD_MS);
      loop();
    } else if (!needed && systemTimer != null) {
      window.clearInterval(systemTimer);
      systemTimer = null;
    }
    // The focus and music cards move every second, only while on screen.
    const moving = dash || shown(FOCUS_ID) || shown(NOWPLAYING_ID);
    if (moving && tickTimer == null) tickTimer = window.setInterval(() => State.notify(), 1000);
    else if (!moving && tickTimer != null) {
      window.clearInterval(tickTimer);
      tickTimer = null;
    }
    // Opening the dashboard tab reads everything at once.
    if (dash && !wasDash) {
      lastSystem = lastScreen = lastWeather = lastClaude = 0;
      void Bridge.mediaRefresh().then((m) => m && ((Hub.media = m), syncNames(), State.notify()));
      window.setTimeout(loop, 0);
    }
    wasDash = dash;
    // Opening a card reads it at once.
    if (shown(SYSTEM_ID) && Date.now() - lastSystem > SYSTEM_CARD_MS) {
      lastSystem = Date.now();
      void readSystem(false);
    }
    if (shown(SCREENTIME_ID) && Date.now() - lastScreen > 30_000) {
      lastScreen = Date.now();
      void Bridge.screenTime().then((s) => s && ((Hub.screen = s), State.notify()));
    }
    if (declared(NOWPLAYING_ID) && Hub.media == null) {
      Hub.media = { active: false } as MediaState;
      void Bridge.mediaRefresh().then((m) => m && ((Hub.media = m), syncNames(), State.notify()));
    }
  });
}

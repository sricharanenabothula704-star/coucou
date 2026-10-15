// The dashboard window (dashboard.html) — every tile at once: music, focus,
// Claude usage, the PC's vitals, screen time, apps, news, weather, speed test
// and quick actions, with Mochi reacting to all of it.
//
// It only works while it is on screen. When the window is hidden (closing it
// only hides it), every timer stops: nothing is sampled, fetched or drawn.
// While shown: the PC every 2 s (the app list every 6 s), screen time every
// 30 s, news every 10 min, weather every 30 min; music and focus arrive as
// events from Rust.

import "./dashboard.css";
import { Bridge, onEvent } from "../core/bridge";
import {
  DEFAULT_DASHBOARD, PHASE_COLOR, cleanupDefault, cleanupTotal, appColor, appName, diskLow, focusLeft, focusProgress,
  formatBytes, formatClock, formatDuration, formatRate, level, listeningSummary, mediaPosition, mochiMood,
  moveTile, phaseLabel, ratio, tempLevel, tileOrder, topApps, week, weatherInfo,
  type CleanupItem, type DashboardPrefs, type FocusState, type MediaState, type Play, type ScreenTime, type SpeedResult,
  type SystemStats, type TileId, type Weather,
} from "../core/dashboard";
import { DEFAULT_SETTINGS, dashboardPrefs, type Settings } from "../core/state";
import { compactNumber, dailyTotals, parseUsage, totalTokens, type ClaudeUsage } from "../usage/usage";
import type { PlanUsage } from "../core/plan";
import { ageMinutes, mergeFeeds, parseFeed, type Headline } from "../news/news";
import { BotEngine } from "../mochi/engine";
import type { ClaudeJob } from "../core/pc-context";
import { resolveOutfit, parseOutfit } from "../mochi/wardrobe";
import { h, clear } from "../views/dom";
import {
  language, onLanguageChange, resolveLanguage, setLanguage, systemLanguages, t, tn, weekdayShort,
} from "../i18n/i18n";

// ── State ─────────────────────────────────────────────────────────────────────

let settings: Settings = { ...DEFAULT_SETTINGS };
let prefs: DashboardPrefs = { ...DEFAULT_DASHBOARD };

const HISTORY = 60;
const data = {
  stats: null as SystemStats | null,
  cpu: [] as number[],
  down: [] as number[],
  up: [] as number[],
  media: null as MediaState | null,
  art: null as { key: string; dataUrl: string } | null,
  plays: [] as Play[],
  focus: null as FocusState | null,
  screen: null as ScreenTime | null,
  news: [] as Headline[],
  newsError: false,
  newsAt: 0,
  weather: null as Weather | null,
  weatherError: "",
  speed: null as SpeedResult | null,
  speedRunning: false,
  speedError: false,
  claude: null as ClaudeUsage | null,
  plan: null as PlanUsage | null,
  jobs: [] as ClaudeJob[],
  /** Where `claude` is; null when it wasn't found, undefined before the first ask. */
  claudeExe: undefined as string | null | undefined,
};

const root = document.getElementById("dashboard-root")!;
const SVG_NS = "http://www.w3.org/2000/svg";

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

async function save() {
  settings = { ...settings, dashboard: prefs };
  await Bridge.saveSettings(settings);
}

// ── Little parts ──────────────────────────────────────────────────────────────

const LEVEL_COLOR = { ok: "var(--green)", warn: "var(--amber)", hot: "var(--red)" } as const;

/** A ring gauge; its arc animates to each new value. */
class Ring {
  readonly el: SVGSVGElement;
  private arc: SVGCircleElement;
  private readonly c: number;
  constructor(size = 92, stroke = 9) {
    const r = (size - stroke) / 2;
    this.c = 2 * Math.PI * r;
    this.el = s("svg", { width: size, height: size, viewBox: `0 0 ${size} ${size}`, class: "ring" });
    const track = s("circle", { cx: size / 2, cy: size / 2, r, "stroke-width": stroke, class: "ring-track" });
    this.arc = s("circle", {
      cx: size / 2, cy: size / 2, r, "stroke-width": stroke, class: "ring-arc",
      "stroke-dasharray": this.c, "stroke-dashoffset": this.c,
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
    });
    this.el.append(track, this.arc);
  }
  set(fraction: number, color: string) {
    this.arc.setAttribute("stroke-dashoffset", String(this.c * (1 - Math.min(1, Math.max(0, fraction)))));
    this.arc.style.stroke = color;
  }
}

/** A filled line of the last values; `max` fixes the top, else it follows the peak. */
function sparkline(values: number[], color: string, max?: number, w = 220, hgt = 46): SVGSVGElement {
  const el = s("svg", { width: "100%", height: hgt, viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: "none", class: "spark" });
  if (values.length < 2) return el;
  const top = max ?? Math.max(1, ...values) * 1.15;
  const step = w / (HISTORY - 1);
  const start = w - step * (values.length - 1);
  const pts = values.map((v, i) => [start + i * step, hgt - 2 - (Math.min(v, top) / top) * (hgt - 4)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  const defs = s("defs");
  const grad = s("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(s("stop", { offset: "0%", "stop-color": color, "stop-opacity": 0.35 }), s("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0 }));
  defs.append(grad);
  el.append(
    defs,
    s("path", { d: `${line}L${w},${hgt}L${start},${hgt}Z`, fill: `url(#${id})` }),
    s("path", { d: line, fill: "none", stroke: color, "stroke-width": 1.8, "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke" }),
  );
  return el;
}

function bar(fraction: number, color: string): HTMLElement {
  // At its width at once: a redrawn tile must not replay the bar filling up
  // (the grid's entrance does that, once, in CSS).
  const fill = h("i", { style: `background:${color};width:${(Math.min(1, Math.max(0, fraction)) * 100).toFixed(1)}%` });
  return h("div", { class: "bar" }, fill);
}

function icon(path: string, size = 16): SVGSVGElement {
  const el = s("svg", { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true" });
  el.append(s("path", { d: path, fill: "currentColor" }));
  return el;
}

const I = {
  play: "M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  next: "M5 5.5v13a1 1 0 0 0 1.55.83L15 13.6V18h3V6h-3v4.4L6.55 4.67A1 1 0 0 0 5 5.5z",
  prev: "M19 5.5v13a1 1 0 0 1-1.55.83L9 13.6V18H6V6h3v4.4l8.45-5.73A1 1 0 0 1 19 5.5z",
  vol: "M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z",
  mute: "M4 9v6h4l5 4V5L8 9H4zm15.6 3 2.1-2.1-1.4-1.4-2.1 2.1-2.1-2.1-1.4 1.4 2.1 2.1-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4z",
  skip: "M6 6l8.5 6L6 18V6zm10 0h2v12h-2z",
  reset: "M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z",
  refresh: "M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.75 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
  grip: "M9 5h2v2H9zm4 0h2v2h-2zM9 11h2v2H9zm4 0h2v2h-2zm-4 6h2v2H9zm4 0h2v2h-2z",
  gear: "M19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.3 7.3 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.3 7.3 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.7 1.7 1l.4 2.5h4l.4-2.5c.6-.3 1.2-.6 1.7-1l2.4 1 2-3.4-2.1-1.6zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z",
};

/** Two clicks within 3 s: what anything that can't be undone asks. */
function confirmButton(label: string, sure: string, cls: string, onConfirm: () => void): HTMLButtonElement {
  let armed = 0;
  const b = h("button", { class: cls, text: label }) as HTMLButtonElement;
  b.onclick = (e) => {
    e.stopPropagation();
    if (armed && Date.now() - armed < 3000) {
      armed = 0;
      b.textContent = label;
      b.classList.remove("armed");
      onConfirm();
      return;
    }
    armed = Date.now();
    b.textContent = sure;
    b.classList.add("armed");
    window.setTimeout(() => {
      if (armed && Date.now() - armed >= 3000) {
        armed = 0;
        b.textContent = label;
        b.classList.remove("armed");
      }
    }, 3100);
  };
  return b;
}

// ── Tiles ─────────────────────────────────────────────────────────────────────

interface Tile {
  id: TileId;
  el: HTMLElement;
  body: HTMLElement;
  /** Redraws from `data`. */
  render(): void;
  /** Every second, for what moves on its own (clocks, progress). */
  tick?(now: number): void;
}

const TITLES: Record<TileId, () => string> = {
  music: () => t("Now playing"),
  focus: () => t("Focus"),
  claude: () => t("Claude usage"),
  cpu: () => t("CPU"),
  memory: () => t("Memory"),
  disk: () => t("Storage"),
  network: () => t("Network"),
  uptime: () => t("Uptime"),
  screentime: () => t("Screen time"),
  apps: () => t("Apps using memory"),
  news: () => t("News"),
  weather: () => t("Weather"),
  speed: () => t("Speed test"),
  actions: () => t("Quick actions"),
  listening: () => t("Music played"),
  jobs: () => t("Claude jobs"),
  cleanup: () => t("PC cleanup"),
};

const WIDE: ReadonlySet<TileId> = new Set(["music", "news", "screentime", "apps", "jobs", "cleanup"]);

function shell(id: TileId, extra?: HTMLElement): { el: HTMLElement; body: HTMLElement; title: HTMLElement } {
  const title = h("span", { class: "tile-title", text: TITLES[id]() });
  const grip = h("span", { class: "grip", title: t("Drag to move") }, icon(I.grip, 14));
  const head = h("div", { class: "tile-head" }, grip, title, h("span", { class: "spacer" }), extra ?? null);
  const body = h("div", { class: "tile-body" });
  const el = h("section", { class: `tile tile-${id}${WIDE.has(id) ? " wide" : ""}`, "data-id": id }, head, body);
  return { el, body, title };
}

function empty(text: string, action?: HTMLElement): HTMLElement {
  return h("div", { class: "empty" }, h("p", { text }), action ?? null);
}

// Music ────────────────────────────────────────────────────────────────────────

function musicTile(): Tile {
  const { el, body } = shell("music");
  let key = "";
  let progressFill: HTMLElement | null = null;
  let elapsed: HTMLElement | null = null;
  let seeking = false;

  const render = () => {
    const m = data.media;
    el.classList.toggle("playing", !!m?.playing);
    const k = JSON.stringify([m?.active, m?.title, m?.artist, m?.source, m?.playing, m?.duration, m?.canNext, m?.canPrevious, m?.canSeek, m?.volume, m?.muted, data.art?.key === m?.artKey, language()]);
    if (k === key) return;
    key = k;
    clear(body);
    if (!m?.active) {
      body.append(empty(t("Nothing is playing. Play something in Spotify, a browser or any player.")));
      progressFill = elapsed = null;
      return;
    }
    const art = data.art && data.art.key === m.artKey ? data.art.dataUrl : null;
    const cover = h("div", { class: "cover" });
    if (art) cover.append(h("img", { src: art, alt: "" }));
    else cover.append(h("span", { class: "cover-note", text: "♪" }));
    const eq = h("div", { class: "eq" }, h("i"), h("i"), h("i"), h("i"));

    const btn = (path: string, label: string, enabled: boolean, onclick: () => void, big = false) =>
      h("button", { class: `round${big ? " big" : ""}`, title: label, "aria-label": label, disabled: !enabled, onclick }, icon(path, big ? 22 : 16));

    progressFill = h("i");
    elapsed = h("span", { class: "time" });
    const progress = h("div", { class: `progress${m.canSeek && m.duration > 0 ? " seekable" : ""}` }, progressFill);
    progress.onpointerdown = (e) => {
      if (!m.canSeek || m.duration <= 0) return;
      seeking = true;
      const rect = progress.getBoundingClientRect();
      const at = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * m.duration;
      progressFill!.style.width = `${(at / m.duration) * 100}%`;
      void Bridge.mediaControl("seek", at).finally(() => (seeking = false));
    };

    const volume = h("input", { type: "range", min: 0, max: 100, value: m.volume, class: "volume", "aria-label": t("Volume") }) as HTMLInputElement;
    volume.oninput = () => void Bridge.mediaControl("volume", Number(volume.value));

    body.append(
      h("div", { class: "music" },
        cover,
        h("div", { class: "music-main" },
          h("div", { class: "music-source" }, eq, h("span", { text: m.source || t("Media") })),
          h("div", { class: "music-title", text: m.title || t("Unknown") }),
          h("div", { class: "music-artist", text: [m.artist, m.album].filter(Boolean).join(" · ") }),
          h("div", { class: "progress-row" }, elapsed, progress, h("span", { class: "time", text: m.duration > 0 ? formatClock(m.duration * 1000) : t("Live") })),
          h("div", { class: "controls" },
            btn(I.prev, t("Previous"), m.canPrevious, () => void Bridge.mediaControl("previous")),
            btn(m.playing ? I.pause : I.play, m.playing ? t("Pause") : t("Play"), true, () => {
              if (data.media) data.media = { ...data.media, playing: !data.media.playing, position: mediaPosition(data.media, Date.now()), positionAt: Date.now() };
              render();
              void Bridge.mediaControl("playPause");
            }, true),
            btn(I.next, t("Next"), m.canNext, () => void Bridge.mediaControl("next")),
            h("span", { class: "spacer" }),
            btn(m.muted ? I.mute : I.vol, t("Mute / unmute sounds"), true, () => void Bridge.mediaControl("mute")),
            volume,
          ),
        ),
      ),
    );
    tick(Date.now());
  };

  const tick = (now: number) => {
    const m = data.media;
    if (!m?.active || !progressFill || !elapsed || seeking) return;
    const p = mediaPosition(m, now);
    elapsed.textContent = formatClock(p * 1000);
    progressFill.style.width = m.duration > 0 ? `${(p / m.duration) * 100}%` : "100%";
  };

  return { id: "music", el, body, render, tick };
}

// Focus ────────────────────────────────────────────────────────────────────────

function focusTile(): Tile {
  const { el, body } = shell("focus");
  const ring = new Ring(132, 10);
  const clock = h("div", { class: "focus-clock" });
  const phase = h("div", { class: "focus-phase" });
  const dots = h("div", { class: "focus-dots" });
  const controls = h("div", { class: "controls center" });
  const today = h("div", { class: "focus-today" });
  body.append(
    h("div", { class: "focus" }, h("div", { class: "focus-ring" }, ring.el, h("div", { class: "focus-center" }, clock, phase)), dots, controls, today),
  );
  let key = "";

  const render = () => {
    const f = data.focus;
    if (!f) return;
    const k = JSON.stringify([f.phase, f.running, f.away, f.round, f.rounds, f.todayRounds, f.todayMin, prefs.focus.autoStart, language()]);
    el.style.setProperty("--phase", PHASE_COLOR[f.phase]);
    el.classList.toggle("running", f.running);
    tick(Date.now());
    if (k === key) return;
    key = k;
    phase.textContent = f.away ? t("Paused — you're away") : phaseLabel(f.phase);
    clear(dots);
    for (let i = 0; i < f.rounds; i++) dots.append(h("i", { class: i < f.round ? "done" : "" }));
    clear(controls);
    const cmd = (a: "start" | "pause" | "skip" | "reset") => () => void Bridge.focusCommand(a).then((s) => s && ((data.focus = s), render()));
    controls.append(
      h("button", { class: "round", title: t("Reset"), "aria-label": t("Reset"), onclick: cmd("reset"), disabled: f.phase === "idle" }, icon(I.reset)),
      f.running
        ? h("button", { class: "round big", title: t("Pause"), "aria-label": t("Pause"), onclick: cmd("pause") }, icon(I.pause, 22))
        : h("button", { class: "round big", title: t("Start"), "aria-label": t("Start"), onclick: cmd("start") }, icon(I.play, 22)),
      h("button", { class: "round", title: t("Skip"), "aria-label": t("Skip"), onclick: cmd("skip"), disabled: f.phase === "idle" }, icon(I.skip)),
    );
    today.textContent = `${tn("{n} round today", "{n} rounds today", f.todayRounds, { n: f.todayRounds })} · ${f.todayMin < 60 ? t("{m} min", { m: f.todayMin }) : formatDuration(f.todayMin * 60)}`
      + (prefs.focus.autoStart ? ` · ${t("Auto")}` : "");
  };

  const tick = (now: number) => {
    const f = data.focus;
    if (!f) return;
    const left = f.phase === "idle" ? prefs.focus.focusMin * 60_000 : focusLeft(f, now);
    clock.textContent = formatClock(left);
    ring.set(focusProgress(f, now), PHASE_COLOR[f.phase === "idle" ? "focus" : f.phase]);
  };

  return { id: "focus", el, body, render, tick };
}

// Claude ───────────────────────────────────────────────────────────────────────

function claudeTile(): Tile {
  const { el, body } = shell("claude");
  let key = "";
  const render = () => {
    const k = JSON.stringify([settings.showUsageStats, data.claude?.files, data.claude?.hours.length, data.plan, language()]);
    if (k === key) return;
    key = k;
    clear(body);
    const plan = data.plan;
    if (plan?.fiveHour || plan?.sevenDay) {
      const row = (label: string, w: { usedPct: number; resetsAt: number } | undefined) => {
        if (!w) return null;
        const resets = w.resetsAt > Date.now() ? formatDuration((w.resetsAt - Date.now()) / 1000) : "";
        return h("div", { class: "limit" },
          h("div", { class: "limit-head" }, h("span", { text: label }), h("b", { text: `${Math.round(w.usedPct)}%` })),
          bar(w.usedPct / 100, LEVEL_COLOR[level(w.usedPct / 100, 0.7, 0.9)]),
          resets ? h("div", { class: "muted small", text: t("Resets in {time}", { time: resets }) }) : null,
        );
      };
      body.append(h("div", { class: "limits" }, row(t("5 hours"), plan.fiveHour), row(t("Week"), plan.sevenDay)));
    }
    if (!settings.showUsageStats) {
      body.append(empty(t("Count the tokens Claude Code uses, from its own files on this PC."),
        h("button", { class: "pill-btn", text: t("Turn on"), onclick: () => {
          settings = { ...settings, showUsageStats: true };
          void save().then(loadClaude);
        } })));
      return;
    }
    const u = data.claude;
    if (!u || u.hours.length === 0) {
      body.append(empty(t("No usage yet")));
      return;
    }
    const days = dailyTotals(u, new Date(), 7);
    const todayTokens = days[days.length - 1]?.tokens ?? 0;
    const weekTokens = days.reduce((n, d) => n + d.tokens, 0);
    const peak = Math.max(1, ...days.map((d) => d.tokens));
    body.append(
      h("div", { class: "stats3" },
        h("div", {}, h("b", { text: compactNumber(todayTokens) }), h("span", { text: t("Today") })),
        h("div", {}, h("b", { text: compactNumber(weekTokens) }), h("span", { text: t("7 days") })),
        h("div", {}, h("b", { text: compactNumber(totalTokens(u)) }), h("span", { text: t("30 days") })),
      ),
      h("div", { class: "minibars" }, ...days.map((d, i) => {
        const date = new Date(`${d.day}T12:00:00`);
        return h("div", { class: `minibar${i === days.length - 1 ? " today" : ""}`, title: `${d.day} · ${compactNumber(d.tokens)}` },
          h("i", { style: `height:${Math.max(3, (d.tokens / peak) * 100)}%` }),
          h("span", { text: weekdayShort(date.getDay()) }));
      })),
      h("div", { class: "models" }, ...u.models.slice(0, 3).map(([m, n]) =>
        h("div", { class: "model" }, h("span", { text: m.replace(/^claude-/, "") }), h("b", { text: compactNumber(n) })))),
    );
  };
  return { id: "claude", el, body, render };
}

// PC vitals ────────────────────────────────────────────────────────────────────

function gaugeTile(id: "cpu" | "memory", read: (st: SystemStats) => { f: number; big: string; lines: string[]; color: string }): Tile {
  const { el, body } = shell(id);
  const ring = new Ring(92, 9);
  const big = h("b", { class: "gauge-value" });
  const lines = h("div", { class: "gauge-lines" });
  const spark = h("div", { class: "gauge-spark" });
  body.append(h("div", { class: "gauge" }, h("div", { class: "gauge-ring" }, ring.el, big), lines), spark);
  const render = () => {
    const st = data.stats;
    if (!st) return;
    const r = read(st);
    ring.set(r.f, r.color);
    big.textContent = r.big;
    clear(lines);
    for (const l of r.lines) lines.append(h("div", { text: l }));
    clear(spark);
    if (id === "cpu") spark.append(sparkline(data.cpu, r.color, 100));
    el.classList.toggle("hot", r.color === LEVEL_COLOR.hot);
  };
  return { id, el, body, render };
}

const cpuTile = () => gaugeTile("cpu", (st) => {
  const f = (st.cpu ?? 0) / 100;
  const tl = tempLevel(st.tempC);
  const color = LEVEL_COLOR[tl === "hot" || level(f, 0.7, 0.9) === "hot" ? "hot" : tl === "warn" || level(f, 0.7, 0.9) === "warn" ? "warn" : "ok"];
  return {
    f, color,
    big: st.cpu == null ? "–" : `${Math.round(st.cpu)}%`,
    lines: [
      st.tempC == null ? t("Temperature: n/a") : t("Temperature: {c} °C", { c: st.tempC.toFixed(0) }),
      tn("{n} core", "{n} cores", st.cores, { n: st.cores }),
    ],
  };
});

const memoryTile = () => gaugeTile("memory", (st) => {
  const f = ratio(st.memUsed, st.memTotal);
  return {
    f, color: LEVEL_COLOR[level(f, 0.8, 0.92)],
    big: `${Math.round(f * 100)}%`,
    lines: [`${formatBytes(st.memUsed)} / ${formatBytes(st.memTotal)}`, t("{size} free", { size: formatBytes(st.memTotal - st.memUsed) })],
  };
});

function diskTile(): Tile {
  const { el, body } = shell("disk");
  let key = "";
  const render = () => {
    const st = data.stats;
    if (!st) return;
    const k = JSON.stringify([Math.round(st.diskFree / 2 ** 27), st.diskTotal, language()]);
    if (k === key) return;
    key = k;
    clear(body);
    const used = st.diskTotal - st.diskFree;
    const f = ratio(used, st.diskTotal);
    const low = diskLow(st);
    el.classList.toggle("hot", low);
    body.append(
      h("div", { class: "disk-head" }, h("span", { class: "drive", text: st.disk }), h("b", { text: t("{size} free", { size: formatBytes(st.diskFree) }) })),
      bar(f, LEVEL_COLOR[low ? "hot" : level(f, 0.8, 0.9)]),
      h("div", { class: "muted small", text: `${formatBytes(used)} / ${formatBytes(st.diskTotal)} · ${Math.round(f * 100)}%` }),
      ...(low ? [h("div", { class: "warn-line", text: t("Running out of space") })] : []),
    );
  };
  return { id: "disk", el, body, render };
}

function networkTile(): Tile {
  const { el, body } = shell("network");
  const render = () => {
    const st = data.stats;
    if (!st) return;
    clear(body);
    body.append(
      h("div", { class: "net" },
        h("div", {}, h("span", { class: "arrow down", text: "↓" }), h("b", { text: formatRate(st.netDown) })),
        h("div", {}, h("span", { class: "arrow up", text: "↑" }), h("b", { text: formatRate(st.netUp) })),
      ),
      h("div", { class: "net-sparks" }, sparkline(data.down, "#22D3EE"), sparkline(data.up, "#F472B6")),
    );
  };
  return { id: "network", el, body, render };
}

function uptimeTile(): Tile {
  const { el, body } = shell("uptime");
  let key = "";
  const render = () => {
    const st = data.stats;
    if (!st) return;
    const k = JSON.stringify([Math.floor(st.uptimeSecs / 60), st.battery, language()]);
    if (k === key) return;
    key = k;
    clear(body);
    const since = new Date(Date.now() - st.uptimeSecs * 1000);
    body.append(
      h("div", { class: "big-number", text: formatDuration(st.uptimeSecs) }),
      h("div", { class: "muted small", text: t("Since {time}", { time: since.toLocaleString(language(), { weekday: "short", hour: "2-digit", minute: "2-digit" }) }) }),
    );
    if (st.battery) {
      const b = st.battery;
      body.append(
        h("div", { class: "battery" },
          h("span", { text: `${b.charging ? "⚡" : "🔋"} ${b.percent}%` }),
          bar(b.percent / 100, LEVEL_COLOR[b.percent <= 15 ? "hot" : b.percent <= 30 ? "warn" : "ok"]),
          b.secsLeft != null && !b.charging ? h("span", { class: "muted small", text: t("{time} left", { time: formatDuration(b.secsLeft) }) }) : null,
        ),
      );
    }
  };
  return { id: "uptime", el, body, render };
}

function appsTile(): Tile {
  const { el, body } = shell("apps");
  let key = "";
  const render = () => {
    const apps = data.stats?.apps;
    if (!apps) return;
    const k = JSON.stringify(apps.slice(0, 12).map((a) => [a.name, Math.round(a.mem / 2 ** 24), a.windowed]));
    if (k === key) return;
    key = k;
    clear(body);
    const peak = Math.max(1, ...apps.map((a) => a.mem));
    const background = apps.filter((a) => !a.windowed).length;
    body.append(h("div", { class: "muted small", text: tn("{n} app in the background", "{n} apps in the background", background, { n: background }) }));
    const list = h("div", { class: "app-list" });
    for (const a of apps.slice(0, 12)) {
      list.append(
        h("div", { class: "app-row" },
          h("span", { class: "app-name", text: appName(a.name), title: `${a.name} · ${a.processes}` }),
          h("span", { class: "tag", text: a.windowed ? "" : t("Background") }),
          h("div", { class: "app-bar" }, bar(a.mem / peak, appColor(a.name))),
          h("b", { class: "app-mem", text: formatBytes(a.mem) }),
          a.canEnd
            ? confirmButton(t("End"), t("Sure?"), "mini-btn", () => void Bridge.systemEndApp(a.name).then(() => void sampleSystem(true)))
            : h("span", { class: "mini-btn ghost" }),
        ),
      );
    }
    body.append(list);
  };
  return { id: "apps", el, body, render };
}

// Screen time ──────────────────────────────────────────────────────────────────

function screenTile(): Tile {
  const { el, body } = shell("screentime");
  let key = "";
  const render = () => {
    const st = data.screen;
    const k = JSON.stringify([prefs.screenTime, st, language()]);
    if (k === key) return;
    key = k;
    clear(body);
    if (!prefs.screenTime) {
      body.append(empty(t("See how long you use each app. Only app names and times are kept, on this PC."),
        h("button", { class: "pill-btn", text: t("Turn on"), onclick: () => {
          prefs = { ...prefs, screenTime: true };
          void save().then(() => window.setTimeout(loadScreen, 6000));
        } })));
      return;
    }
    if (!st) return;
    const today = st.days[st.today];
    const yesterday = st.days[week(st)[5].day];
    const days = week(st);
    const peak = Math.max(1, ...days.map((d) => d.secs));
    const clockOf = (min: number | null | undefined) =>
      min == null ? "–" : new Date(2000, 0, 1, Math.floor(min / 60), min % 60).toLocaleTimeString(language(), { hour: "2-digit", minute: "2-digit" });
    const diff = today && yesterday ? today.active - yesterday.active : null;
    body.append(
      h("div", { class: "screen-grid" },
        h("div", { class: "screen-summary" },
          h("div", { class: "big-number", text: formatDuration(today?.active ?? 0) }),
          h("div", { class: "muted small", text: t("Active today · first at {time}", { time: clockOf(today?.first) }) }),
          diff != null ? h("div", { class: `delta ${diff > 0 ? "more" : "less"}`, text: `${diff > 0 ? "▲" : "▼"} ${formatDuration(Math.abs(diff))} ${t("vs yesterday")}` }) : null,
          h("div", { class: "now-apps" },
            h("div", {}, h("span", { class: "muted small", text: t("Now") }), h("b", { text: st.current ? appName(st.current) : "–" })),
            h("div", {}, h("span", { class: "muted small", text: t("Last used") }), h("b", { text: st.previous ? appName(st.previous) : "–" })),
          ),
        ),
        h("div", { class: "weekbars" }, ...days.map((d, i) => {
          const date = new Date(`${d.day}T12:00:00`);
          return h("div", { class: `minibar${i === 6 ? " today" : ""}`, title: `${d.day} · ${formatDuration(d.secs)}` },
            h("i", { style: `height:${Math.max(3, (d.secs / peak) * 100)}%` }),
            h("span", { text: weekdayShort(date.getDay()) }));
        })),
        h("div", { class: "top-apps" }, ...topApps(today, 6).map(([app, secs]) =>
          h("div", { class: "app-row" },
            h("span", { class: "app-name", text: appName(app) }),
            h("div", { class: "app-bar" }, bar(secs / (topApps(today, 1)[0]?.[1] || 1), appColor(app))),
            h("b", { class: "app-mem", text: formatDuration(secs) }),
          ))),
      ),
    );
  };
  return { id: "screentime", el, body, render };
}

// News ─────────────────────────────────────────────────────────────────────────

function newsTile(): Tile {
  const refresh = h("button", { class: "icon-btn", title: t("Refresh"), "aria-label": t("Refresh"), onclick: () => void loadNews(true) }, icon(I.refresh, 14));
  const { el, body } = shell("news", refresh);
  let key = "";
  const render = () => {
    const k = JSON.stringify([data.news.map((n) => [n.title, n.urgent]), data.newsError, Math.floor(Date.now() / 300_000), language()]);
    if (k === key) return;
    key = k;
    clear(body);
    if (prefs.newsFeeds.length === 0) {
      body.append(empty(t("Add RSS feeds in Settings → Dashboard.")));
      return;
    }
    if (data.news.length === 0) {
      body.append(empty(data.newsError ? t("Couldn't load the news.") : t("Loading…")));
      return;
    }
    const urgent = data.news.some((n) => n.urgent);
    el.classList.toggle("alert", urgent);
    const list = h("div", { class: "news-list" });
    for (const n of data.news.slice(0, 14)) {
      const age = ageMinutes(n.at, Date.now());
      const when = age < 0 ? "" : age < 60 ? t("{n} min ago", { n: Math.max(1, age) }) : age < 1440 ? t("{n} h ago", { n: Math.round(age / 60) }) : n.at ? new Date(n.at).toLocaleDateString(language()) : "";
      list.append(
        h("a", { class: `headline${n.urgent ? " urgent" : ""}`, href: "#", onclick: (e: Event) => {
          e.preventDefault();
          if (n.link) void Bridge.openUrl(n.link);
        } },
          n.urgent ? h("span", { class: "badge", text: t("Breaking") }) : null,
          h("span", { class: "headline-title", text: n.title }),
          h("span", { class: "headline-meta", text: [n.source, when].filter(Boolean).join(" · ") }),
        ),
      );
    }
    body.append(list);
  };
  return { id: "news", el, body, render };
}

// Weather ──────────────────────────────────────────────────────────────────────

function weatherTile(): Tile {
  const { el, body } = shell("weather");
  let key = "";
  const render = () => {
    const k = JSON.stringify([prefs.weatherCity, data.weather, data.weatherError, language()]);
    if (k === key) return;
    key = k;
    clear(body);
    if (!prefs.weatherCity.trim()) {
      const input = h("input", { class: "text", placeholder: t("Your city"), "aria-label": t("Your city") }) as HTMLInputElement;
      const go = () => {
        const city = input.value.trim();
        if (!city) return;
        prefs = { ...prefs, weatherCity: city };
        void save().then(() => loadWeather());
      };
      input.onkeydown = (e) => e.key === "Enter" && go();
      body.append(empty(t("From Open-Meteo for this city, only when you ask."), h("div", { class: "row" }, input, h("button", { class: "pill-btn", text: t("Save"), onclick: go }))));
      return;
    }
    const w = data.weather;
    if (!w) {
      body.append(empty(data.weatherError ? t("Couldn't load the weather.") : t("Loading…")));
      return;
    }
    const now = weatherInfo(w.current.weather_code, w.current.is_day === 1);
    body.append(
      h("div", { class: "weather-now" },
        h("span", { class: "weather-icon", text: now.icon }),
        h("div", {},
          h("div", { class: "big-number", text: `${Math.round(w.current.temperature_2m)}°` }),
          h("div", { class: "muted small", text: `${t(now.label)} · ${w.place}` }),
        ),
      ),
      h("div", { class: "muted small", text: t("Feels like {t}° · wind {w} km/h · humidity {h}%", {
        t: Math.round(w.current.apparent_temperature), w: Math.round(w.current.wind_speed_10m), h: Math.round(w.current.relative_humidity_2m),
      }) }),
      h("div", { class: "forecast" }, ...w.daily.time.slice(0, 5).map((day, i) => {
        const info = weatherInfo(w.daily.weather_code[i]);
        return h("div", {},
          h("span", { class: "muted small", text: weekdayShort(new Date(`${day}T12:00:00`).getDay()) }),
          h("span", { text: info.icon }),
          h("b", { text: `${Math.round(w.daily.temperature_2m_max[i])}°` }),
          h("span", { class: "muted small", text: `${Math.round(w.daily.temperature_2m_min[i])}°` }),
        );
      })),
    );
  };
  return { id: "weather", el, body, render };
}

// Speed test ───────────────────────────────────────────────────────────────────

function speedTile(): Tile {
  const { el, body } = shell("speed");
  const render = () => {
    clear(body);
    const r = data.speed;
    el.classList.toggle("busy", data.speedRunning);
    body.append(
      h("div", { class: "speed" },
        h("div", {}, h("b", { text: r ? `${r.downMbps}` : "–" }), h("span", { text: `Mbps ↓` })),
        h("div", {}, h("b", { text: r ? `${r.upMbps}` : "–" }), h("span", { text: `Mbps ↑` })),
        h("div", {}, h("b", { text: r ? `${Math.round(r.pingMs)}` : "–" }), h("span", { text: `ms` })),
      ),
      ...(data.speedError ? [h("div", { class: "warn-line", text: t("The test didn't finish.") })] : []),
      h("button", { class: "pill-btn", disabled: data.speedRunning, text: data.speedRunning ? t("Testing…") : t("Run test"), onclick: runSpeedTest }),
    );
  };
  return { id: "speed", el, body, render };
}

async function runSpeedTest() {
  if (data.speedRunning) return;
  data.speedRunning = true;
  data.speedError = false;
  renderAll();
  const r = await Bridge.speedTest();
  data.speedRunning = false;
  if (r) data.speed = r;
  else data.speedError = true;
  renderAll();
}

// Quick actions ────────────────────────────────────────────────────────────────

function actionsTile(): Tile {
  const { el, body } = shell("actions");
  const render = () => {
    clear(body);
    const act = (label: string, emoji: string, run: () => void) =>
      h("button", { class: "action", onclick: run }, h("span", { class: "action-icon", text: emoji }), h("span", { text: label }));
    body.append(
      h("div", { class: "actions" },
        act(t("Task Manager"), "📊", () => void Bridge.quickAction("taskManager")),
        act(t("Snip"), "✂️", () => void Bridge.quickAction("snip")),
        act(t("Lock"), "🔒", () => void Bridge.quickAction("lock")),
        act(t("Sound"), "🔊", () => void Bridge.quickAction("soundSettings")),
        confirmButton(`🗑️ ${t("Empty Recycle Bin")}`, t("Empty it?"), "action wide-action", () => void Bridge.quickAction("emptyRecycleBin")),
        act(t("Settings…"), "⚙️", () => void Bridge.openSettingsWindow()),
      ),
    );
  };
  return { id: "actions", el, body, render };
}

// Music played ─────────────────────────────────────────────────────────────────

function listeningTile(): Tile {
  const { el, body } = shell("listening");
  let key = "";
  const render = () => {
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const sum = listeningSummary(data.plays, day);
    const k = JSON.stringify([sum, language()]);
    if (k === key) return;
    key = k;
    clear(body);
    if (sum.tracks === 0) {
      body.append(empty(t("Songs you listen to for 30 seconds or more show up here.")));
      return;
    }
    const peak = Math.max(1, ...sum.artists.map((a) => a[1]));
    body.append(
      h("div", { class: "stats3 two" },
        h("div", {}, h("b", { text: String(sum.minutes) }), h("span", { text: t("minutes this week") })),
        h("div", {}, h("b", { text: String(sum.tracks) }), h("span", { text: t("songs") })),
      ),
      h("div", { class: "top-apps" }, ...sum.artists.map(([artist, secs]) =>
        h("div", { class: "app-row" },
          h("span", { class: "app-name", text: artist }),
          h("div", { class: "app-bar" }, bar(secs / peak, appColor(artist))),
          h("b", { class: "app-mem", text: formatDuration(secs) }),
        ))),
    );
  };
  return { id: "listening", el, body, render };
}


// Claude jobs ──────────────────────────────────────────────────────────────────

const FOLDER_KEY = "coucou.jobFolder";

function jobsTile(): Tile {
  const { el, body } = shell("jobs");
  const savedFolder = (() => {
    try {
      return window.localStorage?.getItem(FOLDER_KEY) ?? "";
    } catch {
      return "";
    }
  })();
  const prompt = h("textarea", { class: "text job-prompt", rows: 2, placeholder: t("What should Claude Code do?") }) as HTMLTextAreaElement;
  const folder = h("input", { class: "text", value: savedFolder, placeholder: t("Folder (e.g. C:\\Users\\you\\project)"), spellcheck: "false" }) as HTMLInputElement;
  const when = h("select", { class: "text job-when" }) as HTMLSelectElement;
  for (const [v, label] of [["now", t("Now")], ["once", t("Once")], ["daily", t("Every day")], ["weekdays", t("Weekdays")]]) {
    when.append(h("option", { value: v, text: label }));
  }
  const now = new Date(Date.now() + 5 * 60_000);
  const time = h("input", { class: "text job-time", type: "time", value: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}` }) as HTMLInputElement;
  const autoEdit = h("input", { type: "checkbox" }) as HTMLInputElement;
  const go = h("button", { class: "pill-btn", text: t("Run now") }) as HTMLButtonElement;
  const status = h("div", { class: "muted small" });
  const list = h("div", { class: "job-list" });
  const syncForm = () => {
    time.style.display = when.value === "now" ? "none" : "";
    go.textContent = when.value === "now" ? t("Run now") : t("Schedule");
  };
  when.onchange = syncForm;
  syncForm();
  go.onclick = async () => {
    const p = prompt.value.trim();
    if (!p) return prompt.focus();
    const f = folder.value.trim();
    try {
      window.localStorage?.setItem(FOLDER_KEY, f);
    } catch {
      /* a convenience only */
    }
    go.disabled = true;
    const ok = when.value === "now"
      ? (await Bridge.claudePrompt(p, f, autoEdit.checked)) != null
      : (await Bridge.jobSave({ id: "", prompt: p, folder: f, at: time.value, date: "", repeat: when.value as "once" | "daily" | "weekdays", enabled: true, autoEdit: autoEdit.checked })) != null;
    go.disabled = false;
    if (ok) {
      prompt.value = "";
      el.classList.add("sent");
      window.setTimeout(() => el.classList.remove("sent"), 900);
    }
    status.textContent = ok ? "" : t("Couldn't add it.");
    void loadJobs();
  };
  prompt.onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      go.click();
    }
  };
  body.append(
    h("div", { class: "job-form" },
      prompt,
      h("div", { class: "row" }, folder),
      h("div", { class: "row" }, when, time, h("label", { class: "muted small check" }, autoEdit, t("Let it edit files")), h("span", { class: "spacer" }), go),
    ),
    status,
    list,
  );

  let key = "";
  const render = () => {
    const k = JSON.stringify([data.jobs, data.claudeExe, language()]);
    if (k === key) return;
    key = k;
    clear(list);
    if (data.claudeExe === null) {
      list.append(h("div", { class: "warn-line", text: t("Claude Code was not found. Install it, or add `claude` to your PATH.") }));
    }
    const jobs = [...data.jobs].sort((a, b) => Number(b.running) - Number(a.running) || (b.lastRun ?? 0) - (a.lastRun ?? 0));
    for (const j of jobs.slice(0, 12)) {
      const state = j.running ? "running" : j.lastOk === true ? "ok" : j.lastOk === false ? "failed" : "waiting";
      const sched = j.enabled
        ? `${j.at} · ${j.repeat === "once" ? (j.date || t("Once")) : j.repeat === "daily" ? t("Every day") : t("Weekdays")}`
        : j.lastRun ? new Date(j.lastRun).toLocaleString(language(), { weekday: "short", hour: "2-digit", minute: "2-digit" }) : t("Off");
      const row = h("details", { class: `job ${state}` },
        h("summary", {},
          h("span", { class: "job-dot" }),
          h("span", { class: "job-text", text: j.prompt }),
          h("span", { class: "job-meta", text: `${sched} · ${(j.folder || "~").split(/[\\/]/).pop()}` }),
          h("span", { class: "job-actions" },
            h("button", { class: "mini-btn", title: t("Run now"), disabled: j.running, onclick: (e: Event) => { e.preventDefault(); void Bridge.jobRun(j.id); } }, "▶"),
            j.repeat !== "once" || j.enabled
              ? h("button", { class: "mini-btn", text: j.enabled ? t("On") : t("Off"), onclick: (e: Event) => { e.preventDefault(); void Bridge.jobSave({ ...j, enabled: !j.enabled }).then(loadJobs); } })
              : null,
            confirmButton("✕", t("Sure?"), "mini-btn", () => void Bridge.jobDelete(j.id).then(loadJobs)),
          ),
        ),
        j.lastOutput ? h("pre", { class: "job-output", text: j.lastOutput }) : h("div", { class: "muted small", text: j.running ? t("Claude Code is working…") : t("Not run yet") }),
      );
      list.append(row);
    }
    if (!jobs.length && data.claudeExe !== null) list.append(h("div", { class: "muted small", text: t("Give Claude Code a job now, or for later — it runs in that folder and its answer shows here.") }));
  };
  return { id: "jobs", el, body, render };
}

async function loadJobs() {
  const r = await Bridge.jobsList();
  if (r) {
    data.jobs = r.jobs;
    data.claudeExe = r.claude;
  }
  tiles.get("jobs")?.render();
}


// Cleanup ──────────────────────────────────────────────────────────────────────

const CLEANUP_LABELS: Record<string, () => string> = {
  "Temporary files": () => t("Temporary files"),
  "Chrome cache": () => t("Chrome cache"),
  "Edge cache": () => t("Edge cache"),
  "npm cache": () => t("npm cache"),
  "pip cache": () => t("pip cache"),
  "Recycle Bin": () => t("Recycle Bin"),
};

function cleanupTile(): Tile {
  const { el, body } = shell("cleanup");
  let items: CleanupItem[] | null = null;
  let picked = new Set<string>();
  let scanning = false;
  let freed: number | null = null;
  let working = false;

  const scan = async () => {
    scanning = true;
    freed = null;
    render();
    items = (await Bridge.cleanupScan()) ?? [];
    picked = new Set(items.filter(cleanupDefault).map((i) => i.id));
    scanning = false;
    render();
  };

  const clean = async () => {
    working = true;
    render();
    const ids = [...picked];
    freed = (await Bridge.cleanupRun(ids)) ?? 0;
    working = false;
    items = null;
    render();
    void sampleSystem(false);
  };

  const render = () => {
    clear(body);
    const disk = data.stats;
    if (disk) {
      body.append(h("div", { class: "muted small", text: `${disk.disk} ${t("{size} free", { size: formatBytes(disk.diskFree) })}` }));
    }
    if (freed != null) {
      body.append(h("div", { class: "cleanup-done" }, h("b", { text: t("Freed {size}", { size: formatBytes(freed) }) })));
    }
    if (scanning || working) {
      body.append(h("div", { class: "cleanup-busy" }, h("i"), h("span", { text: working ? t("Cleaning…") : t("Scanning…") })));
      return;
    }
    if (items == null) {
      body.append(
        h("div", { class: "muted small", text: t("See what caches and old build folders take. Nothing is deleted until you pick it and confirm.") }),
        h("button", { class: "pill-btn", text: t("Scan"), onclick: () => void scan() }),
      );
      return;
    }
    if (items.length === 0) {
      body.append(h("div", { class: "muted small", text: t("Nothing to clean.") }), h("button", { class: "pill-btn", text: t("Scan again"), onclick: () => void scan() }));
      return;
    }
    const list = h("div", { class: "cleanup-list" });
    for (const item of items) {
      const box = h("input", { type: "checkbox" }) as HTMLInputElement;
      box.checked = picked.has(item.id);
      box.onchange = () => {
        if (box.checked) picked.add(item.id);
        else picked.delete(item.id);
        render();
      };
      const label = CLEANUP_LABELS[item.label]?.() ?? item.label;
      list.append(
        h("label", { class: `cleanup-row ${item.kind}`, title: item.path },
          box,
          h("span", { class: "cleanup-name", text: label }),
          item.kind === "project" ? h("span", { class: "tag", text: t("Rebuilds later") }) : null,
          h("b", { class: "app-mem", text: formatBytes(item.bytes) }),
        ),
      );
    }
    const total = cleanupTotal(items, picked);
    body.append(
      list,
      h("div", { class: "row" },
        picked.size
          ? confirmButton(t("Clean {size}", { size: formatBytes(total) }), t("Sure?"), "pill-btn", () => void clean())
          : h("button", { class: "pill-btn", disabled: true, text: t("Pick something") }),
        h("button", { class: "mini-btn", text: t("Scan again"), onclick: () => void scan() }),
      ),
    );
  };
  return { id: "cleanup", el, body, render };
}

const BUILDERS: Record<TileId, () => Tile> = {
  cleanup: cleanupTile,
  jobs: jobsTile,
  music: musicTile, focus: focusTile, claude: claudeTile, cpu: cpuTile, memory: memoryTile, disk: diskTile,
  network: networkTile, uptime: uptimeTile, screentime: screenTile, apps: appsTile, news: newsTile,
  weather: weatherTile, speed: speedTile, actions: actionsTile, listening: listeningTile,
};

// ── Header and Mochi ──────────────────────────────────────────────────────────

const engine = new BotEngine();
const mochiCanvas = h("canvas", { class: "mochi", width: 128, height: 128 }) as HTMLCanvasElement;
const greet = h("h1", { class: "greet" });
const dateLine = h("div", { class: "date" });
const chips = h("div", { class: "chips" });

function header(): HTMLElement {
  const settingsBtn = h("button", { class: "icon-btn", title: t("Settings…"), "aria-label": t("Settings…"), onclick: () => void Bridge.openSettingsWindow() }, icon(I.gear, 16));
  return h("header", { class: "top" },
    mochiCanvas,
    h("div", { class: "hello" }, greet, dateLine),
    h("span", { class: "spacer" }),
    chips,
    settingsBtn,
  );
}

function greeting(hour: number): string {
  if (hour < 5) return t("Up late?");
  if (hour < 12) return t("Good morning");
  if (hour < 18) return t("Good afternoon");
  return t("Good evening");
}

function renderHeader(now: Date) {
  greet.textContent = greeting(now.getHours());
  dateLine.textContent = now.toLocaleString(language(), { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  clear(chips);
  const st = data.stats;
  const chip = (text: string, cls = "") => h("span", { class: `chip ${cls}` }, text);
  if (st) {
    chips.append(chip(`CPU ${st.cpu == null ? "–" : Math.round(st.cpu)}%`, level((st.cpu ?? 0) / 100, 0.7, 0.9)));
    chips.append(chip(`RAM ${Math.round(ratio(st.memUsed, st.memTotal) * 100)}%`, level(ratio(st.memUsed, st.memTotal), 0.8, 0.92)));
    if (st.tempC != null) chips.append(chip(`${Math.round(st.tempC)} °C`, tempLevel(st.tempC)));
  }
  if (data.focus && data.focus.phase !== "idle") chips.append(chip(`${phaseLabel(data.focus.phase)} ${formatClock(focusLeft(data.focus, now.getTime()))}`, "focus"));
}

const mood = { studious: false };
function syncMood() {
  const m = mochiMood({
    cpu: data.stats?.cpu ?? null,
    tempC: data.stats?.tempC ?? null,
    playing: !!data.media?.playing,
    focus: data.focus,
    urgentNews: data.news.some((n) => n.urgent),
  });
  engine.setState(m.state);
  engine.setDancing(m.dancing);
  mood.studious = m.studious;
  engine.setOutfit(m.studious ? "roundGlasses" : resolveOutfit(parseOutfit(settings.mochiOutfit), new Date()), true);
}

let lastFrame = performance.now();
function drawMochi(now: number) {
  const ctx = mochiCanvas.getContext("2d");
  if (!ctx) return;
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  engine.update(dt);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = 64;
  mochiCanvas.width = size * dpr;
  mochiCanvas.height = size * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  engine.applyDance(ctx, size, size);
  engine.draw(ctx, size, size);
  ctx.restore();
}

mochiCanvas.addEventListener("click", () => engine.slap());
mochiCanvas.addEventListener("pointermove", (e) => {
  const r = mochiCanvas.getBoundingClientRect();
  engine.lookX = Math.max(-1, Math.min(1, (e.clientX - r.left - r.width / 2) / r.width));
  engine.lookY = Math.max(-1, Math.min(1, (e.clientY - r.top - r.height / 2) / r.height));
});

// ── Background tint from the cover ────────────────────────────────────────────

function tintFromCover(dataUrl: string | null) {
  if (!dataUrl) {
    document.body.style.removeProperty("--accent");
    return;
  }
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = c.height = 16;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, 16, 16);
    const px = ctx.getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const max = Math.max(px[i], px[i + 1], px[i + 2]);
      const min = Math.min(px[i], px[i + 1], px[i + 2]);
      // Colourful pixels count; greys and near-blacks don't tint anything.
      if (max - min < 24 || max < 40) continue;
      r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
    }
    if (n === 0) return document.body.style.removeProperty("--accent");
    document.body.style.setProperty("--accent", `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`);
  };
  img.src = dataUrl;
}

// ── Layout ────────────────────────────────────────────────────────────────────

let tiles = new Map<TileId, Tile>();
const grid = h("main", { class: "grid" });

/** Tiles rise and bars grow — once, while the window is on screen. */
let entranceTimer = 0;
function enter() {
  window.clearTimeout(entranceTimer);
  grid.classList.remove("entering");
  void grid.offsetWidth; // restart the animations
  grid.classList.add("entering");
  entranceTimer = window.setTimeout(() => grid.classList.remove("entering"), 1400);
}

function build() {
  clear(root);
  tiles = new Map();
  clear(grid);
  for (const id of tileOrder(prefs.tiles)) {
    const tile = BUILDERS[id]();
    tiles.set(id, tile);
    wireDrag(tile);
    grid.append(tile.el);
  }
  root.append(h("div", { class: "backdrop" }, h("i"), h("i"), h("i")), header(), grid);
  if (document.visibilityState === "visible") enter();
  // Staggered entrance.
  [...grid.children].forEach((el, i) => (el as HTMLElement).style.setProperty("--i", String(i)));
  renderAll();
}

function renderAll() {
  for (const tile of tiles.values()) tile.render();
  renderHeader(new Date());
  syncMood();
}

let dragging: TileId | null = null;
function wireDrag(tile: Tile) {
  const grip = tile.el.querySelector(".grip") as HTMLElement;
  grip.addEventListener("pointerdown", () => (tile.el.draggable = true));
  tile.el.addEventListener("dragstart", (e) => {
    dragging = tile.id;
    tile.el.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", tile.id);
  });
  tile.el.addEventListener("dragend", () => {
    dragging = null;
    tile.el.draggable = false;
    tile.el.classList.remove("dragging");
    for (const t of tiles.values()) t.el.classList.remove("drop-before");
  });
  tile.el.addEventListener("dragover", (e) => {
    if (!dragging || dragging === tile.id) return;
    e.preventDefault();
    for (const t of tiles.values()) t.el.classList.toggle("drop-before", t === tile);
  });
  tile.el.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!dragging || dragging === tile.id) return;
    const order = moveTile(tileOrder(prefs.tiles), dragging, tile.id);
    prefs = { ...prefs, tiles: order };
    const moved = tiles.get(dragging)!.el;
    grid.insertBefore(moved, tile.el);
    void save();
  });
}

// ── Loading ───────────────────────────────────────────────────────────────────

let systemTick = 0;
async function sampleSystem(detail = systemTick % 3 === 0) {
  systemTick++;
  const st = await Bridge.systemStats(detail);
  if (!st) return;
  const apps = st.apps ?? data.stats?.apps ?? null;
  data.stats = { ...st, apps };
  const push = (arr: number[], v: number | null) => {
    if (v == null) return;
    arr.push(v);
    if (arr.length > HISTORY) arr.shift();
  };
  push(data.cpu, st.cpu);
  push(data.down, st.netDown);
  push(data.up, st.netUp);
  for (const id of ["cpu", "memory", "disk", "network", "uptime", "apps"] as const) tiles.get(id)?.render();
  renderHeader(new Date());
  syncMood();
}

async function loadScreen() {
  if (!prefs.screenTime) return;
  const st = await Bridge.screenTime();
  if (st) data.screen = st;
  tiles.get("screentime")?.render();
}

async function loadNews(force = false) {
  if (!force && Date.now() - data.newsAt < 10 * 60_000) return;
  data.newsAt = Date.now();
  const feeds = await Bridge.newsFetch();
  if (!feeds) {
    data.newsError = true;
  } else {
    const now = Date.now();
    data.news = mergeFeeds(feeds.filter((f) => f.body).map((f) => parseFeed(f.body!, f.url, prefs.newsKeywords, now)));
    data.newsError = data.news.length === 0 && feeds.some((f) => f.error);
  }
  tiles.get("news")?.render();
  syncMood();
}

let weatherAt = 0;
async function loadWeather(force = true) {
  if (!prefs.weatherCity.trim()) return;
  if (!force && Date.now() - weatherAt < 30 * 60_000) return;
  weatherAt = Date.now();
  const w = await Bridge.weather();
  data.weather = w;
  data.weatherError = w ? "" : "failed";
  tiles.get("weather")?.render();
}

async function loadClaude() {
  if (settings.showUsageStats) {
    data.claude = parseUsage(await Bridge.claudeUsageStats());
  }
  try {
    const raw = window.localStorage?.getItem("coucou.claudePlanUsage");
    data.plan = raw ? (JSON.parse(raw) as PlanUsage) : null;
  } catch {
    data.plan = null;
  }
  tiles.get("claude")?.render();
}

async function loadMedia() {
  const m = await Bridge.mediaRefresh();
  if (m) data.media = m;
  data.plays = (await Bridge.mediaPlays()) ?? data.plays;
  tiles.get("music")?.render();
  tiles.get("listening")?.render();
}

// ── Running only while shown ──────────────────────────────────────────────────

const timers: number[] = [];
let frame = 0;

function start() {
  if (timers.length) return;
  enter();
  void sampleSystem(true);
  void loadScreen();
  void loadNews();
  void loadWeather(false);
  void loadClaude();
  void loadMedia();
  void loadJobs();
  void Bridge.focusGet().then((f) => f && ((data.focus = f), tiles.get("focus")?.render()));
  timers.push(
    window.setInterval(() => void sampleSystem(), 2000),
    window.setInterval(() => void loadScreen(), 30_000),
    window.setInterval(() => void loadNews(), 60_000),
    window.setInterval(() => void loadWeather(false), 60_000),
    window.setInterval(() => void loadClaude(), 60_000),
    window.setInterval(() => {
      const now = Date.now();
      for (const tile of tiles.values()) tile.tick?.(now);
      renderHeader(new Date(now));
    }, 1000),
  );
  const loop = (t: number) => {
    drawMochi(t);
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);
}

function stop() {
  while (timers.length) window.clearInterval(timers.pop());
  cancelAnimationFrame(frame);
}

function syncVisibility() {
  if (document.visibilityState === "visible") start();
  else stop();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) settings = { ...settings, ...boot.settings };
  prefs = dashboardPrefs(settings);
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
  document.title = t("Dashboard — Coucou");
  onLanguageChange(() => {
    document.title = t("Dashboard — Coucou");
    build();
  });
  build();

  void onEvent<Settings>("settings-changed", (next) => {
    const feedsBefore = JSON.stringify(prefs.newsFeeds) + prefs.newsKeywords.join();
    const cityBefore = prefs.weatherCity;
    settings = { ...settings, ...next };
    prefs = dashboardPrefs(settings);
    setLanguage(resolveLanguage(settings.language, systemLanguages()));
    if (JSON.stringify(prefs.newsFeeds) + prefs.newsKeywords.join() !== feedsBefore) void loadNews(true);
    if (prefs.weatherCity !== cityBefore) void loadWeather(true);
    renderAll();
  });
  void onEvent<MediaState>("media", (m) => {
    data.media = m;
    tiles.get("music")?.render();
    syncMood();
    if (!m.active) tintFromCover(null);
  });
  void onEvent<{ key: string; dataUrl: string }>("media-artwork", (a) => {
    data.art = a;
    tintFromCover(a.dataUrl);
    tiles.get("music")?.render();
  });
  void onEvent<FocusState>("focus", (f) => {
    data.focus = f;
    tiles.get("focus")?.render();
    syncMood();
  });
  void onEvent<unknown>("focus-end", () => engine.triggerEmote("proud", 1.6));
  void onEvent<ClaudeJob[]>("job", (jobs) => {
    data.jobs = jobs;
    tiles.get("jobs")?.render();
  });
  void onEvent<{ ok: boolean }>("job-done", (d) => engine.triggerEmote(d.ok ? "happy" : "annoyed", 1.6));
  // The island keeps the plan numbers; another window writing them reaches here.
  window.addEventListener("storage", (e) => e.key === "coucou.claudePlanUsage" && void loadClaude());
  document.addEventListener("visibilitychange", syncVisibility);
  window.addEventListener("keydown", (e) => {
    if (e.key === "F5") {
      e.preventDefault();
      void sampleSystem(true);
      void loadNews(true);
      void loadWeather(true);
    }
  });
  syncVisibility();
}

void main();


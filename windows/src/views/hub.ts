// The dashboard pills' cards in the island (overview, left card): System, Now
// Playing, Focus, News and Screen Time. Each is a small summary in the island's
// card style (int-card / int-head, src/views/integrations.ts); the card's ↗
// opens the full dashboard window. The card is kept and updated in place, like
// Spotify's, so a progress bar or a ring moves without being rebuilt.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import {
  FOCUS_ID, NEWS_ID, NOWPLAYING_ID, PHASE_COLOR, SCREENTIME_ID, SYSTEM_ID, appColor, appName, diskLow,
  focusLeft, focusProgress, formatClock, formatDuration, formatRate, level, mediaPosition,
  phaseLabel, ratio, tempLevel, topApps,
} from "../core/dashboard";
import { Hub, hubArtwork } from "../core/hub";
import { dashboardPrefs, State } from "../core/state";
import { pillDefinition } from "../core/pills";
import { ageMinutes } from "../news/news";
import { language, t } from "../i18n/i18n";

const LEVEL = { ok: "#22C55E", warn: "#F5A524", hot: "#F4505E" } as const;

export function isHubCard(id: string | undefined): boolean {
  return id === SYSTEM_ID || id === NOWPLAYING_ID || id === FOCUS_ID || id === NEWS_ID || id === SCREENTIME_ID;
}

function header(id: string, kind: string): HTMLElement {
  const def = pillDefinition(id);
  return h("div", { class: "int-head" }, dot(def?.color ?? "#9398A1", 7), h("b", { text: def?.name ?? "" }), h("span", { text: kind }));
}

/** A small ring for the System card. */
function miniRing(fraction: number, color: string, label: string, value: string): HTMLElement {
  const size = 40;
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, "svg");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("viewBox", `0 0 ${size} ${size}`);
  const circle = (cls: string, dash?: number) => {
    const ci = document.createElementNS(ns, "circle");
    ci.setAttribute("cx", String(size / 2));
    ci.setAttribute("cy", String(size / 2));
    ci.setAttribute("r", String(r));
    ci.setAttribute("stroke-width", String(stroke));
    ci.setAttribute("class", cls);
    if (dash != null) {
      ci.setAttribute("stroke-dasharray", String(c));
      ci.setAttribute("stroke-dashoffset", String(c * (1 - Math.min(1, Math.max(0, dash)))));
      ci.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
      ci.style.stroke = color;
    }
    return ci;
  };
  el.append(circle("hub-ring-track"), circle("hub-ring-arc", fraction));
  return h("div", { class: "hub-gauge" }, h("div", { class: "hub-ring" }, el, h("b", { text: value })), h("span", { text: label }));
}

function bar(fraction: number, color: string): HTMLElement {
  return h("div", { class: "hub-bar" }, h("i", { style: `width:${(Math.min(1, Math.max(0, fraction)) * 100).toFixed(1)}%;background:${color}` }));
}

// ── Cards ─────────────────────────────────────────────────────────────────────

function systemCard(): HTMLElement {
  const st = Hub.stats;
  const card = h("div", { class: "int-card hub-card" }, header(SYSTEM_ID, t("PC")));
  if (!st) {
    card.append(h("div", { class: "int-status", text: t("Loading…") }));
    return card;
  }
  const mem = ratio(st.memUsed, st.memTotal);
  const disk = ratio(st.diskTotal - st.diskFree, st.diskTotal);
  card.append(
    h("div", { class: "hub-gauges" },
      miniRing((st.cpu ?? 0) / 100, LEVEL[level((st.cpu ?? 0) / 100, 0.7, 0.9)], t("CPU"), st.cpu == null ? "–" : `${Math.round(st.cpu)}`),
      miniRing(mem, LEVEL[level(mem, 0.8, 0.92)], t("Memory"), `${Math.round(mem * 100)}`),
      miniRing(disk, LEVEL[diskLow(st) ? "hot" : level(disk, 0.8, 0.9)], st.disk, `${Math.round(disk * 100)}`),
      miniRing(st.tempC == null ? 0 : st.tempC / 100, LEVEL[tempLevel(st.tempC)], "°C", st.tempC == null ? "–" : `${Math.round(st.tempC)}`),
    ),
    h("div", { class: "hub-line" },
      h("span", { text: `↓ ${formatRate(st.netDown)}  ↑ ${formatRate(st.netUp)}` }),
      h("span", { text: t("Up {time}", { time: formatDuration(st.uptimeSecs) }) }),
    ),
  );
  return card;
}

function nowPlayingCard(): HTMLElement {
  const m = Hub.media;
  const card = h("div", { class: "int-card hub-card" }, header(NOWPLAYING_ID, m?.active ? m.source : t("Music")));
  if (!m?.active) {
    card.append(h("div", { class: "int-status", text: t("Nothing is playing") }));
    return card;
  }
  const art = hubArtwork();
  const btn = (path: string, label: string, enabled: boolean, onclick: () => void, main = false) =>
    h("button", { class: `hub-btn${main ? " main" : ""}`, title: label, "aria-label": label, disabled: !enabled, onclick }, svg(path, main ? 14 : 11));
  card.append(
    h("div", { class: "hub-music" },
      h("div", { class: "hub-cover" }, art ? h("img", { src: art, alt: "" }) : h("span", { text: "♪" })),
      h("div", { class: "hub-music-main" },
        h("div", { class: "hub-title", text: m.title || t("Unknown") }),
        h("div", { class: "hub-sub", text: m.artist }),
        h("div", { class: "hub-progress" }, h("i", { class: "hub-progress-fill" })),
        h("div", { class: "hub-controls" },
          btn(ICONS.backward, t("Previous"), m.canPrevious, () => void Bridge.mediaControl("previous")),
          btn(m.playing ? ICONS.pause : ICONS.play, m.playing ? t("Pause") : t("Play"), true, () => {
            if (Hub.media) Hub.media = { ...Hub.media, playing: !Hub.media.playing, position: mediaPosition(Hub.media, Date.now()), positionAt: Date.now() };
            State.notify();
            void Bridge.mediaControl("playPause");
          }, true),
          btn(ICONS.forward, t("Next"), m.canNext, () => void Bridge.mediaControl("next")),
        ),
      ),
    ),
  );
  return card;
}

function focusCard(): HTMLElement {
  const f = Hub.focus;
  const card = h("div", { class: "int-card hub-card" }, header(FOCUS_ID, f ? phaseLabel(f.phase) : t("Focus")));
  if (!f) return card;
  const cmd = (a: "start" | "pause" | "skip" | "reset") => () =>
    void Bridge.focusCommand(a).then((s) => {
      if (s) Hub.focus = s;
      State.notify();
    });
  const color = PHASE_COLOR[f.phase === "idle" ? "focus" : f.phase];
  card.append(
    h("div", { class: "hub-focus" },
      h("div", { class: "hub-focus-ring", style: `--phase:${color}` }, h("b", { class: "hub-focus-clock" })),
      h("div", { class: "hub-focus-side" },
        h("div", { class: "hub-sub", text: f.away ? t("Paused — you're away") : t("Round {n} of {total}", { n: Math.min(f.round + 1, f.rounds), total: f.rounds }) }),
        h("div", { class: "hub-controls" },
          f.running
            ? h("button", { class: "link-btn", style: `color:${color}`, text: t("Pause"), onclick: cmd("pause") })
            : h("button", { class: "link-btn", style: `color:${color}`, text: t("Start"), onclick: cmd("start") }),
          f.phase !== "idle" ? h("button", { class: "link-btn dim", text: t("Skip"), onclick: cmd("skip") }) : null,
          f.phase !== "idle" ? h("button", { class: "link-btn dim", text: t("Reset"), onclick: cmd("reset") }) : null,
        ),
        h("div", { class: "hub-sub", text: `${t("Today")} · ${f.todayMin < 60 ? t("{m} min", { m: f.todayMin }) : formatDuration(f.todayMin * 60)}` }),
      ),
    ),
  );
  return card;
}

function newsCard(): HTMLElement {
  const card = h("div", { class: "int-card hub-card" }, header(NEWS_ID, t("Headlines")));
  if (Hub.news.length === 0) {
    card.append(h("div", { class: "int-status", text: dashboardPrefs(State.settings).newsFeeds.length ? t("Loading…") : t("Add RSS feeds in Settings → Dashboard.") }));
    return card;
  }
  const rows = h("div", { class: "int-rows tight" });
  for (const n of Hub.news.slice(0, 3)) {
    const age = ageMinutes(n.at, Date.now());
    rows.append(
      h("button", { class: `hub-headline${n.urgent ? " urgent" : ""}`, onclick: () => n.link && void Bridge.openUrl(n.link) },
        dot(n.urgent ? "#F4505E" : "#9398A1", 5),
        h("span", { class: "hub-headline-title", text: n.title }),
        age >= 0 ? h("span", { class: "int-ago", text: age < 60 ? `${Math.max(1, age)}m` : `${Math.round(age / 60)}h` }) : null,
      ),
    );
  }
  card.append(rows);
  return card;
}

function screenCard(): HTMLElement {
  const prefs = dashboardPrefs(State.settings);
  const st = Hub.screen;
  const today = st?.days[st.today];
  const card = h("div", { class: "int-card hub-card" }, header(SCREENTIME_ID, today ? formatDuration(today.active) : t("Today")));
  if (!prefs.screenTime) {
    card.append(h("div", { class: "int-status", text: t("Off — turn it on in Settings → Dashboard.") }));
    return card;
  }
  const top = topApps(today, 3);
  const peak = top[0]?.[1] ?? 1;
  const rows = h("div", { class: "hub-apps" });
  for (const [app, secs] of top) {
    rows.append(h("div", { class: "hub-app" }, h("span", { text: appName(app) }), bar(secs / peak, appColor(app)), h("b", { text: formatDuration(secs) })));
  }
  card.append(rows, h("div", { class: "hub-line" }, h("span", { text: `${t("Last used")}: ${st?.previous ? appName(st.previous) : "–"}` })));
  return card;
}

// ── The card the overview keeps ───────────────────────────────────────────────

export interface HubCardHost {
  el: HTMLElement;
  /** Draws the card for `id` when what it shows changed; moves the clocks always. */
  sync(id: string): void;
}

export function buildHubCard(): HubCardHost {
  const el = h("div", { class: "hub-host" });
  let key = "";

  const tick = (id: string) => {
    const now = Date.now();
    if (id === NOWPLAYING_ID && Hub.media?.active) {
      const fill = el.querySelector(".hub-progress-fill") as HTMLElement | null;
      const m = Hub.media;
      const p = mediaPosition(m, now);
      if (fill) fill.style.width = m.duration > 0 ? `${(p / m.duration) * 100}%` : "100%";
    }
    if (id === FOCUS_ID && Hub.focus) {
      const f = Hub.focus;
      const clock = el.querySelector(".hub-focus-clock") as HTMLElement | null;
      const ring = el.querySelector(".hub-focus-ring") as HTMLElement | null;
      const prefs = dashboardPrefs(State.settings);
      if (clock) clock.textContent = formatClock(f.phase === "idle" ? prefs.focus.focusMin * 60_000 : focusLeft(f, now));
      if (ring) ring.style.setProperty("--p", String(focusProgress(f, now)));
    }
  };

  return {
    el,
    sync(id: string) {
      const k = JSON.stringify([id, language(), (() => {
        switch (id) {
          case SYSTEM_ID: return Hub.stats && { ...Hub.stats, apps: null };
          case NOWPLAYING_ID: return [Hub.media && { ...Hub.media, position: 0, positionAt: 0 }, hubArtwork() != null];
          case FOCUS_ID: return Hub.focus && { ...Hub.focus, leftMs: 0, endsAt: 0 };
          case NEWS_ID: return Hub.news.slice(0, 3).map((n) => [n.title, n.urgent]);
          case SCREENTIME_ID: return [Hub.screen, dashboardPrefs(State.settings).screenTime];
          default: return null;
        }
      })()]);
      if (k !== key) {
        key = k;
        clear(el);
        switch (id) {
          case SYSTEM_ID: el.append(systemCard()); break;
          case NOWPLAYING_ID: el.append(nowPlayingCard()); break;
          case FOCUS_ID: el.append(focusCard()); break;
          case NEWS_ID: el.append(newsCard()); break;
          case SCREENTIME_ID: el.append(screenCard()); break;
        }
      }
      tick(id);
    },
  };
}

// The dashboard inside the island (the header's grid tab, view "dashboard"):
// every tile of the dashboard window, made small enough for the island — music,
// focus, Claude, CPU, memory, the system drive, network, uptime, screen time,
// news and weather — with Mochi in the left rail. ↗ opens the full window.
//
// It reads only while it is on screen (src/island/hub.ts); the clocks move
// every second then, and nothing runs once it closes.

import { h, svg, dot } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import {
  PHASE_COLOR, appName, diskLow, focusLeft, focusProgress, formatBytes, formatClock, formatDuration, formatRate,
  level, mediaPosition, phaseLabel, ratio, tempLevel, topApps, weatherInfo,
} from "../core/dashboard";
import { Hub, hubArtwork } from "../core/hub";
import { State, dashboardPrefs } from "../core/state";
import { ageMinutes } from "../news/news";
import { compactNumber, dailyTotals } from "../usage/usage";
import { language, t, tl } from "../i18n/i18n";
import type { ViewHost } from "./views";

const LEVEL = { ok: "#22C55E", warn: "#F5A524", hot: "#F4505E" } as const;
const NS = "http://www.w3.org/2000/svg";

function ring(fraction: number, color: string, size = 38, stroke = 4): SVGSVGElement {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("viewBox", `0 0 ${size} ${size}`);
  const circle = (cls: string, arc: boolean) => {
    const ci = document.createElementNS(NS, "circle");
    for (const [k, v] of Object.entries({ cx: size / 2, cy: size / 2, r, "stroke-width": stroke, class: cls })) ci.setAttribute(k, String(v));
    if (arc) {
      ci.setAttribute("stroke-dasharray", String(c));
      ci.setAttribute("stroke-dashoffset", String(c * (1 - Math.min(1, Math.max(0, fraction)))));
      ci.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
      ci.style.stroke = color;
    }
    return ci;
  };
  el.append(circle("hub-ring-track", false), circle("hub-ring-arc", true));
  return el;
}

function tile(cls: string, label: string, ...children: (Node | null)[]): HTMLElement {
  return h("div", { class: `idash-tile ${cls}` }, h("div", { class: "idash-label", text: label }), ...children);
}

function gauge(cls: string, label: string, fraction: number, color: string, value: string, lines: string[]): HTMLElement {
  return tile(cls, label,
    h("div", { class: "idash-gauge" },
      h("div", { class: "hub-ring" }, ring(fraction, color), h("b", { text: value })),
      h("div", { class: "idash-lines" }, ...lines.map((l) => h("span", { text: l }))),
    ),
  );
}

// ── Tiles ─────────────────────────────────────────────────────────────────────

function musicTile(): HTMLElement {
  const m = Hub.media;
  if (!m?.active) return tile("wide music", t("Now playing"), h("div", { class: "idash-empty", text: t("Nothing is playing") }));
  const art = hubArtwork();
  const btn = (path: string, label: string, enabled: boolean, onclick: () => void, main = false) =>
    h("button", { class: `hub-btn${main ? " main" : ""}`, title: label, "aria-label": label, disabled: !enabled, onclick }, svg(path, main ? 13 : 10));
  return tile("wide music", m.source || t("Now playing"),
    h("div", { class: "idash-music" },
      h("div", { class: "idash-cover" }, art ? h("img", { src: art, alt: "" }) : h("span", { text: "♪" })),
      h("div", { class: "idash-music-main" },
        h("div", { class: "hub-title", text: m.title || t("Unknown") }),
        h("div", { class: "hub-sub", text: m.artist }),
        h("div", { class: "hub-progress" }, h("i", { class: "idash-progress" })),
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
}

function focusTile(): HTMLElement {
  const f = Hub.focus;
  const color = PHASE_COLOR[!f || f.phase === "idle" ? "focus" : f.phase];
  const cmd = (a: "start" | "pause" | "skip") => () =>
    void Bridge.focusCommand(a).then((s) => {
      if (s) Hub.focus = s;
      State.notify();
    });
  return tile("focus", f ? phaseLabel(f.phase) : t("Focus"),
    h("div", { class: "idash-focus" },
      h("div", { class: "hub-focus-ring idash-focus-ring", style: `--phase:${color}` }, h("b", { class: "idash-focus-clock" })),
      h("div", { class: "idash-focus-btns" },
        f?.running
          ? h("button", { class: "hub-btn main", title: t("Pause"), "aria-label": t("Pause"), onclick: cmd("pause") }, svg(ICONS.pause, 11))
          : h("button", { class: "hub-btn main", title: t("Start"), "aria-label": t("Start"), onclick: cmd("start") }, svg(ICONS.play, 11)),
        f && f.phase !== "idle" ? h("button", { class: "hub-btn", title: t("Skip"), "aria-label": t("Skip"), onclick: cmd("skip") }, svg(ICONS.forward, 9)) : null,
      ),
    ),
  );
}

function claudeTile(): HTMLElement {
  const plan = State.planUsage;
  const rows: HTMLElement[] = [];
  const row = (label: string, pct: number | undefined) => {
    if (pct == null) return;
    rows.push(h("div", { class: "idash-limit" },
      h("span", { text: label }), h("b", { text: `${Math.round(pct)}%` }),
      h("div", { class: "hub-bar" }, h("i", { style: `width:${Math.min(100, pct)}%;background:${LEVEL[level(pct / 100, 0.7, 0.9)]}` })),
    ));
  };
  row(t("5 hours"), plan?.fiveHour?.usedPct);
  row(t("Week"), plan?.sevenDay?.usedPct);
  if (Hub.claude) {
    const days = dailyTotals(Hub.claude, new Date(), 1);
    rows.push(h("div", { class: "idash-limit" }, h("span", { text: t("Today") }), h("b", { text: compactNumber(days[0]?.tokens ?? 0) })));
  }
  return tile("claude", t("Claude usage"), ...(rows.length ? rows : [h("div", { class: "idash-empty", text: t("No usage yet") })]));
}

function cpuTile(): HTMLElement {
  const st = Hub.stats;
  const f = (st?.cpu ?? 0) / 100;
  const tl = tempLevel(st?.tempC ?? null);
  const color = LEVEL[tl === "hot" ? "hot" : level(f, 0.7, 0.9) === "ok" && tl === "ok" ? "ok" : level(f, 0.7, 0.9) === "hot" ? "hot" : "warn"];
  return gauge("cpu", t("CPU"), f, color, st?.cpu == null ? "–" : `${Math.round(st.cpu)}`, [
    st?.tempC == null ? "– °C" : `${Math.round(st.tempC)} °C`,
    st ? t("Up {time}", { time: formatDuration(st.uptimeSecs) }) : "",
  ]);
}

function memoryTile(): HTMLElement {
  const st = Hub.stats;
  const f = st ? ratio(st.memUsed, st.memTotal) : 0;
  const top = st?.apps?.[0];
  return gauge("mem", t("Memory"), f, LEVEL[level(f, 0.8, 0.92)], `${Math.round(f * 100)}`, [
    st ? `${formatBytes(st.memUsed).replace(/ GB$/, "")} / ${formatBytes(st.memTotal)}` : "",
    top ? `${appName(top.name)} ${formatBytes(top.mem)}` : "",
  ]);
}

function diskTile(): HTMLElement {
  const st = Hub.stats;
  const f = st ? ratio(st.diskTotal - st.diskFree, st.diskTotal) : 0;
  const low = st ? diskLow(st) : false;
  return gauge("disk", st?.disk ?? "C:", f, LEVEL[low ? "hot" : level(f, 0.8, 0.9)], `${Math.round(f * 100)}`, [
    st ? t("{size} free", { size: formatBytes(st.diskFree) }) : "",
    st ? formatBytes(st.diskTotal) : "",
  ]);
}

function networkTile(speed: { running: boolean; result: string }, runSpeed: () => void): HTMLElement {
  const st = Hub.stats;
  return tile("net", t("Network"),
    h("div", { class: "idash-net" },
      h("span", {}, h("i", { class: "down", text: "↓" }), formatRate(st?.netDown ?? null)),
      h("span", {}, h("i", { class: "up", text: "↑" }), formatRate(st?.netUp ?? null)),
    ),
    h("button", { class: "idash-link", disabled: speed.running, onclick: runSpeed, text: speed.running ? t("Testing…") : speed.result || t("Speed test") }),
  );
}

function screenTile(): HTMLElement {
  if (!dashboardPrefs(State.settings).screenTime) {
    return tile("screen", t("Screen time"), h("div", { class: "idash-empty", text: t("Off — turn it on in Settings → Dashboard.") }));
  }
  const st = Hub.screen;
  const today = st?.days[st.today];
  const top = topApps(today, 2);
  return tile("screen", t("Screen time"),
    h("b", { class: "idash-big", text: formatDuration(today?.active ?? 0) }),
    ...top.map(([app, secs]) => h("div", { class: "idash-row" }, h("span", { text: appName(app) }), h("b", { text: formatDuration(secs) }))),
    st?.previous ? h("div", { class: "idash-row dim" }, h("span", { text: t("Last used") }), h("b", { text: appName(st.previous) })) : null,
  );
}

function newsTile(): HTMLElement {
  const list = Hub.news.slice(0, 3);
  return tile("wide news", t("News"),
    ...(list.length
      ? list.map((n) => {
        const age = ageMinutes(n.at, Date.now());
        return h("button", { class: `hub-headline${n.urgent ? " urgent" : ""}`, onclick: () => n.link && void Bridge.openUrl(n.link) },
          dot(n.urgent ? "#F4505E" : "#9398A1", 5),
          h("span", { class: "hub-headline-title", text: n.title }),
          age >= 0 ? h("span", { class: "int-ago", text: age < 60 ? `${Math.max(1, age)}m` : `${Math.round(age / 60)}h` }) : null);
      })
      : [h("div", { class: "idash-empty", text: dashboardPrefs(State.settings).newsFeeds.length ? t("Loading…") : t("Add RSS feeds in Settings → Dashboard.") })]),
  );
}

function weatherTile(): HTMLElement {
  const w = Hub.weather;
  if (!w) {
    const city = dashboardPrefs(State.settings).weatherCity;
    return tile("weather", t("Weather"), h("div", { class: "idash-empty", text: city ? t("Loading…") : t("Your city") }));
  }
  const now = weatherInfo(w.current.weather_code, w.current.is_day === 1);
  return tile("weather", w.place,
    h("div", { class: "idash-weather" }, h("span", { class: "idash-weather-icon", text: now.icon }), h("b", { class: "idash-big", text: `${Math.round(w.current.temperature_2m)}°` })),
    h("div", { class: "idash-row dim" }, h("span", { text: t(now.label) }),
      h("b", { text: `${Math.round(w.daily.temperature_2m_max[0])}° / ${Math.round(w.daily.temperature_2m_min[0])}°` })),
  );
}

// ── The view ──────────────────────────────────────────────────────────────────

export function buildIslandDashboard(): ViewHost {
  const clock = h("div", { class: "idash-time" });
  const date = h("div", { class: "idash-date" });
  const open = h("button", { class: "idash-open", title: tl("Open dashboard"), onclick: () => void Bridge.openDashboard() },
    svg(ICONS.arrowUpRight, 9), h("span", { text: tl("Open dashboard") }));
  const rail = h("div", { class: "idash-rail" }, h("div", { class: "idash-mochi-spot" }), clock, date, open);
  const grid = h("div", { class: "idash-grid" });
  const el = h("div", { class: "view idash" }, rail, grid);

  const speed = { running: false, result: "" };
  const runSpeed = () => {
    speed.running = true;
    State.notify();
    void Bridge.speedTest().then((r) => {
      speed.running = false;
      speed.result = r ? `↓ ${r.downMbps} · ↑ ${r.upMbps} Mbps` : t("The test didn't finish.");
      State.notify();
    });
  };

  // Each tile is redrawn only when what it shows changed, so the grid never
  // flashes; the tiles slide in only when the tab opens.
  const shown: { key: string; el: HTMLElement }[] = [];
  let wasOpen = false;
  const round = (n: number | null | undefined, step = 1) => (n == null ? null : Math.round(n / step));
  const tiles: [() => unknown, () => HTMLElement][] = [
    [() => [Hub.media && { ...Hub.media, position: 0, positionAt: 0 }, hubArtwork() != null], musicTile],
    [() => Hub.focus && { ...Hub.focus, leftMs: 0, endsAt: 0 }, focusTile],
    [() => [State.planUsage?.fiveHour?.usedPct, State.planUsage?.sevenDay?.usedPct, Hub.claude?.hours.length], claudeTile],
    [() => [round(Hub.stats?.cpu), round(Hub.stats?.tempC), round(Hub.stats?.uptimeSecs, 60)], cpuTile],
    [() => [round(Hub.stats?.memUsed, 2 ** 26), Hub.stats?.memTotal, Hub.stats?.apps?.[0]?.name, round(Hub.stats?.apps?.[0]?.mem, 2 ** 26)], memoryTile],
    [() => [round(Hub.stats?.diskFree, 2 ** 27), Hub.stats?.diskTotal], diskTile],
    [() => [round(Hub.stats?.netDown, 256), round(Hub.stats?.netUp, 256), speed.running, speed.result], () => networkTile(speed, runSpeed)],
    [() => Hub.news.slice(0, 3).map((n) => [n.title, n.urgent]), newsTile],
    [() => [Hub.screen, dashboardPrefs(State.settings).screenTime], screenTile],
    [() => [Hub.weather?.current, Hub.weather?.place, dashboardPrefs(State.settings).weatherCity], weatherTile],
  ];
  const tick = () => {
    const now = Date.now();
    const d = new Date(now);
    clock.textContent = d.toLocaleTimeString(language(), { hour: "2-digit", minute: "2-digit" });
    date.textContent = d.toLocaleDateString(language(), { weekday: "short", day: "numeric", month: "short" });
    const m = Hub.media;
    const fill = grid.querySelector(".idash-progress") as HTMLElement | null;
    if (fill && m?.active) fill.style.width = m.duration > 0 ? `${(mediaPosition(m, now) / m.duration) * 100}%` : "100%";
    const f = Hub.focus;
    const fc = grid.querySelector(".idash-focus-clock") as HTMLElement | null;
    const fr = grid.querySelector(".idash-focus-ring") as HTMLElement | null;
    if (fc) fc.textContent = formatClock(!f || f.phase === "idle" ? dashboardPrefs(State.settings).focus.focusMin * 60_000 : focusLeft(f, now));
    if (fr && f) fr.style.setProperty("--p", String(focusProgress(f, now)));
  };

  return {
    el,
    sync() {
      const open = State.view === "dashboard" && State.mode === "expanded";
      if (open && !wasOpen) {
        grid.classList.add("entering");
        window.setTimeout(() => grid.classList.remove("entering"), 700);
      }
      wasOpen = open;
      if (State.view !== "dashboard") return;
      const lang = language();
      tiles.forEach(([keyOf, build], i) => {
        const key = JSON.stringify([lang, keyOf()]);
        if (shown[i]?.key === key) return;
        const el = build();
        el.style.setProperty("--i", String(i));
        if (shown[i]) shown[i].el.replaceWith(el);
        else grid.append(el);
        shown[i] = { key, el };
      });
      tick();
    },
  };
}

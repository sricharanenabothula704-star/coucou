// The chat and the PC: the snapshot of what the dashboard reads that goes with
// a message (Settings → Dashboard → "Let the chat see my PC"), and the
// `[[coucou: …]]` lines an answer may end with to act on it (chat.rs tells the
// model which). Pure: tests/pc-context.test.mjs runs it as it is.

import {
  appName, formatBytes, formatDuration, formatRate, phaseLabel, topApps,
  type FocusState, type MediaState, type ScreenTime, type SystemStats, type Weather,
} from "./dashboard";
import type { Headline } from "../news/news";
import type { PlanUsage } from "./plan";

export interface ClaudeJob {
  id: string;
  prompt: string;
  folder: string;
  at: string;
  date: string;
  repeat: "once" | "daily" | "weekdays";
  enabled: boolean;
  autoEdit: boolean;
  lastSlot: string;
  lastRun: number | null;
  lastOk: boolean | null;
  lastOutput: string;
  running: boolean;
}

export interface PcSnapshot {
  now: Date;
  stats: SystemStats | null;
  media: MediaState | null;
  focus: FocusState | null;
  screen: ScreenTime | null;
  news: Headline[];
  weather: Weather | null;
  plan: PlanUsage | null;
  jobs: ClaudeJob[];
}

/** Plain lines, short enough for any model's system prompt. */
export function pcNote(s: PcSnapshot): string {
  const lines: string[] = [];
  lines.push(`Local time: ${s.now.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}`);
  const st = s.stats;
  if (st) {
    lines.push(
      `CPU ${st.cpu == null ? "?" : Math.round(st.cpu)}% on ${st.cores} cores` +
        (st.tempC == null ? "" : `, ${Math.round(st.tempC)} °C`) +
        `; memory ${formatBytes(st.memUsed)} of ${formatBytes(st.memTotal)} used` +
        `; ${st.disk} ${formatBytes(st.diskFree)} free of ${formatBytes(st.diskTotal)}` +
        `; network ↓ ${formatRate(st.netDown)} ↑ ${formatRate(st.netUp)}` +
        `; on for ${formatDuration(st.uptimeSecs)}` +
        (st.battery ? `; battery ${st.battery.percent}%${st.battery.charging ? " charging" : ""}` : ""),
    );
    if (st.apps?.length) {
      lines.push(
        "Apps by memory: " +
          st.apps.slice(0, 10).map((a) => `${appName(a.name)} (${a.name}) ${formatBytes(a.mem)}${a.windowed ? "" : " background"}`).join(", "),
      );
    }
  }
  const m = s.media;
  if (m?.active) {
    lines.push(`Music: ${m.playing ? "playing" : "paused"} "${m.title}"${m.artist ? ` by ${m.artist}` : ""} in ${m.source}; volume ${m.volume}%${m.muted ? " (muted)" : ""}`);
  } else if (m) {
    lines.push("Music: nothing playing");
  }
  const f = s.focus;
  if (f) {
    const left = f.running ? Math.max(0, f.endsAt - s.now.getTime()) : f.leftMs;
    lines.push(
      `Focus timer: ${f.phase === "idle" ? "not started" : `${phaseLabel(f.phase)} ${f.running ? "running" : f.away ? "paused (user away)" : "paused"}, ${formatDuration(left / 1000)} left`}` +
        `; today ${f.todayRounds} rounds, ${f.todayMin} min focused`,
    );
  }
  const sc = s.screen;
  if (sc?.tracking) {
    const today = sc.days[sc.today];
    lines.push(
      `Screen time today: ${formatDuration(today?.active ?? 0)}` +
        (today ? ` — ${topApps(today, 6).map(([a, secs]) => `${appName(a)} ${formatDuration(secs)}`).join(", ")}` : "") +
        (sc.current ? `; in front now: ${appName(sc.current)}` : "") +
        (sc.previous ? `; before that: ${appName(sc.previous)}` : ""),
    );
  }
  if (s.plan?.fiveHour || s.plan?.sevenDay) {
    lines.push(
      `Claude plan usage: ${s.plan.fiveHour ? `${Math.round(s.plan.fiveHour.usedPct)}% of the 5-hour limit` : ""}` +
        `${s.plan.fiveHour && s.plan.sevenDay ? ", " : ""}${s.plan.sevenDay ? `${Math.round(s.plan.sevenDay.usedPct)}% of the weekly limit` : ""}`,
    );
  }
  if (s.weather) {
    lines.push(`Weather in ${s.weather.place}: ${Math.round(s.weather.current.temperature_2m)}°C, feels like ${Math.round(s.weather.current.apparent_temperature)}°C`);
  }
  if (s.news.length) {
    lines.push("Headlines: " + s.news.slice(0, 6).map((n) => `${n.urgent ? "[BREAKING] " : ""}${n.title} (${n.source})`).join(" | "));
  }
  if (s.jobs.length) {
    lines.push(
      "Claude Code jobs: " +
        s.jobs.slice(0, 8).map((j) =>
          `"${j.prompt.slice(0, 80)}" in ${j.folder || "home"} ${j.running ? "running now" : j.enabled ? `at ${j.at} ${j.repeat}` : "off"}` +
          (j.lastOk == null ? "" : j.lastOk ? " (last run ok)" : " (last run failed)")).join("; "),
    );
  }
  return lines.join("\n");
}

// ── Actions ───────────────────────────────────────────────────────────────────

export type PcAction =
  | { kind: "media"; action: "playPause" | "next" | "previous" }
  | { kind: "volume"; value: number }
  | { kind: "focus"; action: "start" | "pause" | "skip" | "reset" }
  | { kind: "dashboard" }
  | { kind: "speedtest" }
  | { kind: "claude"; when: "now" | { at: string; repeat: "once" | "daily" | "weekdays" }; folder: string; prompt: string };

const LINE = /\[\[\s*coucou\s*:\s*([^\]]+?)\s*\]\]/gi;

function parseOne(body: string): PcAction | null {
  const words = body.trim().split(/\s+/);
  const verb = words[0]?.toLowerCase();
  if (verb === "media") {
    const a = words[1]?.toLowerCase();
    if (a === "playpause" || a === "play" || a === "pause") return { kind: "media", action: "playPause" };
    if (a === "next" || a === "previous") return { kind: "media", action: a };
    if (a === "volume") {
      const v = Number(words[2]);
      return Number.isFinite(v) ? { kind: "volume", value: Math.max(0, Math.min(100, Math.round(v))) } : null;
    }
    return null;
  }
  if (verb === "focus") {
    const a = words[1]?.toLowerCase();
    return a === "start" || a === "pause" || a === "skip" || a === "reset" ? { kind: "focus", action: a } : null;
  }
  if (verb === "dashboard") return { kind: "dashboard" };
  if (verb === "speedtest") return { kind: "speedtest" };
  if (verb === "claude") {
    const parts = body.trim().slice("claude".length).split("|").map((p) => p.trim());
    if (parts.length < 3) return null;
    const [when, folder, ...rest] = parts;
    const prompt = rest.join(" | ").trim();
    if (!prompt) return null;
    if (/^now$/i.test(when)) return { kind: "claude", when: "now", folder, prompt };
    const m = when.match(/^at\s+(\d{1,2}):(\d{2})(?:\s+(once|daily|weekdays))?$/i);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    const at = `${m[1].padStart(2, "0")}:${m[2]}`;
    return { kind: "claude", when: { at, repeat: (m[3]?.toLowerCase() ?? "once") as "once" | "daily" | "weekdays" }, folder, prompt };
  }
  return null;
}

/** The answer without its action lines, and the actions it asked for. */
export function readActions(reply: string): { text: string; actions: PcAction[] } {
  const actions: PcAction[] = [];
  const text = reply.replace(LINE, (_m, body: string) => {
    const a = parseOne(body);
    if (a) actions.push(a);
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { text, actions };
}

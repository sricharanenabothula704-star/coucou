// The chat and the PC, on the island's side: before a message goes, a fresh
// look at the PC for the model (Settings → Dashboard → "Let the chat see my
// PC"); after the answer, the `[[coucou: …]]` actions it asked for. Music,
// focus, the dashboard and the speed test run at once; a Claude Code job
// waits for a click in the chat (see views/chat.ts).

import { Bridge } from "../core/bridge";
import { Hub } from "../core/hub";
import { State, dashboardPrefs } from "../core/state";
import { pcNote, type ClaudeJob, type PcAction } from "../core/pc-context";
import { t } from "../i18n/i18n";

/** Waits for `p`, or gives up after `ms` with what the island already has. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => window.setTimeout(() => r(null), ms))]);
}

/** Tells Rust what goes in the chat's system prompt for the next message. */
export async function sharePcWithChat(): Promise<void> {
  const prefs = dashboardPrefs(State.settings);
  if (!prefs.shareWithChat) {
    await Bridge.chatSetPcContext("", prefs.letChatAct);
    return;
  }
  const [stats, screen, media, focus, jobs] = await Promise.all([
    within(Bridge.systemStats(true), 1500),
    prefs.screenTime ? within(Bridge.screenTime(), 800) : Promise.resolve(null),
    within(Bridge.mediaRefresh(), 800),
    within(Bridge.focusGet(), 500),
    within(Bridge.jobsList(), 500),
  ]);
  if (stats) Hub.stats = stats;
  if (screen) Hub.screen = screen;
  if (media) Hub.media = media;
  if (focus) Hub.focus = focus;
  const note = pcNote({
    now: new Date(),
    stats: Hub.stats,
    media: Hub.media,
    focus: Hub.focus,
    screen: Hub.screen,
    news: Hub.news,
    weather: Hub.weather,
    plan: State.planUsage ?? null,
    jobs: (jobs?.jobs ?? []) as ClaudeJob[],
  });
  await Bridge.chatSetPcContext(note, prefs.letChatAct);
}

/** Runs one of the quick actions; returns what to say it did. */
export async function runQuickAction(a: PcAction): Promise<string | null> {
  if (!dashboardPrefs(State.settings).letChatAct) return null;
  switch (a.kind) {
    case "media":
      await Bridge.mediaControl(a.action);
      return a.action === "next" ? t("Next track") : a.action === "previous" ? t("Previous track") : t("Play / pause");
    case "volume":
      await Bridge.mediaControl("volume", a.value);
      return t("Volume {0}%", { 0: a.value });
    case "focus": {
      const s = await Bridge.focusCommand(a.action);
      if (s) Hub.focus = s;
      State.notify();
      return a.action === "start" ? t("Focus started") : a.action === "pause" ? t("Focus paused") : a.action === "skip" ? t("Skipped") : t("Reset");
    }
    case "dashboard":
      await Bridge.openDashboard();
      return t("Dashboard opened");
    case "speedtest": {
      const r = await Bridge.speedTest();
      return r ? `↓ ${r.downMbps} · ↑ ${r.upMbps} Mbps · ${Math.round(r.pingMs)} ms` : t("The test didn't finish.");
    }
    case "claude":
      return null; // waits for a click
  }
}

/** A Claude Code job the chat proposed, once the user said yes. */
export async function confirmClaudeJob(a: Extract<PcAction, { kind: "claude" }>): Promise<boolean> {
  if (a.when === "now") return (await Bridge.claudePrompt(a.prompt, a.folder, false)) != null;
  const job = await Bridge.jobSave({
    id: "", prompt: a.prompt, folder: a.folder, at: a.when.at, date: "", repeat: a.when.repeat,
    enabled: true, autoEdit: false,
  });
  return job != null;
}

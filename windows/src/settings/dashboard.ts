// Settings → Dashboard: the dashboard window and its pills (System, Now
// Playing, Focus, News, Screen Time). Everything here is stored under
// `dashboard` in settings.json (src-tauri/src/dashboard/mod.rs).

import { Bridge } from "../core/bridge";
import { DEFAULT_DASHBOARD, type DashboardPrefs, type FocusPrefs } from "../core/dashboard";
import { dashboardPrefs, type Settings } from "../core/state";
import { h } from "../views/dom";
import { t } from "../i18n/i18n";

type Toggle = (on: boolean, onChange: (v: boolean) => void) => HTMLElement;

export function dashboardSection(
  current: () => Settings,
  change: (prefs: DashboardPrefs) => void,
  toggle: Toggle,
): HTMLElement {
  const prefs = () => dashboardPrefs(current());
  const set = (patch: Partial<DashboardPrefs>) => change({ ...prefs(), ...patch });
  const setFocus = (patch: Partial<FocusPrefs>) => set({ focus: { ...prefs().focus, ...patch } });

  const p = prefs();

  const number = (value: number, min: number, max: number, apply: (v: number) => void) => {
    const input = h("input", { type: "number", min: String(min), max: String(max), step: "1", value: String(value), style: "width:64px" }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const v = Math.max(min, Math.min(max, Math.round(Number(input.value) || value)));
      input.value = String(v);
      apply(v);
    });
    return input;
  };

  const text = (value: string, placeholder: string, apply: (v: string) => void, width = "220px") => {
    const input = h("input", { type: "text", value, placeholder, style: `width:${width}` }) as HTMLInputElement;
    input.addEventListener("change", () => apply(input.value.trim()));
    return input;
  };

  const feeds = h("textarea", { rows: "4", spellcheck: "false", style: "width:100%;font:12px var(--mono, monospace)" }) as HTMLTextAreaElement;
  feeds.value = p.newsFeeds.join("\n");
  feeds.addEventListener("change", () => {
    const list = feeds.value.split(/\s+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
    feeds.value = list.join("\n");
    set({ newsFeeds: list });
  });

  const keywords = text(p.newsKeywords.join(", "), "breaking, earthquake", (v) =>
    set({ newsKeywords: v.split(",").map((k) => k.trim()).filter(Boolean) }), "100%");

  const clearButton = h("button", { text: t("Clear history") });
  clearButton.addEventListener("click", () => {
    void Bridge.screenTimeClear();
    clearButton.disabled = true;
  });

  return h("section", {},
    h("h2", {}, h("span", { text: t("Dashboard") })),
    h("div", { style: "display:flex;flex-direction:column;gap:12px" },
      h("div", { class: "hint", text: t("Your PC, music, focus timer, screen time, news and weather in one window. It reads nothing while it is closed.") }),
      h("div", { class: "row" }, h("button", { text: t("Open dashboard"), onclick: () => void Bridge.openDashboard() })),

      h("h3", { class: "sub", text: t("Chat") }),
      h("div", { class: "hint", text: t("With each message, the chat gets what this dashboard reads right now: CPU, memory, apps, music, focus, screen time, headlines and Claude jobs. It goes to the AI you chat with.") }),
      h("div", { class: "row" }, h("label", { text: t("Let the chat see my PC") }), toggle(p.shareWithChat, (on) => set({ shareWithChat: on }))),
      h("div", { class: "row" }, h("label", { text: t("Let the chat play music, run the focus timer and propose Claude Code jobs") }), toggle(p.letChatAct, (on) => set({ letChatAct: on }))),

      h("h3", { class: "sub", text: t("Screen time") }),
      h("div", { class: "hint", text: t("Notes which app is in front every 5 seconds. Only app names and times are kept, on this PC, for 30 days.") }),
      h("div", { class: "row" }, h("label", { text: t("Track screen time") }), toggle(p.screenTime, (on) => set({ screenTime: on })), clearButton),

      h("h3", { class: "sub", text: t("Focus") }),
      h("div", { class: "row" },
        h("label", { text: t("Focus (min)") }), number(p.focus.focusMin, 1, 180, (v) => setFocus({ focusMin: v })),
        h("label", { text: t("Short break") }), number(p.focus.shortMin, 1, 60, (v) => setFocus({ shortMin: v })),
        h("label", { text: t("Long break") }), number(p.focus.longMin, 1, 120, (v) => setFocus({ longMin: v })),
        h("label", { text: t("Rounds") }), number(p.focus.rounds, 1, 12, (v) => setFocus({ rounds: v })),
      ),
      h("div", { class: "row" }, h("label", { text: t("Start the next phase by itself") }), toggle(p.focus.autoAdvance, (on) => setFocus({ autoAdvance: on }))),
      h("div", { class: "row" }, h("label", { text: t("Start focusing when an agent starts working") }), toggle(p.focus.autoStart, (on) => setFocus({ autoStart: on }))),
      h("div", { class: "row" }, h("label", { text: t("Pause while I'm away") }), toggle(p.focus.idlePause, (on) => setFocus({ idlePause: on }))),

      h("h3", { class: "sub", text: t("News") }),
      h("div", { class: "hint", text: t("RSS or Atom feeds, one per line. Read every 10 minutes while the News pill or the dashboard is on.") }),
      feeds,
      h("div", { class: "hint", text: t("A headline with one of these words, less than an hour old, is breaking news (end a word with * to match its start):") }),
      keywords,
      h("div", { class: "row" }, h("label", { text: t("Open the island for breaking news") }), toggle(p.newsAlerts, (on) => set({ newsAlerts: on }))),
      h("div", { class: "row" },
        h("button", { text: t("Reset to defaults"), onclick: () => {
          feeds.value = DEFAULT_DASHBOARD.newsFeeds.join("\n");
          keywords.value = DEFAULT_DASHBOARD.newsKeywords.join(", ");
          set({ newsFeeds: DEFAULT_DASHBOARD.newsFeeds, newsKeywords: DEFAULT_DASHBOARD.newsKeywords });
        } }),
      ),

      h("h3", { class: "sub", text: t("Weather") }),
      h("div", { class: "row" }, h("label", { text: t("City") }), text(p.weatherCity, "Hyderabad", (v) => set({ weatherCity: v }))),
      h("div", { class: "hint", text: t("From Open-Meteo for this city, only when you ask.") }),

      h("h3", { class: "sub", text: t("PC") }),
      h("div", { class: "row" }, h("label", { text: t("Warn me when memory, storage or temperature run high") }), toggle(p.systemAlerts, (on) => set({ systemAlerts: on }))),
      h("div", { class: "row" }, h("label", { text: t("Speed test server") }), text(p.speedTestUrl, DEFAULT_DASHBOARD.speedTestUrl, (v) => set({ speedTestUrl: v || DEFAULT_DASHBOARD.speedTestUrl }), "260px")),
      h("div", { class: "hint", text: t("The speed test only runs when you click it.") }),
    ),
  );
}

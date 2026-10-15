// The dashboard's pure rules (src/core/dashboard.ts): formatting, app names,
// screen-time days, the focus ring, music played, tile order and Mochi's mood.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appColor, appName, dayBefore, diskLow, focusLeft, focusProgress, formatBytes, formatClock, formatDuration,
  formatRate, level, listeningSummary, mediaPosition, mochiMood, moveTile, ratio, tempLevel, tileOrder, TILE_IDS,
  topApps, weatherInfo, week, cleanupDefault, cleanupTotal,
} from "../src/core/dashboard.ts";
import { DEFAULT_SETTINGS, dashboardPrefs } from "../src/core/state.ts";

test("sizes and rates read the way Task Manager writes them", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "2 KB");
  assert.equal(formatBytes(11.2 * 1024 ** 3), "11.2 GB");
  assert.equal(formatBytes(2 * 1024 ** 4), "2.00 TB");
  assert.equal(formatBytes(-1), "–");
  assert.equal(formatRate(null), "–");
  assert.equal(formatRate(1024 * 1024 * 3), "3.0 MB/s");
});

test("lengths of time keep their two biggest units", () => {
  assert.equal(formatDuration(40), "40 s");
  assert.equal(formatDuration(12 * 60 + 5), "12 min");
  assert.equal(formatDuration(2 * 3600 + 5 * 60), "2 h 05 min");
  assert.equal(formatDuration(3 * 86400 + 4 * 3600), "3 d 4 h");
  assert.equal(formatClock(25 * 60_000), "25:00");
  assert.equal(formatClock(59_001), "1:00");
  assert.equal(formatClock(3_723_000), "1:02:03");
});

test("gauges go amber then red, and a nearly full system drive is low", () => {
  assert.equal(ratio(5, 10), 0.5);
  assert.equal(ratio(5, 0), 0);
  assert.equal(level(0.5), "ok");
  assert.equal(level(0.8), "warn");
  assert.equal(level(0.95), "hot");
  assert.equal(tempLevel(null), "ok");
  assert.equal(tempLevel(80), "warn");
  assert.equal(tempLevel(92), "hot");
  const gb = 1024 ** 3;
  assert.ok(diskLow({ diskFree: 8 * gb, diskTotal: 500 * gb }));
  assert.ok(diskLow({ diskFree: 20 * gb, diskTotal: 250 * gb }));
  assert.ok(!diskLow({ diskFree: 100 * gb, diskTotal: 500 * gb }));
});

test("apps get the names people know, and a steady colour", () => {
  assert.equal(appName("chrome.exe"), "Chrome");
  assert.equal(appName("Code.exe"), "VS Code");
  assert.equal(appName("myTool.exe"), "MyTool");
  assert.equal(appColor("chrome.exe"), appColor("CHROME.EXE"));
});

test("screen time: the last seven days oldest first, apps most used first", () => {
  assert.equal(dayBefore("2026-03-01", 1), "2026-02-28");
  const st = {
    today: "2026-10-14",
    days: {
      "2026-10-14": { apps: { "a.exe": 10, "b.exe": 30 }, active: 40, first: 0, last: 1 },
      "2026-10-10": { apps: {}, active: 7, first: null, last: null },
    },
  };
  const w = week(st);
  assert.equal(w.length, 7);
  assert.equal(w[0].day, "2026-10-08");
  assert.equal(w[6].secs, 40);
  assert.equal(w[2].secs, 7);
  assert.deepEqual(topApps(st.days["2026-10-14"]), [["b.exe", 30], ["a.exe", 10]]);
  assert.deepEqual(topApps(undefined), []);
});

test("the focus ring runs on from the end time, and stands still when paused", () => {
  const running = { phase: "focus", running: true, endsAt: 10_000, leftMs: 0, totalMs: 20_000 };
  assert.equal(focusLeft(running, 5_000), 5_000);
  assert.equal(focusProgress(running, 5_000), 0.75);
  assert.equal(focusLeft(running, 50_000), 0);
  const paused = { ...running, running: false, leftMs: 8_000 };
  assert.equal(focusLeft(paused, 99_999), 8_000);
  assert.equal(focusProgress({ ...paused, phase: "idle" }, 0), 0);
});

test("music: the position runs while playing, and plays add up per artist", () => {
  const m = { playing: true, position: 10, positionAt: 1000, duration: 30 };
  assert.equal(mediaPosition(m, 6000), 15);
  assert.equal(mediaPosition(m, 999_999), 30);
  assert.equal(mediaPosition({ ...m, playing: false }, 6000), 10);
  const plays = [
    { day: "2026-10-14", title: "a", artist: "X", source: "Spotify", secs: 120 },
    { day: "2026-10-13", title: "b", artist: "Y", source: "Spotify", secs: 240 },
    { day: "2026-10-12", title: "c", artist: "X", source: "Spotify", secs: 180 },
    { day: "2026-09-01", title: "old", artist: "Z", source: "Spotify", secs: 999 },
  ];
  const sum = listeningSummary(plays, "2026-10-14");
  assert.equal(sum.tracks, 3);
  assert.equal(sum.minutes, 9);
  assert.deepEqual(sum.artists, [["X", 300], ["Y", 240]]);
});

test("tiles keep the user's order and pick up the ones they never placed", () => {
  const order = tileOrder(["news", "bogus", "music", "news"]);
  assert.deepEqual(order.slice(0, 2), ["news", "music"]);
  assert.equal(order.length, TILE_IDS.length);
  assert.deepEqual(moveTile(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(moveTile(["a", "b", "c"], "a", null), ["b", "c", "a"]);
});

test("Mochi: alarmed by breaking news, sweating when hot, working while focusing, dancing to music", () => {
  const calm = { cpu: 10, tempC: 40, playing: false, focus: null, urgentNews: false };
  assert.deepEqual(mochiMood(calm), { state: "idle", dancing: false, studious: false });
  assert.equal(mochiMood({ ...calm, playing: true }).dancing, true);
  assert.equal(mochiMood({ ...calm, cpu: 95 }).state, "ratelimit");
  assert.equal(mochiMood({ ...calm, tempC: 90 }).state, "ratelimit");
  assert.deepEqual(mochiMood({ ...calm, focus: { phase: "focus", running: true } }), { state: "working", dancing: false, studious: true });
  assert.equal(mochiMood({ ...calm, focus: { phase: "short", running: true } }).state, "sleeping");
  assert.equal(mochiMood({ ...calm, cpu: 95, urgentNews: true }).state, "approval");
});

test("weather codes become an icon and a label", () => {
  assert.equal(weatherInfo(0).label, "Clear sky");
  assert.equal(weatherInfo(0, false).icon, "🌙");
  assert.equal(weatherInfo(63).label, "Rain");
  assert.equal(weatherInfo(95).label, "Thunderstorm");
});

test("dashboard settings: an older file gets every default, a partial focus keeps the rest", () => {
  const p = dashboardPrefs(DEFAULT_SETTINGS);
  assert.equal(p.screenTime, false);
  assert.equal(p.focus.focusMin, 25);
  assert.ok(p.newsFeeds.length > 0);
  const q = dashboardPrefs({ dashboard: { focus: { focusMin: 50 }, weatherCity: "Pune" } });
  assert.equal(q.focus.focusMin, 50);
  assert.equal(q.focus.shortMin, 5);
  assert.equal(q.weatherCity, "Pune");
});

test("cleanup: caches are ticked by default, a build folder (it costs a rebuild) is not", () => {
  const items = [
    { id: "temp", kind: "temp", label: "Temporary files", path: "", bytes: 100 },
    { id: "chrome", kind: "browser", label: "Chrome cache", path: "", bytes: 200 },
    { id: "proj:C:\p\target", kind: "project", label: "p · target", path: "", bytes: 5000 },
  ];
  assert.deepEqual(items.map(cleanupDefault), [true, true, false]);
  const picked = new Set(items.filter(cleanupDefault).map((i) => i.id));
  assert.equal(cleanupTotal(items, picked), 300);
  picked.add(items[2].id);
  assert.equal(cleanupTotal(items, picked), 5300);
  assert.equal(cleanupTotal(items, new Set()), 0);
});

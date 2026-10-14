// The chat and the PC (src/core/pc-context.ts): the snapshot that goes with a
// message, and the `[[coucou: …]]` actions read from an answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pcNote, readActions } from "../src/core/pc-context.ts";

const GB = 1024 ** 3;

test("the snapshot says what the dashboard sees, in plain lines", () => {
  const note = pcNote({
    now: new Date(2026, 9, 14, 22, 30),
    stats: {
      cpu: 37.4, tempC: 30, memUsed: 11 * GB, memTotal: 16 * GB, disk: "C:", diskFree: 16 * GB, diskTotal: 223 * GB,
      uptimeSecs: 7 * 3600, netDown: 2048, netUp: 1024, battery: null, cores: 4,
      apps: [{ name: "chrome.exe", mem: 3 * GB, processes: 20, windowed: true, canEnd: true },
        { name: "node.exe", mem: GB, processes: 3, windowed: false, canEnd: true }],
    },
    media: { active: true, source: "Spotify", title: "Puppy Love", artist: "Paul Anka", playing: true, volume: 60, muted: false },
    focus: { phase: "focus", running: true, endsAt: new Date(2026, 9, 14, 22, 50).getTime(), leftMs: 0, away: false, todayRounds: 2, todayMin: 50 },
    screen: { tracking: true, today: "2026-10-14", days: { "2026-10-14": { apps: { "Code.exe": 3600 }, active: 3600 } }, current: "Code.exe", previous: "chrome.exe" },
    news: [{ title: "Quake hits coast", source: "BBC News", urgent: true, at: 1, link: "" }],
    weather: null,
    plan: { fiveHour: { usedPct: 37, resetsAt: 0 }, sevenDay: { usedPct: 22, resetsAt: 0 }, updatedAt: 0 },
    jobs: [{ prompt: "run the tests", folder: "C:\\p", at: "18:30", repeat: "daily", enabled: true, running: false, lastOk: true }],
  });
  assert.match(note, /CPU 37% on 4 cores, 30 °C/);
  assert.match(note, /Chrome \(chrome\.exe\) 3\.0 GB/);
  assert.match(note, /Node\.js \(node\.exe\) 1\.0 GB background/);
  assert.match(note, /playing "Puppy Love" by Paul Anka in Spotify/);
  assert.match(note, /Focus running, 20 min left; today 2 rounds, 50 min focused/);
  assert.match(note, /Screen time today: 1 h 00 min — VS Code 1 h 00 min; in front now: VS Code; before that: Chrome/);
  assert.match(note, /37% of the 5-hour limit, 22% of the weekly limit/);
  assert.match(note, /\[BREAKING\] Quake hits coast/);
  assert.match(note, /"run the tests" in C:\\p at 18:30 daily \(last run ok\)/);
});

test("an empty PC says little, never undefined", () => {
  const note = pcNote({ now: new Date(), stats: null, media: null, focus: null, screen: null, news: [], weather: null, plan: null, jobs: [] });
  assert.doesNotMatch(note, /undefined|null/);
});

test("actions are read off the end of an answer and taken out of it", () => {
  const { text, actions } = readActions("Skipping it!\n\n[[coucou: media next]]\n[[coucou: media volume 140]]\n[[ coucou : focus start ]]");
  assert.equal(text, "Skipping it!");
  assert.deepEqual(actions, [
    { kind: "media", action: "next" },
    { kind: "volume", value: 100 },
    { kind: "focus", action: "start" },
  ]);
});

test("Claude Code jobs: now, or at a time with how often", () => {
  const { actions } = readActions(
    "[[coucou: claude now | C:\\code\\app | fix the failing test]]\n" +
    "[[coucou: claude at 7:05 weekdays | C:\\code | summarize git log | keep it short]]\n" +
    "[[coucou: claude at 25:00 | C:\\x | nope]]",
  );
  assert.deepEqual(actions, [
    { kind: "claude", when: "now", folder: "C:\\code\\app", prompt: "fix the failing test" },
    { kind: "claude", when: { at: "07:05", repeat: "weekdays" }, folder: "C:\\code", prompt: "summarize git log | keep it short" },
  ]);
});

test("anything else in brackets is left alone", () => {
  const { text, actions } = readActions("Use [[wiki links]] and [[coucou: rm -rf]] safely.");
  assert.deepEqual(actions, []);
  assert.equal(text, "Use [[wiki links]] and  safely.");
});

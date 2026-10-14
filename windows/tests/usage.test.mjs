// Claude Code usage card data (src/usage/usage.ts): the shape check on what
// claude_usage.rs sends, the local-day grouping, and the headline total.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  billableTokens, compactNumber, dailyTotals, localDayKey, parseUsage, top, totalTokens,
} from "../src/usage/usage.ts";

// Local-time constructors, so the day boundaries hold in any time zone.
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime() / 3_600_000;
const NOW = new Date(2026, 9, 14, 15, 0, 0);

test("the payload from Rust is checked and bad rows are dropped", () => {
  const usage = parseUsage({
    hours: [[at(2026, 10, 14), 1, 2, 3, 4], [1, 2, 3], "junk", [5, "x", 0, 0, 0]],
    models: [["claude-x", 10], [7, 1], ["claude-y", "no"]],
    tools: [["Bash", 4]],
    files: 2,
  });
  assert.equal(usage.hours.length, 1);
  assert.deepEqual(usage.models, [["claude-x", 10]]);
  assert.deepEqual(usage.tools, [["Bash", 4]]);
  assert.equal(usage.files, 2);
  assert.equal(parseUsage(null), null);
  assert.equal(parseUsage({ models: [] }), null);
});

test("cache reads are left out of the billable total", () => {
  assert.equal(billableTokens([0, 10, 20, 30, 1000]), 60);
  const usage = parseUsage({ hours: [[at(2026, 10, 14), 10, 20, 30, 1000]], models: [], tools: [], files: 1 });
  assert.equal(totalTokens(usage), 60);
});

test("hours are grouped by local day and empty days are kept", () => {
  const usage = parseUsage({
    hours: [
      [at(2026, 10, 14, 1), 5, 0, 0, 0],   // today, early morning
      [at(2026, 10, 14, 23), 7, 0, 0, 0],  // today, late
      [at(2026, 10, 12), 100, 0, 0, 0],    // two days ago
      [at(2025, 1, 1), 999, 0, 0, 0],      // far outside the window
    ],
    models: [], tools: [], files: 1,
  });
  const days = dailyTotals(usage, NOW, 5);
  assert.deepEqual(days.map((d) => d.day), [
    "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14",
  ]);
  assert.deepEqual(days.map((d) => d.tokens), [0, 0, 100, 0, 12]);
});

test("the window ends at today, whatever time it is now", () => {
  const days = dailyTotals({ hours: [], models: [], tools: [], files: 0 }, NOW);
  assert.equal(days.length, 30);
  assert.equal(days[29].day, localDayKey(NOW));
});

test("top keeps the first n and the number formatting is short", () => {
  assert.deepEqual(top([1, 2, 3], 2), [1, 2]);
  assert.equal(compactNumber(999), "999");
  assert.equal(compactNumber(1234), "1.2k");
  assert.equal(compactNumber(4_500_000), "4.5M");
});

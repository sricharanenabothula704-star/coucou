// Claude Code usage — pure aggregation of what claude_usage.rs counts.
// Rust reads the transcripts and returns hours (UTC), models and tool calls; this
// file turns them into the card's numbers. Days are the user's local days, which
// is why the grouping happens here. No DOM, no Tauri: tests/usage.test.mjs runs
// it as it is.

/** [hour since the epoch (UTC), input, output, cache write, cache read] tokens. */
export type UsageHour = [number, number, number, number, number];

export interface ClaudeUsage {
  hours: UsageHour[];
  /** [model, tokens], most used first. */
  models: [string, number][];
  /** [tool, calls], most used first. */
  tools: [string, number][];
  /** Transcript files that were read. */
  files: number;
}

export interface DailyUsage {
  /** Local calendar day, "YYYY-MM-DD". */
  day: string;
  /** Input + output + cache-write tokens. Cache reads are left out: they repeat the context each turn. */
  tokens: number;
}

/** Checks the shape Rust sends and drops anything that does not fit. */
export function parseUsage(raw: unknown): ClaudeUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.hours)) return null;
  const hours = r.hours.filter(
    (row): row is UsageHour => Array.isArray(row) && row.length === 5 && row.every((n) => typeof n === "number"),
  );
  const pairs = (value: unknown): [string, number][] =>
    Array.isArray(value)
      ? value.filter((p): p is [string, number] => Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "number")
      : [];
  return {
    hours,
    models: pairs(r.models),
    tools: pairs(r.tools),
    files: typeof r.files === "number" ? r.files : 0,
  };
}

/** "YYYY-MM-DD" for a Date in the user's time zone. */
export function localDayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Input + output + cache-write tokens for one hour row. */
export function billableTokens(row: UsageHour): number {
  return row[1] + row[2] + row[3];
}

/**
 * One entry per local day for the last `days` days, oldest first, zeros
 * included so the chart has no gaps. Hours outside that range are ignored.
 */
export function dailyTotals(usage: ClaudeUsage, now: Date, days = 30): DailyUsage[] {
  const perDay = new Map<string, number>();
  for (const row of usage.hours) {
    const day = localDayKey(new Date(row[0] * 3_600_000));
    perDay.set(day, (perDay.get(day) ?? 0) + billableTokens(row));
  }
  const out: DailyUsage[] = [];
  // Local midnight of today, then step back one calendar day at a time.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const day = localDayKey(d);
    out.push({ day, tokens: perDay.get(day) ?? 0 });
  }
  return out;
}

/** Tokens for the whole window, cache reads left out (see dailyTotals). */
export function totalTokens(usage: ClaudeUsage): number {
  return usage.hours.reduce((sum, row) => sum + billableTokens(row), 0);
}

/** The first `n` entries of a ranking. */
export function top<T>(items: T[], n: number): T[] {
  return items.slice(0, n);
}

/** Human-readable count: 1234 -> "1.2k", 4_500_000 -> "4.5M". */
export function compactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

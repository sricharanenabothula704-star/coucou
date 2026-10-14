// News — headlines from the RSS and Atom feeds in Settings, and which of them
// are urgent. Rust fetches the saved feeds as text (dashboard::news_fetch); this
// file reads them. It is a small reader for the two formats, not a general XML
// parser, so it runs the same in the page and in tests/news.test.mjs.

export interface Headline {
  title: string;
  link: string;
  /** Unix ms; 0 when the feed gives no date. */
  at: number;
  /** The feed's own name ("BBC News"), else its host. */
  source: string;
  urgent: boolean;
}

/** Urgent: a keyword, and less than an hour old. */
export const URGENT_WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_FEED = 30;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : null;
}

/** Atom's <link href="…"/>: the alternate one, else the first. */
function atomLink(block: string): string {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pick = links.find((a) => /rel=["']alternate["']/i.test(a)) ?? links.find((a) => !/rel=/i.test(a)) ?? links[0];
  return pick?.match(/href=["']([^"']+)["']/i)?.[1] ?? "";
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Only links a browser should open. */
function safeLink(link: string): string {
  const l = decode(link);
  return /^https?:\/\//i.test(l) ? l : "";
}

/**
 * A keyword is a whole word ("war" is not "award", "dead" is not "deadline");
 * one ending in * is a stem ("evacuat*" is "evacuated", "evacuation").
 */
export function isUrgent(title: string, at: number, keywords: readonly string[], nowMs: number): boolean {
  if (at > 0 && nowMs - at > URGENT_WINDOW_MS) return false;
  if (at === 0) return false;
  const lower = title.toLowerCase();
  return keywords.some((k) => {
    let key = k.trim().toLowerCase();
    const stem = key.endsWith("*");
    if (stem) key = key.slice(0, -1).trim();
    if (!key) return false;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}${stem ? "" : "(?![\\p{L}\\p{N}])"}`, "u").test(lower);
  });
}

/** A feed's name as a reader would say it: "Top Headlines | The Hindu" is "The Hindu". */
export function feedName(title: string, url: string): string {
  const parts = title.split(/\s+[-|–—]\s+/).map((p) => p.trim()).filter(Boolean);
  const name = parts.length > 1 ? parts[parts.length - 1] : title.trim();
  return name && name.length <= 32 ? name : host(url);
}

/** The headlines of one feed, newest first as the feed gives them. */
export function parseFeed(xml: string, url: string, keywords: readonly string[], nowMs: number): Headline[] {
  const channel = tag(xml, "channel") ?? xml;
  const feedTitle = decode(tag(channel.replace(/<(item|entry)\b[\s\S]*$/i, ""), "title") ?? "");
  const source = feedName(feedTitle, url);
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]).slice(0, MAX_PER_FEED);
  const out: Headline[] = [];
  for (const block of blocks) {
    const atom = /^<entry/i.test(block);
    let title = decode(tag(block, "title") ?? "");
    // Google News ends each title with " - Publisher".
    if (/news\.google\./i.test(url)) title = title.replace(/\s+-\s+[^-]+$/, "");
    if (!title) continue;
    const link = atom ? safeLink(atomLink(block)) : safeLink(tag(block, "link") ?? tag(block, "guid") ?? "");
    const date = tag(block, "pubDate") ?? tag(block, "updated") ?? tag(block, "published") ?? tag(block, "dc:date") ?? "";
    const parsed = Date.parse(decode(date));
    const at = Number.isFinite(parsed) ? parsed : 0;
    out.push({ title, link, at, source, urgent: isUrgent(title, at, keywords, nowMs) });
  }
  return out;
}

/** Same story in two feeds: lowercase, letters and digits only. */
export function storyKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 80);
}

/** Every feed together: duplicates dropped, urgent first, then newest. */
export function mergeFeeds(feeds: Headline[][], limit = 60): Headline[] {
  const seen = new Set<string>();
  const all: Headline[] = [];
  for (const h of feeds.flat()) {
    const key = storyKey(h.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    all.push(h);
  }
  all.sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.at - a.at);
  return all.slice(0, limit);
}

/** "5 min", "3 h", "2 d" ago. */
export function ageMinutes(at: number, nowMs: number): number {
  return at > 0 ? Math.max(0, Math.round((nowMs - at) / 60000)) : -1;
}

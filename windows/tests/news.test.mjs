// News (src/news/news.ts): reading RSS and Atom, what counts as breaking, and
// the same story from two feeds shown once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, feedName, isUrgent, mergeFeeds, parseFeed, storyKey } from "../src/news/news.ts";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const KEYS = ["breaking", "earthquake", "live", "war"];

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>BBC News</title>
  <link>https://www.bbc.co.uk/news</link>
  <item>
    <title><![CDATA[Breaking: Earthquake hits coast]]></title>
    <link>https://www.bbc.co.uk/news/1</link>
    <pubDate>Wed, 14 Oct 2026 11:40:00 GMT</pubDate>
  </item>
  <item>
    <title>Markets steady &amp; calm</title>
    <link>https://www.bbc.co.uk/news/2</link>
    <pubDate>Wed, 14 Oct 2026 09:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Bad link</title>
    <link>javascript:alert(1)</link>
  </item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example</title>
  <entry>
    <title type="html">Live: election results</title>
    <link rel="alternate" href="https://example.com/a"/>
    <updated>2026-10-14T11:55:00Z</updated>
  </entry>
</feed>`;

test("RSS: titles, links, dates and the feed's own name", () => {
  const items = parseFeed(RSS, "https://feeds.bbci.co.uk/news/world/rss.xml", KEYS, NOW);
  assert.equal(items.length, 3);
  assert.equal(items[0].title, "Breaking: Earthquake hits coast");
  assert.equal(items[0].link, "https://www.bbc.co.uk/news/1");
  assert.equal(items[0].source, "BBC News");
  assert.equal(items[0].urgent, true);
  assert.equal(items[1].title, "Markets steady & calm");
  assert.equal(items[1].urgent, false);
  // A link a browser shouldn't open is dropped, the headline kept.
  assert.equal(items[2].link, "");
  assert.equal(items[2].at, 0);
});

test("Atom: the alternate link and the updated date", () => {
  const [entry] = parseFeed(ATOM, "https://example.com/feed", KEYS, NOW);
  assert.equal(entry.title, "Live: election results");
  assert.equal(entry.link, "https://example.com/a");
  assert.equal(entry.urgent, true);
});

test("Google News loses the publisher at the end of each title", () => {
  const xml = `<rss><channel><title>Top stories</title><item><title>Big story - The Hindu</title><link>https://news.google.com/x</link></item></channel></rss>`;
  assert.equal(parseFeed(xml, "https://news.google.com/rss", KEYS, NOW)[0].title, "Big story");
});

test("breaking: a keyword at a word start, and less than an hour old", () => {
  const recent = NOW - 10 * 60_000;
  assert.ok(isUrgent("War declared", recent, KEYS, NOW));
  assert.ok(!isUrgent("Award season opens", recent, KEYS, NOW));
  assert.ok(!isUrgent("Firm will deliver parcels", recent, KEYS, NOW));
  // Whole words: "war" is not "wars"; a * keeps the stem.
  assert.ok(!isUrgent("Star Wars returns", recent, KEYS, NOW));
  assert.ok(!isUrgent("Deadline extended", recent, ["dead"], NOW));
  assert.ok(isUrgent("Thousands evacuated", recent, ["evacuat*"], NOW));
  assert.ok(isUrgent("Evacuation ordered", recent, ["evacuat*"], NOW));
  assert.ok(!isUrgent("War declared", NOW - 2 * 3600_000, KEYS, NOW));
  // No date: never alarming.
  assert.ok(!isUrgent("Breaking", 0, KEYS, NOW));
  assert.ok(!isUrgent("Breaking", recent, [" ", ""], NOW));
});

test("the same story twice shows once, breaking first then newest", () => {
  const a = { title: "Quake hits coast!", link: "", at: NOW - 1000, source: "A", urgent: false };
  const b = { title: "quake hits coast", link: "", at: NOW, source: "B", urgent: false };
  const c = { title: "Breaking thing", link: "", at: NOW - 5000, source: "C", urgent: true };
  const merged = mergeFeeds([[a], [b, c]]);
  assert.deepEqual(merged.map((h) => h.source), ["C", "A"]);
  assert.equal(storyKey("Quake — hits, coast!"), "quake hits coast");
});

test("feeds are named the way a reader would say it", () => {
  assert.equal(feedName("India Latest News: Top National Headlines Today & Breaking News | The Hindu", "https://www.thehindu.com/x"), "The Hindu");
  assert.equal(feedName("BBC News", "https://feeds.bbci.co.uk/x"), "BBC News");
  assert.equal(feedName("A feed with a really very long name and no separator at all", "https://www.example.org/rss"), "example.org");
  assert.equal(feedName("", "https://www.example.org/rss"), "example.org");
});

test("entities and markup are decoded", () => {
  assert.equal(decode("A &lt;b&gt; &#39;q&#x27; <b>bold</b>"), "A <b> 'q' bold");
});

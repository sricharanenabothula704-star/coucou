// The island's copy of what the dashboard pills show (System, Now Playing,
// Focus, News, Screen Time). Filled by src/island/hub.ts; read by the cards in
// src/views/hub.ts and by Mochi's dance rule.

import type { FocusState, MediaState, ScreenTime, SystemStats, Weather } from "./dashboard";
import type { Headline } from "../news/news";
import type { ClaudeUsage } from "../usage/usage";

export const Hub = {
  stats: null as SystemStats | null,
  media: null as MediaState | null,
  art: null as { key: string; dataUrl: string } | null,
  focus: null as FocusState | null,
  news: [] as Headline[],
  screen: null as ScreenTime | null,
  weather: null as Weather | null,
  claude: null as ClaudeUsage | null,
};

/** The cover of the track that is playing, once it has arrived. */
export function hubArtwork(): string | null {
  const m = Hub.media;
  return m && Hub.art && Hub.art.key === m.artKey ? Hub.art.dataUrl : null;
}

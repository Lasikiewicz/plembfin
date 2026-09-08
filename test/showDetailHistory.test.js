import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { mergeShowWithLoadedHistory, patchShowModalEpisodeFromLive } = await import("../public/modules/media-detail-show.js");
const { state, elements } = await import("../public/modules/state.js");

test("show detail unwatch tombstones do not resurrect an older dashboard watch", () => {
  const previousHistory = state.history;
  const previousShowsRaw = state.showsRaw;
  state.history = [{
    id: "old-watch",
    title: "Reacher - S04E05",
    show_title: "Reacher",
    media_type: "episode",
    season: 4,
    episode: 5,
    watched_at: "2026-09-05T20:09:00.000Z",
    sync_action: "watched",
  }];
  state.showsRaw = [{
    title: "Reacher",
    tmdb_id: "108978",
    episodes: [{
      id: "unwatch-transition",
      title: "Reacher - S04E05",
      show_title: "Reacher",
      media_type: "episode",
      season: 4,
      episode: 5,
      watched_at: "2026-09-08T10:19:31.052Z",
      sync_action: "unwatched",
      source: "emby",
    }],
  }];

  try {
    const merged = mergeShowWithLoadedHistory({
      title: "Reacher",
      tmdb_id: "108978",
      episode_count: 28,
      episodes: [
        {
          id: "old-watch",
          title: "Reacher - S04E05",
          show_title: "Reacher",
          media_type: "episode",
          season: 4,
          episode: 5,
          watched_at: "2026-09-05T20:09:00.000Z",
          sync_action: "watched",
          source: "manual",
        },
        {
          id: "s04e04-watch",
          title: "Reacher - S04E04",
          show_title: "Reacher",
          media_type: "episode",
          season: 4,
          episode: 4,
          watched_at: "2026-09-05T19:24:00.000Z",
          sync_action: "watched",
          source: "manual",
        },
      ],
    });

    assert.deepEqual(
      merged.episodes.map((episode) => [episode.season, episode.episode]),
      [[4, 4]],
    );
    assert.equal(merged.episode_count, 28);
  } finally {
    state.history = previousHistory;
    state.showsRaw = previousShowsRaw;
  }
});

test("a stale provider watch cannot repaint an episode after its local unwatch", () => {
  const previous = {
    mediaDetailInline: state.mediaDetailInline,
    activeShowRenderContext: state.activeShowRenderContext,
    showModalEpisodes: state.showModalEpisodes,
    explorerPanel: elements.explorerPanel,
  };
  const tombstone = {
    id: "unwatch-transition",
    title: "Reacher - S04E03",
    show_title: "Reacher",
    media_type: "episode",
    season: 4,
    episode: 3,
    media_key: "episode:4:3:imdb:tt9288030",
    watched_at: "2026-09-08T11:19:37.776Z",
    sync_action: "unwatched",
    source: "manual",
  };
  const target = {
    key: "reacher:s04e03",
    showTitle: "Reacher",
    seasonNumber: 4,
    episodeNumber: 3,
    watched: null,
    progress: null,
  };

  state.mediaDetailInline = true;
  elements.explorerPanel = { querySelectorAll: () => [], querySelector: () => null };
  state.activeShowRenderContext = {
    show: { title: "Reacher", tmdb_id: "108978", episodes: [tombstone] },
    tmdbData: null,
    seasonDetailsByNumber: new Map(),
    loading: false,
    watchHistoryLoading: false,
  };
  state.showModalEpisodes = [target];

  try {
    const staleProviderWatch = {
      ...tombstone,
      id: "provider-watch",
      media_key: "episode:4:3:tvdb:stale-provider-id",
      source: "jellyfin",
      sync_action: "watched",
      watched_at: "2026-09-05T19:38:00.000Z",
    };
    assert.equal(patchShowModalEpisodeFromLive({
      change: {
        sourceTable: "watch_history",
        mediaType: "episode",
        showTitle: "Reacher",
        mediaKey: staleProviderWatch.media_key,
        season: 4,
        episode: 3,
      },
      row: staleProviderWatch,
    }), true);
    assert.equal(target.watched, null);
    assert.equal(state.activeShowRenderContext.show.episodes[0].sync_action, "unwatched");

    const laterProviderWatch = {
      ...staleProviderWatch,
      id: "provider-watch-later",
      watched_at: "2026-09-09T19:38:00.000Z",
    };
    patchShowModalEpisodeFromLive({
      change: {
        sourceTable: "watch_history",
        mediaType: "episode",
        showTitle: "Reacher",
        mediaKey: laterProviderWatch.media_key,
        season: 4,
        episode: 3,
      },
      row: laterProviderWatch,
    });
    assert.equal(target.watched.id, "provider-watch-later");
  } finally {
    state.mediaDetailInline = previous.mediaDetailInline;
    state.activeShowRenderContext = previous.activeShowRenderContext;
    state.showModalEpisodes = previous.showModalEpisodes;
    elements.explorerPanel = previous.explorerPanel;
  }
});

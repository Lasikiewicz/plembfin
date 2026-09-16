import test from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixtures/tautulli/history.json" with { type: "json" };

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-tautulli-review-test-");

const {
  commitTautulliImport,
  normalizeReviewDecisions,
  prepareTautulliImport,
  tautulliReviewKey,
} = await import("../server/src/utils/tautulliImport.js");
const { applyTuningConfig, resetTuningForTests } = await import("../server/src/utils/tuning.js");
const { db } = await import("../server/src/db.js");

test.after(() => {
  resetTuningForTests();
  db.close();
});

const OPTIONS = { userId: "7", userName: "Alex" };

// Two existing local records that both plausibly match the same incoming
// Tautulli play: same film, same day, different provider identity and source.
// This is the shape that makes an import ambiguous rather than a clean merge.
function ambiguousHistory() {
  return [
    {
      id: "trakt-1", title: "Example Film", media_type: "movie",
      watched_at: "2025-09-15T20:00:00.000Z", imdb_id: null, tmdb_id: "1234", tvdb_id: null, source: "trakt_import",
    },
    {
      id: "plex-1", title: "Example Film", media_type: "movie",
      watched_at: "2025-09-15T03:00:00.000Z", imdb_id: "tt1234567", tmdb_id: null, tvdb_id: null, source: "plex",
    },
  ];
}

async function previewAmbiguous(reviewDecisions) {
  return prepareTautulliImport([fixture.movies[0]], {
    ...OPTIONS,
    history: ambiguousHistory(),
    ...(reviewDecisions ? { reviewDecisions } : {}),
  });
}

test("an ambiguous play is held for review and reports its candidates", async () => {
  const preview = await previewAmbiguous();
  assert.equal(preview.needs_review, 1);
  assert.equal(preview.new, 0);
  assert.equal(preview.reviews.length, 1);

  const review = preview.reviews[0];
  assert.ok(review.reviewKey, "a review row must carry a stable key");
  assert.equal(review.candidateCount, 2);
  assert.equal(review.candidates.length, 2);
  // Enough to tell the two candidates apart, and nothing more: no raw history
  // rows leave the server here.
  for (const candidate of review.candidates) {
    assert.deepEqual(
      Object.keys(candidate).filter((key) => candidate[key] !== undefined).sort(),
      ["id", "media_type", "season", "episode", "watched_at", "source", "title"].filter((key) => candidate[key] !== undefined).sort(),
    );
  }
  assert.deepEqual(preview.items.filter((item) => item.status === "needs_review").length, 1);
});

test("the review key is content-derived, so it survives a shifted history", async () => {
  const first = await previewAmbiguous();
  // The same play arriving after an unrelated row was pruned upstream keeps the
  // same key, which is why decisions are addressed by key and not by index.
  const second = await prepareTautulliImport([{ ...fixture.movies[1] }, fixture.movies[0]], {
    ...OPTIONS,
    history: ambiguousHistory(),
  });
  assert.equal(second.reviews.length, 1);
  assert.equal(second.reviews[0].reviewKey, first.reviews[0].reviewKey);
  assert.notEqual(second.reviews[0].index, first.reviews[0].index);
});

test("a review decision to merge records the match and imports nothing", async () => {
  const { reviews } = await previewAmbiguous();
  const key = reviews[0].reviewKey;
  const preview = await previewAmbiguous({ [key]: { action: "merge", matchedId: "plex-1" } });

  assert.equal(preview.needs_review, 0);
  assert.equal(preview.reviewed_merged, 1);
  assert.equal(preview.merged, 1);
  assert.equal(preview.new, 0);
  assert.equal(preview.records.length, 0);
  const item = preview.items.find((entry) => entry.status === "reviewed_merged");
  assert.equal(item.matchedId, "plex-1");
});

test("a review decision to import creates a separate play", async () => {
  const { reviews } = await previewAmbiguous();
  const preview = await previewAmbiguous({ [reviews[0].reviewKey]: { action: "import" } });

  assert.equal(preview.needs_review, 0);
  assert.equal(preview.reviewed_imported, 1);
  assert.equal(preview.new, 1);
  assert.equal(preview.records.length, 1);
});

test("a review decision to skip imports nothing and is not left pending", async () => {
  const { reviews } = await previewAmbiguous();
  const preview = await previewAmbiguous({ [reviews[0].reviewKey]: { action: "skip" } });

  assert.equal(preview.needs_review, 0);
  assert.equal(preview.reviewed_skipped, 1);
  assert.equal(preview.new, 0);
  assert.equal(preview.records.length, 0);
});

test("an unrecognized or malformed decision leaves the record in review", async () => {
  const { reviews } = await previewAmbiguous();
  const key = reviews[0].reviewKey;

  // Anything that is not one of the three actions must not be guessed at: the
  // safe failure is to keep holding the record, never to import or discard it.
  for (const bogus of [{ action: "delete" }, { action: "" }, null, "merge-ish", 42]) {
    const preview = await previewAmbiguous({ [key]: bogus });
    assert.equal(preview.needs_review, 1, `decision ${JSON.stringify(bogus)} should not resolve the review`);
    assert.equal(preview.new, 0);
  }

  // A decision for a key that is not in this batch is simply unused.
  const unrelated = await previewAmbiguous({ "movie:tmdb:999:2020-01-01": { action: "import" } });
  assert.equal(unrelated.needs_review, 1);
});

test("normalizeReviewDecisions keeps only the three real actions", () => {
  const normalized = normalizeReviewDecisions({
    a: { action: "merge", matchedId: "x" },
    b: { action: "import" },
    c: { action: "skip" },
    d: { action: "explode" },
    e: null,
  });
  assert.deepEqual([...normalized.keys()].sort(), ["a", "b", "c"]);
  assert.deepEqual(normalized.get("a"), { action: "merge", matchedId: "x" });
  assert.equal(normalized.get("b").matchedId, null);
  assert.equal(normalizeReviewDecisions(null).size, 0);
  assert.equal(normalizeReviewDecisions("nonsense").size, 0);
});

test("tautulliReviewKey is stable for the same play and differs across days", () => {
  const record = { title: "Example Film", media_type: "movie", tmdb_id: "1234", watched_at: "2025-09-15T02:33:20.000Z" };
  assert.equal(tautulliReviewKey(record), tautulliReviewKey({ ...record, watched_at: "2025-09-15T22:00:00.000Z" }));
  assert.notEqual(tautulliReviewKey(record), tautulliReviewKey({ ...record, watched_at: "2025-09-16T02:33:20.000Z" }));
});

// ── Composition with the standing Plex policy ──────────────────────────────

test("review decisions and the Plex historical policy compose independently", async () => {
  const { reviews } = await previewAmbiguous();
  const key = reviews[0].reviewKey;
  applyTuningConfig({ plexHistoricalWatchedSync: false });
  try {
    const preview = await prepareTautulliImport([fixture.movies[0]], {
      ...OPTIONS,
      history: ambiguousHistory(),
      reviewDecisions: { [key]: { action: "import" } },
      selectedTargets: ["plex", "emby"],
      activeTargets: ["plex", "emby", "jellyfin"],
    });

    // The review decision still imports the play locally...
    assert.equal(preview.reviewed_imported, 1);
    assert.equal(preview.records.length, 1);
    // ...while the Plex policy suppresses only the Plex projection.
    assert.deepEqual(preview.targetPlan.map((entry) => [entry.target, entry.decision]), [
      ["plex", "skipped_by_policy"],
      ["emby", "send"],
      ["jellyfin", "not_selected"],
    ]);
    assert.match(preview.telemetry, /Target plex status: skipped - Skipped by policy/);
    assert.match(preview.telemetry, /Target emby status: pending/);
  } finally {
    resetTuningForTests();
  }
});

test("commit applies the same review decisions the preview reported", async () => {
  const { reviews } = await previewAmbiguous();
  const key = reviews[0].reviewKey;
  const committed = await commitTautulliImport([fixture.movies[0]], {
    ...OPTIONS,
    history: ambiguousHistory(),
    reviewDecisions: { [key]: { action: "skip" } },
  });
  // Preview and commit run the same decision helper, so a skipped review can
  // never turn into an insert between the two.
  assert.equal(committed.reviewed_skipped, 1);
  assert.equal(committed.needs_review, 0);
  assert.equal(committed.inserted, 0);
});

// ── Approximated dates and possible rewatches ──────────────────────────────
//
// Plembfin holds a lot of approximated watch dates (release-day anchoring,
// episode timing, older manual backfills), written on a round clock hour. The
// same-calendar-day merge treats a real Tautulli timestamp a day either side of
// one as a rewatch, which silently duplicates the viewing. Measured against a
// real library: 36 of 861 incoming plays sat within a week of an approximated
// record.

function historyWith(watchedAt, extra = {}) {
  return [{
    id: "existing-1", title: "Example Film", media_type: "movie",
    watched_at: watchedAt, imdb_id: null, tmdb_id: "1234", tvdb_id: null,
    source: "manual", sync_action: "watched", ...extra,
  }];
}

async function previewAgainst(history, reviewDecisions) {
  return prepareTautulliImport([fixture.movies[0]], {
    ...OPTIONS,
    history,
    ...(reviewDecisions ? { reviewDecisions } : {}),
  });
}

test("a real play next to an approximated date is the same viewing, not a rewatch", async () => {
  // fixture play is 2025-09-15T02:33:20Z; the approximated record is the day
  // before on a round hour.
  const preview = await previewAgainst(historyWith("2025-09-14T12:00:00.000Z"));
  assert.equal(preview.merged_approximate_date, 1);
  assert.equal(preview.merged, 1);
  assert.equal(preview.new, 0);
  assert.equal(preview.needs_review, 0);
  assert.equal(preview.records.length, 0);
  assert.equal(preview.items[0].status, "merged_approximate_date");
});

test("a real play next to another real timestamp is not auto-merged", async () => {
  // Same one-day gap, but the existing record has a real playback time, so
  // there is nothing to suggest it was approximated.
  const preview = await previewAgainst(historyWith("2025-09-14T21:47:13.000Z"));
  assert.equal(preview.merged_approximate_date, 0);
  assert.equal(preview.needs_review, 1);
  assert.equal(preview.reviews[0].reason, "possible_rewatch");
});

test("two plays inside the rewatch window go to review rather than being guessed", async () => {
  const preview = await previewAgainst(historyWith("2025-08-28T21:47:13.000Z"));
  assert.equal(preview.needs_review, 1);
  assert.equal(preview.possible_rewatch, 1);
  assert.equal(preview.new, 0);

  const review = preview.reviews[0];
  assert.equal(review.reason, "possible_rewatch");
  assert.equal(review.candidateCount, 1);
  assert.equal(review.candidates[0].id, "existing-1");
  assert.ok(review.gapDays > 17 && review.gapDays < 18, `unexpected gap ${review.gapDays}`);
});

test("a play well outside the rewatch window is simply a new record", async () => {
  const preview = await previewAgainst(historyWith("2024-01-01T21:47:13.000Z"));
  assert.equal(preview.needs_review, 0);
  assert.equal(preview.new, 1);
  assert.equal(preview.records.length, 1);
});

test("the rewatch review offers the same three answers, and import means a second viewing", async () => {
  const history = historyWith("2025-08-28T21:47:13.000Z");
  const { reviews } = await previewAgainst(history);
  const key = reviews[0].reviewKey;

  const asRewatch = await previewAgainst(history, { [key]: { action: "import" } });
  assert.equal(asRewatch.reviewed_imported, 1);
  assert.equal(asRewatch.new, 1, "confirming a rewatch must create a second record");

  const asSame = await previewAgainst(history, { [key]: { action: "merge", matchedId: "existing-1" } });
  assert.equal(asSame.reviewed_merged, 1);
  assert.equal(asSame.new, 0, "the same viewing must not create a second record");

  const skipped = await previewAgainst(history, { [key]: { action: "skip" } });
  assert.equal(skipped.reviewed_skipped, 1);
  assert.equal(skipped.new, 0);
});

test("an unwatched record never counts as a nearby watch", async () => {
  const preview = await previewAgainst(historyWith("2025-09-14T12:00:00.000Z", { sync_action: "unwatched" }));
  assert.equal(preview.merged_approximate_date, 0);
  assert.equal(preview.needs_review, 0);
  assert.equal(preview.new, 1);
});

test("isApproximatedWatchDate only matches a round clock hour", async () => {
  const { isApproximatedWatchDate } = await import("../server/src/utils/tautulliImport.js");
  assert.equal(isApproximatedWatchDate("2025-09-14T12:00:00.000Z"), true);
  assert.equal(isApproximatedWatchDate("2025-09-14T11:00:00Z"), true);
  assert.equal(isApproximatedWatchDate("2025-09-14T12:00:01.000Z"), false);
  assert.equal(isApproximatedWatchDate("2025-09-14T12:30:00.000Z"), false);
  assert.equal(isApproximatedWatchDate(""), false);
});

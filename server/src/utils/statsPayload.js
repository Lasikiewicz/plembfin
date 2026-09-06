// Shape the stats response around the report the caller is actually viewing.
// Period selectors only need an index; shipping every ranked report on every
// stats load made the browser pay for the full history projection repeatedly.
export function statsPayloadForPeriod(stats = {}, requestedPeriod = "all") {
  const sourceReports = stats?.reports || {};
  const years = Array.isArray(sourceReports.years) ? sourceReports.years : [];
  const months = Array.isArray(sourceReports.months) ? sourceReports.months : [];
  const period = String(requestedPeriod || "all").trim().toLowerCase();
  const selectedPeriod = period === "all"
    ? "all"
    : /^\d{4}(?:-\d{2})?$/.test(period) ? period : "all";
  const selected = selectedPeriod === "all"
    ? sourceReports.all || null
    : [...years, ...months].find((report) => String(report?.period || "") === selectedPeriod) || null;

  const index = (reports) => reports.map((report) => ({
    period: report.period,
    label: report.label || report.period,
  }));

  return {
    total: stats.total || 0,
    totalWatches: stats.totalWatches || 0,
    movies: stats.movies || 0,
    uniqueMoviesLogged: stats.uniqueMoviesLogged || 0,
    episodes: stats.episodes || 0,
    totalTvEpisodesTracked: stats.totalTvEpisodesTracked || 0,
    topSource: stats.topSource || "none",
    topSourceCount: stats.topSourceCount || 0,
    dbSizeBytes: stats.dbSizeBytes || 0,
    firstWatch: stats.firstWatch || null,
    lastWatch: stats.lastWatch || null,
    sourceBreakdown: Array.isArray(stats.sourceBreakdown) ? stats.sourceBreakdown : [],
    topShows: Array.isArray(stats.topShows) ? stats.topShows : [],
    monthlyActivity: Array.isArray(stats.monthlyActivity) ? stats.monthlyActivity : [],
    reports: {
      all: selectedPeriod === "all" ? selected : null,
      years: index(years),
      months: index(months),
      ...(selectedPeriod !== "all" && selected ? { selected } : {}),
    },
  };
}

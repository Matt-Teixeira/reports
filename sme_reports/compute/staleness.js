// The 24h currency line, shared by every surface that distinguishes a
// current reading from an old one: the brief's now-value tiles ("as of
// <day>" prefix), the narrative's EDU "stopped <day>" clause, and the fleet
// EDU section's dimmed cells and hottest-room demotion. One constant so the
// surfaces can never disagree about what "stale" means.
//
// Staleness is strictly MORE than 24h: a reading exactly a day old is still
// current (check_chart pins the boundary).
//
// Same NUMBER, different MEANINGS — do not merge into this constant:
// compute/metrics.js THERMAL_LAG_MS (how long a magnet keeps warming after
// a compressor recovery) and the DAY_MS axis/bucketing constants in
// render/scales.js and compute/series.js (calendar arithmetic).
const STALE_MS = 24 * 3600000;

module.exports = { STALE_MS };

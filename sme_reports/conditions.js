const { COLORS } = require("./output/email_theme");

// Shared vocabulary for the five condition archetypes produced by
// compute/archetype.js. Lives here rather than inside one sender so the
// summary email, the batch email, and the fleet summary PDF cannot drift
// apart on ordering, labels, or which conditions count as needing attention.

// Worst first. This MUST match the priority order in compute/archetype.js —
// a recovered compressor stop outranks a threshold breach there, so it does
// here too.
const SEVERITY_ORDER = [
  "compressor_stop_ongoing",
  "compressor_stop_recovered",
  "threshold_exceeded",
  "pressure_rising",
  "stable_healthy"
];

const CONDITION_LABELS = {
  compressor_stop_ongoing: "COMPRESSOR STOP — ONGOING",
  compressor_stop_recovered: "compressor stop, recovered",
  // Deliberately past tense and explicit about WHICH reading crossed:
  // this condition fires on the window's peak, so a system can carry it
  // while its current reading sits comfortably under the limit.
  threshold_exceeded: "PEAK OVER LIMIT",
  pressure_rising: "pressure rising",
  stable_healthy: "stable / healthy"
};

// Dense-table variants. The full labels wrap to two or three lines in a
// ten-column vendor table, which makes row height unpredictable — and row
// height is what pagination is computed from.
const CONDITION_SHORT = {
  compressor_stop_ongoing: "STOP, ONGOING",
  compressor_stop_recovered: "stop, recovered",
  threshold_exceeded: "PEAK OVER LIMIT",
  pressure_rising: "rising",
  stable_healthy: "stable"
};

// Everything that is not stable. A compressor stop that recovered still cost
// the magnet hours of warming, so it is worth a human look even though it is
// no longer live.
const ATTENTION = new Set([
  "compressor_stop_ongoing",
  "compressor_stop_recovered",
  "threshold_exceeded",
  "pressure_rising"
]);

// The subset that is actively wrong right now, as opposed to wrong recently.
// Drives the second tier of the headline so "needs attention" staying high
// doesn't drown out the systems failing at this moment.
const URGENT = new Set(["compressor_stop_ongoing", "threshold_exceeded"]);

// Color is a separate axis from attention: a recovered stop counts toward the
// attention total but reads amber, so a table still separates live problems
// from resolved ones at a glance.
const CONDITION_COLOR = {
  compressor_stop_ongoing: COLORS.red,
  compressor_stop_recovered: COLORS.amber,
  threshold_exceeded: COLORS.red,
  pressure_rising: COLORS.amber,
  stable_healthy: COLORS.teal
};

// Attention, urgency and data-issue status are properties of a SYSTEM, not
// of an archetype alone, so all three take a distilled record
// (compute/summary_facts.js).
//
// A data issue is a MONITORING problem wearing a magnet condition's clothes:
// either the sensor chain is emitting impossible combinations
// (sensor_suspect), or the compressor has read "off" since before the window
// opened while the magnet shows no thermal response (offline_kind
// "no_signal" — a dead signal, since a real month-long stop leaves a warm
// magnet). These leave the attention list entirely and are counted in their
// own headline tier. A recorded quench overrides: missing a real quench is
// worse than trusting a suspect chain.
const is_data_issue = (r) =>
  r.quenched !== true &&
  (r.sensor_suspect === true || r.offline_kind === "no_signal");

// A quench is recorded independently of the primary metric — a quenched
// magnet can read normal pressure and classify `stable_healthy` — so it has
// to be an overlay, or it vanishes from the fleet view.
const is_attention = (r) =>
  !is_data_issue(r) && (ATTENTION.has(r.archetype) || r.quenched === true);

// Urgency is about NOW. `threshold_exceeded` fires on the window's PEAK, so a
// system that spiked last week and has since settled is worth listing but is
// not a live problem. A current breach, an unrecovered stop, or a quench are.
//
// Left-censored stops (off since before the window; offline_kind set) are
// never urgent: after a month "off" the magnet is either already warm — a
// finished state, listed as WARM / OFFLINE — or the signal is lying. The
// window where paging someone could still save helium has long passed.
const is_urgent = (r) => {
  if (r.quenched === true) return true;
  if (is_data_issue(r) || r.offline_kind === "warm") return false;
  return (
    r.archetype === "compressor_stop_ongoing" ||
    (r.primary_breach !== undefined && r.primary_breach !== null) ||
    r.primary_severity === "high" ||
    // Fall back to the archetype when handed a record that carries no metric
    // detail, so a caller without distilled facts still errs toward flagging.
    (r.primary_breach === undefined && URGENT.has(r.archetype))
  );
};

// Unknown archetypes sort last rather than first — indexOf returns -1, which
// would otherwise float an unrecognized value above a live compressor stop.
const severity_rank = (archetype) => {
  const i = SEVERITY_ORDER.indexOf(archetype);
  return i === -1 ? SEVERITY_ORDER.length : i;
};

const by_severity = (a, b) => severity_rank(a.archetype) - severity_rank(b.archetype);

// Worst first: quenched systems ahead of everything, then live (urgent)
// problems ahead of settled ones — without this, WARM / OFFLINE systems
// share the ongoing-stop archetype and would bury a fresh stop below eleven
// parked magnets.
const attention_sort = (a, b) => {
  if (!!a.quenched !== !!b.quenched) return a.quenched ? -1 : 1;
  const ua = is_urgent(a);
  const ub = is_urgent(b);
  if (ua !== ub) return ua ? -1 : 1;
  return by_severity(a, b);
};

// What a record's condition cell should actually say, overlays included.
// null means "use the archetype" — the overlay states replace the label
// because the archetype is exactly what these systems are wrongly wearing:
// a dead sensor reads "COMPRESSOR STOP — ONGOING" without this.
const effective_status = (r) => {
  if (is_data_issue(r)) return r.sensor_suspect ? "sensor_suspect" : "no_signal";
  if (r.offline_kind === "warm") return "warm_offline";
  return null;
};

const STATUS_LABELS = {
  warm_offline: "OFF ENTIRE PERIOD",
  no_signal: "no compressor signal",
  sensor_suspect: "sensor data suspect"
};

const STATUS_COLOR = (key) =>
  key === "warm_offline" ? COLORS.amber : COLORS.grey;

// Record-aware variant of condition_cell for the emails.
const condition_cell_record = (r) => {
  // A quench overrides every label. It is already counted as attention and
  // urgent by the functions above — if the cell then says "stable / healthy"
  // the email calls a quenched magnet healthy while its own headline counts
  // it as urgent. Unmarked: a recorded quench is a reading, not a conclusion.
  if (r.quenched === true) return `<b style="color:${COLORS.red};">QUENCH</b>`;
  const status = effective_status(r);
  if (!status)
    return condition_cell(r.archetype);
  return `<span style="color:${STATUS_COLOR(status)};">${STATUS_LABELS[status]}<sup>c</sup></span>`;
};

const condition_label = (archetype) => CONDITION_LABELS[archetype] || archetype;

const condition_short = (archetype) =>
  CONDITION_SHORT[archetype] || CONDITION_LABELS[archetype] || archetype;

const condition_color = (archetype) => CONDITION_COLOR[archetype] || COLORS.grey;

const condition_cell = (archetype) => {
  const label = condition_label(archetype);
  const color = condition_color(archetype);
  return URGENT.has(archetype)
    ? `<b style="color:${color};">${label}</b>`
    : `<span style="color:${color};">${label}</span>`;
};

module.exports = {
  SEVERITY_ORDER,
  CONDITION_LABELS,
  CONDITION_SHORT,
  condition_short,
  ATTENTION,
  URGENT,
  CONDITION_COLOR,
  severity_rank,
  by_severity,
  attention_sort,
  is_attention,
  is_urgent,
  is_data_issue,
  effective_status,
  STATUS_LABELS,
  STATUS_COLOR,
  condition_cell_record,
  condition_label,
  condition_color,
  condition_cell
};

// The fleet cover's LEAD sentence — "155 systems analyzed — 106 need
// attention, 3 urgent, 1 limited coverage." — composed here so the page
// that draws it and the checks that measure it read one definition.
//
// Found live (2026-08-14, the first 6-month fleet document): a 155-system
// cover whose lead wrapped to two lines overflowed page 1 by 8px, clipping
// the last attention row SILENTLY (.page is overflow:hidden). The counts
// that wrap it — a three-digit attention tally beside the urgent,
// data-issue and limited clauses — are reachable on any period; a 6-month
// window just makes a long attention list ordinary.
//
// The fix is a RESERVATION, not a prediction: fleet_model.js's
// ATTENTION_FIRST_PAGE holds room for a second lead line on every cover,
// so the row budget stays a constant and no font metric sits in the render
// path. `lead_lines` below exists for the CHECKS — it asserts the
// invariant that reservation rests on (the sentence cannot reach a third
// line, even with every clause at four digits), so lengthening the wording
// fails check_fleet.js instead of quietly clipping a row again.
//
// Width prediction uses the same Chromium-measured character table the
// fleet tables and charts predict with (assets/charw8.js at 8pt =
// 10.667px, scaled linearly, with a measured calibration for this
// sentence's larger mixed sizes): within ~1.4% of the rendered width on
// the live sentences, biased to over-estimate. Good enough for a ceiling
// assertion with a 40% margin; deliberately not good enough to be trusted
// with a page's last row.

const CHARW8 = require("./assets/charw8");

const PX_PER_PT = 96 / 72;
// .lead is 12pt; .lead b is 14pt (fleet_page.js).
const PLAIN_PX = 12 * PX_PER_PT;
const BOLD_PX = 14 * PX_PER_PT;
// Calibration, MEASURED not assumed: the raw 8pt table over-predicts this
// sentence's 12/14pt mix by 3.5-7% (Chromium, live and synthetic leads —
// digits, spaces and the em dash all scale a little differently from the
// table's average glyph). 0.96 lands the four sentences long enough to
// matter within ~1% of their rendered width; short ones stay conservative,
// which costs nothing because they never approach a wrap.
const CALIBRATION = 0.96;
// .page is 8.5in wide with .5in of padding each side.
const LEAD_WIDTH_PX = (8.5 - 1) * 96;
// Predict a wrap slightly before the real edge: a sentence measuring 98%
// of the line is close enough to the boundary that the estimate's error
// bar reaches past it.
const WRAP_AT = 0.98;

const text_px = (s, size) => {
  let w = 0;
  for (const ch of String(s)) w += CHARW8[ch] ?? 16;
  return (w * size) / 10.667;
};

// The sentence as a list of {text, bold} segments — the single source both
// the HTML and the width prediction are derived from. `color` is a key
// into the caller's palette rather than a literal, so this module carries
// no palette of its own.
const lead_segments = (vm) => {
  const s = [];
  if (vm.total) {
    s.push({ text: String(vm.total), bold: true });
    s.push({ text: " systems analyzed — ", bold: false });
    s.push({
      text: `${vm.attention_count} need${vm.attention_count === 1 ? "s" : ""} attention`,
      bold: true,
      color: vm.attention_count ? "amber" : "teal"
    });
    if (vm.urgent_count)
      s.push({ text: ", ", bold: false }, { text: `${vm.urgent_count} urgent`, bold: true, color: "red" });
    if (vm.data_issue_count)
      s.push(
        { text: ", ", bold: false },
        {
          text: `${vm.data_issue_count} data issue${vm.data_issue_count === 1 ? "" : "s"}`,
          bold: true,
          color: "grey"
        }
      );
    if (vm.limited_count)
      s.push(
        { text: ", ", bold: false },
        { text: `${vm.limited_count} limited coverage`, bold: true, color: "grey" }
      );
  } else if (vm.limited_count) {
    s.push({ text: "No systems analyzed", bold: true });
    s.push({ text: " in this period", bold: false });
    s.push({ text: " — ", bold: false });
    s.push({ text: `${vm.limited_count} limited coverage`, bold: true, color: "grey" });
  } else {
    s.push({ text: "No systems produced data", bold: true });
    s.push({ text: " in this period", bold: false });
  }
  s.push({ text: ".", bold: false });
  return s;
};

const lead_html = (vm, COLORS) =>
  lead_segments(vm)
    .map((seg) =>
      seg.bold
        ? `<b${seg.color ? ` style="color:${COLORS[seg.color]};"` : ""}>${seg.text}</b>`
        : seg.text
    )
    .join("");

const lead_width_px = (vm) =>
  lead_segments(vm).reduce((w, seg) => w + text_px(seg.text, seg.bold ? BOLD_PX : PLAIN_PX), 0) *
  CALIBRATION;

// How many lines the lead occupies on the cover. CHECK-TIME ONLY — the
// render path reserves two lines unconditionally rather than asking. Used
// to assert that two lines really is the ceiling.
const lead_lines = (vm) => Math.max(1, Math.ceil(lead_width_px(vm) / (LEAD_WIDTH_PX * WRAP_AT)));

module.exports = {
  lead_segments,
  lead_html,
  lead_width_px,
  lead_lines,
  LEAD_WIDTH_PX,
  CALIBRATION
};

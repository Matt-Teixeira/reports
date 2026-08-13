// Solve fleet_page.js's SECTION_W tables against MEASURED per-column needs.
//
// Widths are now PER SECTION (one pixel table each, summing to the 720px
// content column), so each section is plain arithmetic: every non-SITE
// column gets its measured need + headroom + padding, SITE takes the true
// remainder. The old shared-weight table made 9-column GE the binding
// constraint and paid every other section's overshoot out of SITE; solving
// per section releases that overshoot back to SITE.
//
// Needs come from dev/colbudget.js against a live render; update them there
// and re-run. SYSTEM is the exception: its "need" is a CHOSEN budget, not a
// measurement — the customer-id line steps its font down to fit whatever
// width this buys (cell_system in fleet_page.js), so system width decides
// how many customer ids render at full 8pt. The values below fit every
// current id (May 2026 fleet) in full at 6pt or larger everywhere except
// GE, where SITE cannot afford more and the longest tags ellipsise.
// Usage: node sme_reports/dev/solve_widths.js
const CONTENT_PX = 720; // 7.5in content column at 96dpi
const PAD = 0.035 * 96 * 2; // td horizontal padding, both sides
const HEADROOM = 4; // px of tolerance kept in every non-SITE column

// Measured widest rendered line per column per section (px), live fleet +
// scoped renders, taking the larger where the check fixture exceeded live.
//
// `line` is 74 everywhere, which is the width of "VS ALERT LIMIT" — the header
// a section wears when it MIXES centered-band rows with one-sided ones. It is
// the widest of that column's three possible headers ("% OF LIMIT" 54,
// "WITHIN BAND" 66) and it is the one that got missed: mixed mode needs a
// banded row beside a non-banded one in the same vendor section, which neither
// the check fixture nor a single-customer probe produced. It first appeared in
// a real customer document (Senator International), truncating by 5px. Every
// header is protected, so this is sized for the worst header the column can
// wear rather than the one today's data happens to show.
// `compressor` is 78 everywhere: the cell is two-line with CAPPED history
// text (fleet_page.js cell_compressor), so its widest possible content is
// the measured "99+ evt · 999+h" second line at 7pt — 78px — not whatever
// the worst record happens to produce. The one-line era sized this column
// by the fixture's mild "2 evt · 12.5h" and clipped valid extremes.
// EDU channel columns are sized for their widest bounded line: a STALE
// cell's "118.2 °F · Aug 26" top line (93.3px measured in Chromium) — the
// date rides beside the value so the range line survives staleness.
const NEEDS = {
  PHILIPS: { system: 100, condition: 110, primary: 65, line: 74, helium: 70, compressor: 78, temp_alarm: 33 },
  GE: { system: 70, condition: 110, primary: 65, line: 74, helium: 77, coldhead: 40, shield: 41, compressor: 78 },
  SIEMENS: { system: 100, condition: 110, primary: 65, line: 74, helium: 70, coldhead: 40, compressor: 78 },
  SIEMENS_NON_TIM: { system: 100, condition: 110, primary: 65, line: 74, helium: 70, cabinet: 41, compressor: 78 },
  EDU: { system: 100, edu_room: 94, edu_humidity: 94, edu_probe_0: 94, edu_probe_1: 94 }
};

// Column order per section must match fleet_model.js SECTIONS (EDU's is
// built inline in build_fleet_model).
const SETS = {
  PHILIPS: ["system", "site", "condition", "primary", "line", "helium", "compressor", "temp_alarm"],
  GE: ["system", "site", "condition", "primary", "line", "helium", "coldhead", "shield", "compressor"],
  SIEMENS: ["system", "site", "condition", "primary", "line", "helium", "coldhead", "compressor"],
  SIEMENS_NON_TIM: ["system", "site", "condition", "primary", "line", "helium", "cabinet", "compressor"],
  EDU: ["system", "site", "edu_room", "edu_humidity", "edu_probe_0", "edu_probe_1"]
};

console.log("SECTION_W (paste into fleet_page.js):");
for (const key of Object.keys(SETS)) {
  const w = {};
  let fixed = 0;
  for (const c of SETS[key]) {
    if (c === "site") continue;
    w[c] = Math.round(NEEDS[key][c] + HEADROOM + PAD);
    fixed += w[c];
  }
  w.site = CONTENT_PX - fixed;
  const parts = SETS[key].map((c) => `${c}: ${w[c]}`).join(", ");
  console.log(`  ${key}: { ${parts} },`);
  for (const c of SETS[key]) {
    const got = w[c] - PAD;
    const need = c === "site" ? null : NEEDS[key][c];
    console.log(
      `    // ${c.padEnd(11)} ${got.toFixed(1).padStart(6)}px content` +
        (need === null
          ? "   <- takes the remainder; truncates by design"
          : `  need ${String(need).padStart(3)}  headroom ${(got - need).toFixed(1)}`)
    );
  }
}

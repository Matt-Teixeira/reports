// GE Insights viewers: shared helpers for the independent-SQL verifiers
// (ct/verify.js, cv/verify.js; hhm_rpp_ge PLAN-CV-INSIGHTS.md §13.3 Q1).
// Moved out of ct/verify.js unchanged.
//
//   const { checks, check } = checker();
//   const eq = check("fleet");          // a named check
//   eq(key, model_value, sql_value);    // one comparison
//   series(eq, key, model_arr, sql_arr) // one comparison per element
//
// Values are compared as canonical JSON (keys sorted; undefined = null), so
// key order never matters and a missing or extra key always does. Each
// verifier makes its own checker, so two verifiers in one process never
// share a list.

// JSON with sorted keys: key order never matters, a missing or extra key always does
const canon = (x) => JSON.stringify(x === undefined ? null : x, (k, v) =>
  (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key] === undefined ? null : v[key]])) : v));

function checker() {
  const checks = [];
  function check(name) {
    const c = { name, compared: 0, diffs: [] };
    checks.push(c);
    return (key, model, sql) => {
      c.compared++;
      const a = canon(model), b = canon(sql);
      if (a !== b) c.diffs.push({ key, model: a, sql: b });
    };
  }
  return { checks, check };
}

// element by element for a per-day series (one comparison per day)
function series(eq, key, arr, want) {
  const n = Math.max(arr ? arr.length : 0, want.length);
  for (let i = 0; i < n; i++) eq(`${key}[${i}]`, arr ? arr[i] : null, want[i]);
}

const r3 = (x) => (x === null || x === undefined ? null : Math.round(1000 * x) / 1000);
const num = (x) => (x === null || x === undefined ? null : Number(x));
const msOf = (t) => (t === null || t === undefined ? null : new Date(t).getTime());
// The viewers' periods (ct/model.js PERIODS) as SQL rows.
const PERIOD_SQL = "(VALUES ('30d', 30), ('90d', 90), ('6mo', 183), ('all', NULL::int)) p(key, days)";
const SEV_RANK = "CASE severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 WHEN 'info' THEN 0 END";

// The per-check table, the first differences and the verdict, as lines.
function report_lines(checks, max_diffs) {
  const out = [];
  const w = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) out.push(`  ${c.name.padEnd(w)}  ${String(c.compared).padStart(7)} compared  ${String(c.diffs.length).padStart(4)} diffs`);
  const diffs = checks.flatMap((c) => c.diffs.map((d) => ({ check: c.name, ...d })));
  if (diffs.length) {
    out.push("", `DIFFERENCES (${diffs.length}; first ${Math.min(diffs.length, max_diffs)}):`);
    for (const d of diffs.slice(0, max_diffs)) out.push(`  [${d.check}] ${d.key}\n      model ${d.model}\n      sql   ${d.sql}`);
  }
  out.push("", diffs.length ? `FAIL: ${diffs.length} differences` : `ALL CHECKS PASS: 0 differences in ${checks.reduce((s, c) => s + c.compared, 0)} comparisons`);
  return { lines: out, diffs: diffs.length };
}

module.exports = { canon, checker, series, r3, num, msOf, PERIOD_SQL, SEV_RANK, report_lines };

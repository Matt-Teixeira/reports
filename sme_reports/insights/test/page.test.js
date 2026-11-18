// node sme_reports/insights/test/page.test.js   (no DB)
// The shared viewer code (PLAN-CV-INSIGHTS.md §13.3 Q1): the client
// assembler, the checker, and that the CT parts file fills every marker.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const P = require("../page");
const V = require("../verify_core");

const PARTS = (o = {}) => ["doc line\n", ...P.MARKERS.map((k) => `//@@${k}@@\n${o[k] ?? `/*${k}*/\n`}`)].join("");
const CORE = "core doc\n//@@header@@\nA\n//@@charts@@\nB\n//@@panel-keys@@\nC\n//@@panels@@\nD\n";

test("assemble_client puts each section in place of its marker and drops the docs", () => {
  assert.strictEqual(P.assemble_client(PARTS(), CORE), "/*header*/\nA\n/*charts*/\nB\n/*panel-keys*/\nC\n/*panels*/\nD\n");
  // replacement text is literal ($& and $1 are not patterns)
  assert.strictEqual(P.assemble_client(PARTS({ charts: "x = '$&$1';\n" }), CORE), "/*header*/\nA\nx = '$&$1';\nB\n/*panel-keys*/\nC\n/*panels*/\nD\n");
});

test("assemble_client refuses a missing, repeated or unknown section, and a bad core", () => {
  assert.throws(() => P.assemble_client(PARTS().replace("//@@panels@@\n/*panels*/\n", ""), CORE), /no panels section/);
  assert.throws(() => P.assemble_client(PARTS() + "//@@charts@@\nx\n", CORE), /repeated section charts/);
  assert.throws(() => P.assemble_client(PARTS() + "//@@extra@@\nx\n", CORE), /bad or repeated section extra/);
  assert.throws(() => P.assemble_client(PARTS(), CORE.replace("//@@header@@\n", "")), /no header marker/);
  assert.throws(() => P.assemble_client(PARTS(), CORE + "//@@charts@@\n"), /exactly one charts marker/);
  assert.throws(() => P.assemble_client(PARTS({ charts: "  \n" }), CORE), /the charts section is empty/);
  // a marker-like line inside a section is a section boundary, so the parts
  // file cannot smuggle one through; a stray marker in the core is caught
  assert.throws(() => P.assemble_client(PARTS(), CORE.replace("D\n", "D\n//@@stray@@\n")), /marker line is left/);
});

test("the CT client assembles from the real core with no marker left", () => {
  const js = P.assemble_client(fs.readFileSync(path.join(__dirname, "..", "..", "ct", "ct.client.js"), "utf8"));
  assert.ok(js.startsWith("/* Client for the GE CT Insights viewer"));
  assert.ok(!/\/\/@@[a-z-]+@@/.test(js), "no marker left");
  assert.ok(js.trimEnd().endsWith("})();"));
  new Function(js); // parses
});

test("checker: canonical comparison, separate lists per checker", () => {
  const a = V.checker(), b = V.checker();
  const eq = a.check("x");
  eq("k1", { p: 1, q: 2 }, { q: 2, p: 1 });
  eq("k2", { p: 1 }, { p: 1, q: null });
  eq("k3", undefined, null);
  V.series(eq, "s", [1, 2], [1, 3, 4]);
  assert.strictEqual(a.checks[0].compared, 6);
  assert.deepStrictEqual(a.checks[0].diffs.map((d) => d.key), ["k2", "s[1]", "s[2]"]);
  assert.strictEqual(b.checks.length, 0);
  const r = V.report_lines(a.checks, 1);
  assert.strictEqual(r.diffs, 3);
  assert.ok(r.lines.at(-1) === "FAIL: 3 differences");
});

test("tile and open_cell are the CT markup", () => {
  assert.strictEqual(P.tile("K", "V", "S", "warn"), '    <div class="tile warn"><div class="k">K</div><div class="v">V</div><div class="s">S</div></div>');
  assert.strictEqual(P.open_cell({ high: 1, medium: 0, low: 0, info: 0 }), '<span class="sevs"><span class="sevn high" title="1 high">1 H</span></span>');
});

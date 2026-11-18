// node sme_reports/cv/test/privacy.test.js   (no DB)
// The privacy guard (cv/privacy.js; review CV6-DATA-MODEL F3), on the
// review's examples, GE's own wording, and the prod fixture.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const G = require("../privacy");

const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures", "cv_fixture.json.gz"))).toString("utf8"));
const code = (label, sourcefile = "a.c") => [{ code: "1", label, sourcefile }];

test("the review's examples are refused, in labels and in source files", () => {
  for (const sf of ["192.168.1.2", "name@example.org", "dir/a.c", "D:\\build\\a.c"]) assert.ok(G.check_code_text(code("x", sf)).length, `source file ${sf}`);
  for (const lb of ["see /private/internal/build/file.cpp", "from SME#", "from SME01234", "peer 10.0.0.12", "peer #.#.#.#", "ops@example.com", "\\\\host\\share", "C:/x", "node db1.example.org"]) {
    assert.ok(G.check_code_text(code(lb)).length, `label ${lb}`);
  }
});

test("GE's own wording passes", () => {
  for (const lb of ["Table encoder / potentiometer failure", "Empty FOV List error @ UserProtocolController.cxx #", "LIFT COLLISION (T:0x# H:0x# U:0x#).",
    "Dose Export logger - Debug text:Association rejected, Minor code:MC_ASSOCIATION_REJECTED, Note:", "[Apollo_Camera::_OffsetFactoryTask] mean value for offset [#, #] = #.#"]) {
    assert.deepStrictEqual(G.check_code_text(code(lb)), [], lb);
  }
  assert.deepStrictEqual(G.check_code_text(code(null, null)), []);
});

test("evidence: the current rules' vocabulary passes; free text and odd keys do not", () => {
  assert.deepStrictEqual(G.check_evidence(fx.findings), []);
  const f = fx.findings[0];
  assert.ok(G.check_evidence([{ ...f, evidence: { ...f.evidence, note: "called from host xr-01" } }]).length);
  assert.ok(G.check_evidence([{ ...f, evidence: { ...f.evidence, "Bad Key": 1 } }]).length);
  assert.ok(G.check_evidence([{ ...f, evidence: { ...f.evidence, last: { ...f.evidence.last, top_codes: [{ n: 1, code: "1050170 extra" }] } } }]).length);
});

test("the prod fixture is clean, and assert_clean throws with the problems listed", () => {
  assert.deepStrictEqual(G.check_code_text(fx.codes), []);
  assert.doesNotThrow(() => G.assert_clean(fx, "fixture"));
  assert.throws(() => G.assert_clean({ codes: code("from SME#"), findings: [] }, "the page"), /the page: not written.*system id/s);
});

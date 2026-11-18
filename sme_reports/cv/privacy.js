// Privacy guard for the GE CV viewer's text (hhm_rpp_ge PLAN-CV-INSIGHTS.md
// §13.1 privacy; review CV6-DATA-MODEL F3). Used by the fixture tool and by
// the real build (cv/cli.js): either refuses to write when it fails.
//
// It guards the vocabulary that was reviewed, not every possible leak:
//   - code labels and source files (api.ge_cv_codes_v) must not look like an
//     IP address (also masked, #.#.#.#), an email address, a drive, UNC or
//     absolute Unix path, a dotted host name, or a system id (also masked,
//     SME#); a source file must also be a base name (no path separator);
//   - finding evidence must use the current rules' vocabulary: identifier
//     keys; string values that are days, codes, cv.* metric keys, severities
//     or identifier-like dims. Anything else means a rule or catalog change,
//     which needs a new review before a build.
// Labels may keep GE's own "a/b" and "error @ <file>" wording.

const TEXT_SUSPECT = [
  ["an IPv4 address", /\b\d{1,3}(\.\d{1,3}){3}\b/],
  ["a masked IPv4 address", /#\.#\.#\.#/],
  ["an email address", /[\w.+-]+@[\w-]+(\.[\w-]+)+/],
  ["a drive or UNC path", /\\\\|\b[A-Za-z]:[\\/]/],
  ["an absolute Unix path", /(^|[\s(["'=:,])\/[\w.-]+\/[\w./-]*/],
  ["a dotted host name", /\b[A-Za-z][\w-]*\.[A-Za-z][\w-]*\.[A-Za-z]{2,}\b/],
  ["a system id", /\bSME[#\d]+/i]
];

// Returns the problems (empty when clean). rows: api.ge_cv_codes_v rows
// ({ code, label, sourcefile }).
function check_code_text(rows) {
  const out = [];
  for (const c of rows) {
    for (const [field, v] of [["label", c.label], ["sourcefile", c.sourcefile]]) {
      if (v === null || v === undefined) continue;
      for (const [what, re] of TEXT_SUSPECT) if (re.test(String(v))) out.push(`code ${c.code}: the ${field} looks like it carries ${what}`);
    }
    if (c.sourcefile && /[\\/]/.test(c.sourcefile)) out.push(`code ${c.code}: the source file is not a base name`);
  }
  return out;
}

const EV_KEY = /^[a-z][a-z0-9_]*$/;
const EV_STRING = [
  /^\d{4}-\d{2}-\d{2}$/, // a device day
  /^\d{1,9}$/, // an error code
  /^cv\.[a-z_]+$/, // a metric key
  /^(info|low|medium|high)$/, // a severity
  /^[A-Za-z_][A-Za-z0-9_]{0,40}$/ // a dim: an operation, axis, part or kind
];
// Returns the problems (empty when clean). findings: api.ge_cv_findings_v rows.
function check_evidence(findings) {
  const out = [];
  for (const f of findings) {
    const where = `${f.system_id} ${f.finding_key}`;
    const walk = (x, path) => {
      if (x === null || typeof x === "number" || typeof x === "boolean") return;
      if (typeof x === "string") {
        if (!EV_STRING.some((re) => re.test(x))) out.push(`${where}: evidence ${path} holds text outside the reviewed vocabulary`);
        return;
      }
      if (Array.isArray(x)) { x.forEach((y, i) => walk(y, `${path}[${i}]`)); return; }
      if (typeof x === "object") {
        for (const [k, v] of Object.entries(x)) {
          if (!EV_KEY.test(k)) out.push(`${where}: evidence key ${path}.${k} is not an identifier`);
          walk(v, `${path}.${k}`);
        }
        return;
      }
      out.push(`${where}: evidence ${path} has an unexpected type`);
    };
    walk(f.evidence, "evidence");
  }
  return out;
}

// Throws with every problem listed.
function assert_clean(raw, what) {
  const problems = [...check_code_text(raw.codes || []), ...check_evidence(raw.findings || [])];
  if (problems.length) throw new Error(`${what}: not written, the privacy guard found ${problems.length} problem(s); review before building:\n  ${problems.slice(0, 20).join("\n  ")}`);
}

module.exports = { check_code_text, check_evidence, assert_clean, TEXT_SUSPECT };

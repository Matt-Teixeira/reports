// Who a System Activity page is for, and who may receive one
// (PLAN-FLEET-SYSTEM-PAGES.md). Pure — no DB, no logger — so the request
// loader, the one-off config and the scheduled-config validator
// (fanout.js, checked DB-free by dev/check_config.js) all apply the SAME
// rules.
//
// Two audiences:
//   internal — for Avante: every recipient, Avante staff included, grouped
//              under "Avante". The fleet summary's default.
//   external — for the customer: every Avante user scrubbed before anything
//              is counted (incident/scrub.js). The default for a scoped
//              (customer) summary.
// The setting is true (audience follows the summary: fleet → internal,
// scoped → external), "internal", "external", or false/absent (no pages).

const AUDIENCES = ["internal", "external"];

// PILOT GATE (2026-10-20): while the pages are being proven on real
// schedules, every run that emails them may address ONLY these people —
// To and CC alike. A run aimed anywhere else fails at validation, before
// any work. Widen this list deliberately, in code review, when the pages
// are cleared for customers. Lowercase; matching is case-insensitive.
// 2026-10-20: Joe Anello and Jonathan Pope added for the Friday C0137
// pilot rows.
const PILOT_RECIPIENTS = ["matt.teixeira@avantehs.com", "joe.anello@avantehs.com", "jonathan.pope@avantehs.com"];

// PERMANENT: an internal page names Avante staff, so it only ever goes to
// Avante mailboxes — strictly the company domain, not the broad /avante/i
// the scrub uses (that rule is built to over-match).
const AVANTE_MAILBOX = /@avantehs\.com$/i;

// raw setting -> false | true | "internal" | "external", or throws.
const normalize_system_pages = (value, at, fail) => {
  if (value === undefined || value === null || value === false) return false;
  if (value === true || AUDIENCES.includes(value)) return value;
  return fail(`${at} must be true, false, "internal" or "external" (got ${JSON.stringify(value)})`);
};

// normalized setting + whether the run is customer-scoped -> null | audience.
const pages_audience = (setting, { scoped }) => {
  if (!setting) return null;
  if (setting === true) return scoped ? "external" : "internal";
  return setting;
};

// Every address a page run may email, checked against both rules. Returns
// an error message, or null when the envelope is allowed.
const page_envelope_error = (audience, recipients = [], cc_list = []) => {
  if (!audience) return null;
  const pilot = new Set(PILOT_RECIPIENTS.map((e) => e.toLowerCase()));
  const all = [...recipients, ...cc_list].map((e) => String(e).trim());
  const outside = all.filter((e) => !pilot.has(e.toLowerCase()));
  if (outside.length)
    return `System Activity pages are in pilot and may only be sent to ${PILOT_RECIPIENTS.join(", ")} — not ${outside.join(", ")}`;
  if (audience === "internal") {
    const external = all.filter((e) => !AVANTE_MAILBOX.test(e));
    if (external.length) return `internal System Activity pages may only be sent to @avantehs.com addresses — not ${external.join(", ")}`;
  }
  return null;
};

module.exports = {
  AUDIENCES,
  PILOT_RECIPIENTS,
  AVANTE_MAILBOX,
  normalize_system_pages,
  pages_audience,
  page_envelope_error
};

// Request scope -> concrete magnet systems (PLAN-SCOPED-WEEKLY.md A1).
//
// A scope names WHO a report set is about — a customer, a set of sites, or
// an explicit system list — and resolves through the canonical hierarchy
// (customers -> sites -> systems, process_mag only). Resolution is LOUD,
// never silent: the caller logs the label and count, the fleet cover states
// them, and resolving to zero systems is a fatal request error rather than
// an empty report. A missed scope that silently dropped a customer's
// magnets would be this feature's worst failure mode.
//
// validate_scope and rows_to_resolution are pure so the dev checks exercise
// every shape without a database; resolve_scope is the thin live wrapper.

const SME_RE = /^SME\d+$/;

const fail = (msg) => {
  throw new Error(`sme_report scope invalid: ${msg}`);
};

// Exactly one recognized key, correctly typed. Returns a canonical
// { kind, value } so downstream code never re-inspects raw JSON.
// IDEMPOTENT: an already-canonical scope passes through re-validation —
// the loader canonicalizes at load time and resolve_scope validates its
// input, so the same object legitimately crosses this function twice.
const validate_scope = (scope) => {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope))
    fail("scope must be an object");
  const known = ["customer_id", "site_ids", "system_ids"];
  if (
    known.includes(scope.kind) &&
    scope.value !== undefined &&
    Object.keys(scope).length === 2
  )
    return validate_scope({ [scope.kind]: scope.value });
  const keys = Object.keys(scope);
  const present = known.filter((k) => scope[k] !== undefined);
  if (present.length !== 1)
    fail(
      `scope must carry exactly one of ${known.join(", ")} (got ${keys.join(", ") || "nothing"})`
    );
  const kind = present[0];
  const value = scope[kind];
  if (kind === "customer_id") {
    if (typeof value !== "string" || !value.trim())
      fail("scope.customer_id must be a non-empty string");
    return { kind, value: value.trim() };
  }
  if (!Array.isArray(value) || value.length === 0)
    fail(`scope.${kind} must be a non-empty array`);
  for (const v of value)
    if (typeof v !== "string" || !v.trim()) fail(`scope.${kind} entries must be strings`);
  if (kind === "system_ids")
    for (const v of value)
      if (!SME_RE.test(v)) fail(`scope.system_ids entry "${v}" is not a system id`);
  return { kind, value: value.map((v) => v.trim()) };
};

// Resolved rows -> { system_ids, label, detail }. Pure. Throws on zero
// systems, and — for explicit shapes — on requested ids that resolved to
// nothing (a typo'd site or a non-mag system must fail loudly, not shrink
// the report).
const rows_to_resolution = ({ kind, value }, rows) => {
  if (!rows.length)
    fail(`scope ${kind}=${JSON.stringify(value)} resolved to no mag-processed systems`);
  if (kind === "site_ids") {
    const seen = new Set(rows.map((r) => r.site_id));
    const missing = value.filter((id) => !seen.has(id));
    if (missing.length)
      fail(`scope.site_ids not found (or no mag systems): ${missing.join(", ")}`);
  }
  if (kind === "system_ids") {
    const seen = new Set(rows.map((r) => r.system_id));
    const missing = value.filter((id) => !seen.has(id));
    if (missing.length)
      fail(`scope.system_ids not found (or not mag-processed): ${missing.join(", ")}`);
  }
  const customers = [...new Set(rows.map((r) => r.customer_name))];
  const sites = [...new Set(rows.map((r) => r.site_id))];
  // Display label: the customer's name where the scope is one customer
  // (the overwhelmingly common case); otherwise the customers joined.
  const label = customers.join(" / ");
  return {
    system_ids: rows.map((r) => r.system_id),
    label,
    detail: {
      kind,
      customers: customers.length,
      sites: sites.length,
      systems: rows.length
    }
  };
};

const resolve_scope = async (scope) => {
  const canonical = validate_scope(scope);
  // Lazy requires: this module is imported by the request loader, which the
  // DB-free dev checks exercise — the pg pool must not load (it reads env
  // and certs at require time) unless a live resolution actually runs.
  const db = require("../utils/db/pg-pool");
  const { scope_systems } = require("./sql/sql");
  const rows = await db.any(scope_systems, [
    canonical.kind === "customer_id" ? canonical.value : null,
    canonical.kind === "site_ids" ? canonical.value : null,
    canonical.kind === "system_ids" ? canonical.value : null
  ]);
  return rows_to_resolution(canonical, rows);
};

module.exports = { validate_scope, rows_to_resolution, resolve_scope };

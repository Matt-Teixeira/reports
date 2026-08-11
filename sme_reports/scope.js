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
  // EXACTLY one key, and it must be recognized (review round-1 F6: a
  // recognized key beside an unknown one — {customer_id, typo_filter} —
  // was accepted as the recognized scope alone, silently ignoring the
  // extra selector; a typo must never broaden a scope).
  const keys = Object.keys(scope);
  if (keys.length !== 1 || !known.includes(keys[0]))
    fail(
      `scope must carry exactly one of ${known.join(", ")} (got ${keys.join(", ") || "nothing"})`
    );
  const kind = keys[0];
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
  const system_ids = rows.map((r) => r.system_id);
  return {
    system_ids,
    label,
    // Stable identity of the resolved SET, independent of the label: two
    // different scopes under one customer share a label but must never
    // share artifact names (review round-1 F2).
    scope_hash: scope_set_hash(system_ids),
    detail: {
      kind,
      customers: customers.length,
      sites: sites.length,
      systems: rows.length
    }
  };
};

// One hash formula for a system-id SET, order-independent — the identity
// carried by artifact filenames and the sends table's scope_hash. 16 hex
// chars (64 bits): review B round-1 F3 demonstrated a REAL first-8-hex
// collision between two plausible system ids, and a filename collision
// overwrites another scope's document. The hash is metadata — grouping
// identity uses the full canonical id set (scope_set_key), never the hash.
const scope_set_hash = (ids) =>
  require("crypto")
    .createHash("sha1")
    .update([...ids].sort().join(","))
    .digest("hex")
    .slice(0, 16);

const scope_set_key = (ids) => [...ids].sort().join(",");

// The filename identity of a scoped run: human-readable slug + the
// scope-set hash. The hash keeps same-label-different-scope runs (and
// same-day reruns of different subsets) from overwriting each other's
// documents and history sidecars; the "Scoped" fallback keeps a label
// with no ASCII word characters (an empty slug) from ever falling back to
// the INTERNAL fleet artifact names.
const scope_artifact_id = (resolution) => {
  // Slug capped: a multi-customer label ("A / B / C / …") must not push
  // the filename past filesystem/attachment-name comfort — the hash, not
  // the slug, carries the identity.
  const slug = String(resolution.label || "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return `${slug || "Scoped"}-${resolution.scope_hash}`;
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

module.exports = {
  validate_scope,
  rows_to_resolution,
  resolve_scope,
  scope_set_hash,
  scope_set_key,
  scope_artifact_id
};

const assert = require("assert");

// Scheduled-run (DB-config) logic — PLAN-SCOPED-WEEKLY.md B2/B3 — exercised
// without a database: config validation, audience resolution, scope
// grouping, the send-time access re-check, and the row -> raw-request
// translation through the REAL loader.

const {
  validate_config,
  resolve_audience,
  group_by_scope,
  access_covers,
  config_to_raw
} = require("../fanout");
const { scope_set_hash } = require("../scope");
const { materialize_scoped_requests } = require("../request_loader");

// --- validate_config ---------------------------------------------------------
{
  const base = {
    id: 1,
    report_kind: "user_summary",
    scope: { all_users: true },
    lookback_days: 7,
    options: {},
    recipient_mode: "derived",
    recipients: null,
    cc_list: null,
    dry_run: true
  };
  const cfg = validate_config(base);
  assert.strictEqual(cfg.kind, "user_summary");
  assert.strictEqual(cfg.dry_run, true);
  assert.deepStrictEqual(cfg.recipients, []);

  const customer = validate_config({
    ...base,
    id: 2,
    report_kind: "customer_summary",
    scope: { customer_id: "C0151" },
    recipient_mode: "explicit",
    recipients: ["ops@example.com"],
    dry_run: false
  });
  assert.strictEqual(customer.dry_run, false);

  validate_config({
    ...base,
    id: 3,
    report_kind: "fleet_summary",
    scope: null,
    lookback_days: 30,
    recipient_mode: "explicit",
    recipients: ["ops@example.com"],
    options: { exclude: ["SME10844"] }
  });

  const bad = [
    [{ ...base, report_kind: "briefs" }, /not implemented/],
    [{ ...base, report_kind: "mystery" }, /unknown report_kind/],
    [{ ...base, options: { typo: true } }, /unknown option "typo"/],
    [{ ...base, options: { include_briefs: true } }, /include_briefs is not implemented/],
    [{ ...base, options: { exception_only: true } }, /exception_only is not implemented/],
    [{ ...base, options: { exclude: "SME1" } }, /exclude must be an array/],
    [{ ...base, lookback_days: 0 }, /positive integer/],
    [{ ...base, scope: { all_users: true, extra: 1 } }, /requires scope/],
    [{ ...base, scope: { customer_id: "C1" } }, /requires scope \{"all_users": true\}/],
    [{ ...base, recipient_mode: "explicit", recipients: ["a@b.co"] }, /requires recipient_mode "derived"/],
    [
      { ...base, report_kind: "customer_summary", scope: { customer_id: "C1" }, recipient_mode: "derived" },
      /requires recipient_mode "explicit"/
    ],
    [
      { ...base, report_kind: "customer_summary", scope: null, recipient_mode: "explicit", recipients: ["a@b.co"] },
      /requires a scope/
    ],
    [
      { ...base, report_kind: "fleet_summary", scope: { customer_id: "C1" }, recipient_mode: "explicit", recipients: ["a@b.co"] },
      /takes no scope/
    ],
    [
      { ...base, report_kind: "fleet_summary", scope: null, recipient_mode: "explicit", recipients: [] },
      /explicit recipients required/
    ],
    [
      { ...base, report_kind: "fleet_summary", scope: null, recipient_mode: "explicit", recipients: ["not-an-email"] },
      /not an email address/
    ]
  ];
  for (const [row, re] of bad)
    assert.throws(() => validate_config(row), re, JSON.stringify(row.options || row.scope || row.report_kind));
}

// --- resolve_audience --------------------------------------------------------
{
  const mag = ["SME00001", "SME00002", "SME00003"];
  const users = [
    // Qualifies; cache carries a duplicate and a non-mag system.
    { email_address: "a@x.co", status: "active", notify_email: true, system_list_cache: ["SME00002", "SME00001", "SME00002", "OTHER1"] },
    // Inactive, invited, opted out, magnet-less: all excluded.
    { email_address: "b@x.co", status: "deactivated", notify_email: true, system_list_cache: mag },
    { email_address: "c@x.co", status: "invited", notify_email: true, system_list_cache: mag },
    { email_address: "d@x.co", status: "active", notify_email: false, system_list_cache: mag },
    { email_address: "e@x.co", status: "active", notify_email: true, system_list_cache: ["OTHER2"] },
    { email_address: "f@x.co", status: "active", notify_email: true, system_list_cache: null }
  ];
  const audience = resolve_audience(users, mag);
  assert.strictEqual(audience.length, 1);
  assert.deepStrictEqual(audience[0], { email: "a@x.co", scope_ids: ["SME00001", "SME00002"] });
}

// --- group_by_scope ----------------------------------------------------------
{
  const audience = [
    { email: "a@x.co", scope_ids: ["SME00001", "SME00002"] },
    { email: "b@x.co", scope_ids: ["SME00001", "SME00002"] },
    { email: "c@x.co", scope_ids: ["SME00003"] }
  ];
  const groups = group_by_scope(audience);
  assert.strictEqual(groups.length, 2, "identical scopes share one document");
  assert.deepStrictEqual(groups[0].users, ["a@x.co", "b@x.co"], "largest group first");
  assert.strictEqual(
    groups[0].scope_hash,
    scope_set_hash(["SME00001", "SME00002"]),
    "group hash uses the shared scope-set formula"
  );
}

// --- access_covers -----------------------------------------------------------
{
  assert.strictEqual(access_covers(["SME1", "SME2", "SME3"], ["SME1", "SME2"]), true);
  assert.strictEqual(access_covers(["SME1"], ["SME1", "SME2"]), false, "a narrowed cache blocks the wider document");
  assert.strictEqual(access_covers(null, ["SME1"]), false);
  assert.strictEqual(access_covers(["SME1"], []), true);
}

// --- config_to_raw -> the real loader ---------------------------------------
{
  const cfg = {
    id: 9,
    kind: "user_summary",
    scope: { all_users: true },
    lookback_days: 7,
    options: {},
    recipient_mode: "derived",
    recipients: [],
    cc_list: [],
    dry_run: true
  };
  const raw = config_to_raw(cfg, { recipients: ["a@x.co", "b@x.co"] });
  assert.strictEqual(raw.scope, undefined, "user_summary groups carry ids, not the all_users scope");
  assert.strictEqual(raw.summary_only, true);
  assert.strictEqual(raw.batch_email.summary, false, "delivery belongs to the send loop, not run_batch");
  assert.strictEqual(raw.batch_email.summary_pdf, true);
  assert.strictEqual(raw.batch_email.archive_records, false, "dry runs never archive history");
  const loaded = materialize_scoped_requests(raw, ["SME00001", "SME00002"]);
  assert.strictEqual(loaded.lookback_days, 7, "the config period reaches the batch");
  assert.deepStrictEqual(loaded.requests.map((r) => r.system_id), ["SME00001", "SME00002"]);
  for (const r of loaded.requests) {
    assert.strictEqual(r.output.html, false, "summary-only: no per-system renders");
    assert.strictEqual(r.output.email, false);
    assert.deepStrictEqual(r.recipients, ["a@x.co", "b@x.co"], "batch recipients flow to members");
  }

  // A live (non-dry) fleet config archives history and carries exclusions.
  const fleet_raw = config_to_raw(
    { ...cfg, kind: "fleet_summary", scope: null, dry_run: false, options: { exclude: ["SME00002"] } },
    { recipients: ["ops@x.co"] }
  );
  assert.strictEqual(fleet_raw.batch_email.archive_records, true);
  const fleet_loaded = materialize_scoped_requests(fleet_raw, ["SME00001", "SME00002"]);
  assert.deepStrictEqual(fleet_loaded.requests.map((r) => r.system_id), ["SME00001"]);
  assert.deepStrictEqual(fleet_loaded.excluded, { ids: ["SME00002"], note: "excluded by report config" });
}

console.log("check_config: all assertions passed");

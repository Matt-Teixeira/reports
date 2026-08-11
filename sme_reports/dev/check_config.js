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
  config_to_raw,
  smtp_outcomes
} = require("../fanout");
const { scope_set_hash } = require("../scope");
const { materialize_scoped_requests } = require("../request_loader");
const { parse_sme_args } = require("../cli_args");

// --- CLI parsing (review B round-1 F2) --------------------------------------
{
  // A typo'd --config must ABORT — under the old truthy check, "abc"
  // became NaN and fell through to the LIVE slot batch.
  const bad = [
    [["--config", "abc"], /positive integer/],
    [["--config", "1junk"], /positive integer/],
    [["--config", "0"], /positive integer/],
    [["--config", "-3"], /positive integer/],
    [["--config"], /positive integer/],
    [["--slot", "monday-8am"], /day-HH:MM/],
    [["--slot", "mon-24:00"], /day-HH:MM/],
    [["--slot"], /day-HH:MM/],
    [["--conifg", "1"], /unknown argument/],
    // Round-2 audit: duplicate flags and unsafe-precision ids abort.
    [["--config", "1", "--config", "2"], /given twice/],
    [["--slot", "mon-08:00", "--slot", "tue-08:00"], /given twice/],
    [["--dry-run", "--dry-run"], /given twice/],
    [["--config", "9007199254740993"], /positive integer/],
    [["./requests/x.json", "--dry-run"], /file mode takes no scheduler flags/],
    [["a.json", "b.json"], /more than one request file/]
  ];
  for (const [args, re] of bad)
    assert.throws(() => parse_sme_args(args), re, JSON.stringify(args));
  assert.deepStrictEqual(parse_sme_args(["--config", "12", "--dry-run"]), {
    request_path: null,
    slot: null,
    config_id: 12,
    force_dry_run: true
  });
  assert.deepStrictEqual(parse_sme_args(["--slot", "mon-08:00"]), {
    request_path: null,
    slot: "mon-08:00",
    config_id: null,
    force_dry_run: false
  });
  assert.deepStrictEqual(parse_sme_args(["./requests/x.json"]), {
    request_path: "./requests/x.json",
    slot: null,
    config_id: null,
    force_dry_run: false
  });
  assert.deepStrictEqual(parse_sme_args([]), {
    request_path: null,
    slot: null,
    config_id: null,
    force_dry_run: false
  });
}

// The slot the runner computes matches the grid convention the configs use.
{
  const { current_slot } = require("../config_loader");
  assert.ok(
    /^(sun|mon|tue|wed|thu|fri|sat)-([01]\d|2[0-3]):[0-5]\d$/.test(current_slot()),
    `current_slot format: ${current_slot()}`
  );
}

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

  // Round-1 F1 (blocker): a CC on a derived row would receive every
  // scope-group's document with no access check.
  assert.throws(
    () => validate_config({ ...base, cc_list: ["audit@example.com"] }),
    /does not allow cc_list/
  );
  // A frontend double-entry must not double-send.
  const deduped = validate_config({
    ...base,
    id: 4,
    report_kind: "fleet_summary",
    scope: null,
    recipient_mode: "explicit",
    recipients: ["ops@example.com", "ops@example.com"],
    cc_list: ["cc@example.com", "cc@example.com"]
  });
  assert.deepStrictEqual(deduped.recipients, ["ops@example.com"]);
  assert.deepStrictEqual(deduped.cc_list, ["cc@example.com"]);
  // Round-2 F3: an address on BOTH lists stays a single To entry — one
  // email, one sends row, even with case drift.
  const cross = validate_config({
    ...base,
    id: 5,
    report_kind: "fleet_summary",
    scope: null,
    recipient_mode: "explicit",
    recipients: ["same@example.com"],
    cc_list: ["Same@Example.com", "other@example.com"]
  });
  assert.deepStrictEqual(cross.recipients, ["same@example.com"]);
  assert.deepStrictEqual(cross.cc_list, ["other@example.com"], "cross-list duplicate removed from CC");
  // Round-3 F1: case variants WITHIN one list are one recipient (first
  // spelling kept) — in both lists.
  const within = validate_config({
    ...base,
    id: 6,
    report_kind: "fleet_summary",
    scope: null,
    recipient_mode: "explicit",
    recipients: ["Same@example.com", "same@example.com"],
    cc_list: ["CC@example.com", "cc@example.com"]
  });
  assert.deepStrictEqual(within.recipients, ["Same@example.com"], "within-To case variants collapse");
  assert.deepStrictEqual(within.cc_list, ["CC@example.com"], "within-CC case variants collapse");

  const bad = [
    [{ ...base, report_kind: "briefs" }, /not implemented/],
    [{ ...base, options: ["x"] }, /options must be an object/],
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

  // Round-1 F3 (major): grouping identity is the canonical id SET, never
  // the hash. SME099875 and SME122693 collide on the first 8 hex chars of
  // sha1 — under hash-keyed grouping they merged into one group and one
  // user's real weekly landed in the skipped-access bin.
  const colliding = group_by_scope([
    { email: "p@x.co", scope_ids: ["SME099875"] },
    { email: "q@x.co", scope_ids: ["SME122693"] }
  ]);
  assert.strictEqual(colliding.length, 2, "hash-colliding scopes stay distinct groups");
  assert.deepStrictEqual(
    colliding.map((g) => g.system_ids),
    [["SME099875"], ["SME122693"]]
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

// --- smtp_outcomes (round-2 F1) ----------------------------------------------
{
  // Nodemailer resolves on PARTIAL rejection; each envelope address is
  // graded from the accepted list, case-insensitively, string or
  // {address} entries alike.
  const partial = smtp_outcomes(
    { accepted: ["A@x.co"], rejected: ["b@x.co"] },
    ["a@x.co", "b@x.co"]
  );
  assert.strictEqual(partial.get("a@x.co"), "sent");
  assert.strictEqual(partial.get("b@x.co"), "error");
  const objects = smtp_outcomes(
    { accepted: [{ address: "a@x.co" }], rejected: [] },
    ["a@x.co"]
  );
  assert.strictEqual(objects.get("a@x.co"), "sent");
  // Claiming delivery needs evidence: a missing/odd info shape grades
  // everyone as NOT delivered.
  const missing = smtp_outcomes(undefined, ["a@x.co"]);
  assert.strictEqual(missing.get("a@x.co"), "error");
}

console.log("check_config: all assertions passed");

const assert = require("assert");

// Scheduled-run (DB-config) logic — PLAN-SCOPED-WEEKLY.md B2/B3 — exercised
// without a database: config validation, audience resolution, scope
// grouping, the send-time access re-check, and the row -> raw-request
// translation through the REAL loader.

const {
  validate_config,
  coalesce_user_rows,
  resolve_audience,
  group_by_scope,
  plan_documents,
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
    [{ ...base, scope: { all_users: true, extra: 1 } }, /scope must be absent/],
    [{ ...base, scope: { customer_id: "C1" } }, /scope must be absent/],
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

// --- users-scope pilot variant + per-customer document plan ------------------
{
  // The pilot scope: named users only.
  const base = {
    id: 7,
    report_kind: "user_summary",
    scope: { users: ["Matt.Teixeira@avantehs.com"] },
    lookback_days: 7,
    options: {},
    recipient_mode: "derived",
    recipients: null,
    cc_list: null,
    dry_run: true
  };
  validate_config(base);
  for (const [scope, re] of [
    [{ users: [] }, /scope must be absent/],
    [{ users: ["not-an-email"] }, /scope must be absent/],
    [{ users: ["a@b.co"], all_users: true }, /scope must be absent/]
  ])
    assert.throws(() => validate_config({ ...base, scope }), re, JSON.stringify(scope));
  // The audience narrows case-insensitively, but every standing filter
  // still applies — a pilot user who opted out resolves to nothing.
  const users = [
    { email_address: "matt.teixeira@avantehs.com", status: "active", notify_email: true, system_list_cache: ["SME00001"] },
    { email_address: "other@x.co", status: "active", notify_email: true, system_list_cache: ["SME00001"] }
  ];
  const narrowed = resolve_audience(users, ["SME00001"], ["Matt.Teixeira@avantehs.com"]);
  assert.strictEqual(narrowed.length, 1);
  assert.strictEqual(narrowed[0].email, "matt.teixeira@avantehs.com");
  const opted_out = resolve_audience(
    [{ ...users[0], notify_email: false }],
    ["SME00001"],
    ["matt.teixeira@avantehs.com"]
  );
  assert.strictEqual(opted_out.length, 0, "pilot users are never force-mailed past their filters");

  // The per-customer plan: documents are (customer × subset) units, never
  // cross-customer merges; identical (customer, subset) pairs dedup.
  const sc = new Map([
    ["SME00001", { customer_id: "C1", customer_name: "Acme Health" }],
    ["SME00002", { customer_id: "C1", customer_name: "Acme Health" }],
    ["SME00003", { customer_id: "C2", customer_name: "Bravo Med" }]
  ]);
  const audience = [
    { email: "multi@x.co", scope_ids: ["SME00001", "SME00002", "SME00003"] },
    { email: "acme@x.co", scope_ids: ["SME00001", "SME00002"] },
    { email: "partial@x.co", scope_ids: ["SME00001"] }
  ];
  const { units, user_units } = plan_documents(audience, sc);
  // multi splits into C1+C2; acme SHARES multi's C1 unit; partial's C1
  // subset differs, so it is its own unit.
  assert.strictEqual(units.length, 3, "two C1 subsets + one C2 unit");
  assert.deepStrictEqual(user_units.get("multi@x.co").length, 2, "multi-customer user gets one doc per customer");
  const shared = units.find((u) => u.users.includes("acme@x.co"));
  assert.deepStrictEqual(shared.users.sort(), ["acme@x.co", "multi@x.co"], "identical (customer, subset) shares one render");
  for (const u of units) {
    const customers = new Set(u.system_ids.map((id) => sc.get(id).customer_id));
    assert.strictEqual(customers.size, 1, "no unit ever crosses a customer boundary");
    assert.strictEqual(u.customer_id, [...customers][0]);
  }
  // A system without a customer mapping is a loud data-integrity failure.
  assert.throws(
    () => plan_documents([{ email: "x@x.co", scope_ids: ["SME99999"] }], sc),
    /no customer mapping/
  );
}

// --- subscription rows + slot coalescing -------------------------------------
{
  const sub = (id, author, over = {}) => ({
    id,
    author,
    report_kind: "user_summary",
    scope: null,
    lookback_days: 7,
    options: {},
    recipient_mode: "derived",
    recipients: null,
    cc_list: null,
    dry_run: false,
    ...over
  });
  // A subscription row (scope absent) canonicalizes to its AUTHOR as the
  // audience — the frontend contract: one row per subscribed user.
  const cfg = validate_config(sub(10, "a@x.co"));
  assert.deepStrictEqual(cfg.scope, { users: ["a@x.co"] });
  assert.throws(
    () => validate_config(sub(11, "not-an-email")),
    /author must be an email address/
  );

  // Coalescing: same render inputs merge into one coalition; each user
  // attributes to THEIR OWN row and honors THEIR OWN dry_run gate.
  const a = validate_config(sub(10, "a@x.co"));
  const b = validate_config(sub(11, "b@x.co", { dry_run: true }));
  const [co] = coalesce_user_rows([b, a]); // order-independent (sorted by id)
  assert.strictEqual(co.cfgs.length, 2);
  assert.deepStrictEqual(co.allowed.sort(), ["a@x.co", "b@x.co"]);
  assert.strictEqual(co.owner_of("A@X.CO"), 10, "attribution is case-insensitive to the owning row");
  assert.strictEqual(co.owner_of("b@x.co"), 11);
  assert.strictEqual(co.dry_run_of("a@x.co"), false, "live subscriber stays live");
  assert.strictEqual(co.dry_run_of("b@x.co"), true, "dry subscriber stays dry in the same coalition");

  // Differing render inputs (lookback) form separate coalitions.
  const c = validate_config(sub(12, "c@x.co", { lookback_days: 30 }));
  assert.strictEqual(coalesce_user_rows([a, c]).length, 2, "different lookbacks never share a render");

  // An all_users row widens the audience to everyone (allowed null); named
  // subscribers still attribute to their own rows, everyone else to the
  // all_users row.
  const all = validate_config(sub(13, "ops@x.co", { scope: { all_users: true } }));
  const [wide] = coalesce_user_rows([a, all]);
  assert.strictEqual(wide.allowed, null);
  assert.strictEqual(wide.owner_of("a@x.co"), 10);
  assert.strictEqual(wide.owner_of("stranger@x.co"), 13);

  // A duplicate subscription (two rows naming one email) attributes to the
  // FIRST row by id — one delivery, one owner, never two emails.
  const dup = validate_config(sub(14, "a@x.co"));
  const [merged] = coalesce_user_rows([dup, a]);
  assert.strictEqual(merged.owner_of("a@x.co"), 10);
  assert.deepStrictEqual(merged.allowed, ["a@x.co"], "one audience entry despite two rows");
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

// --- fresh zip per send (subscriptions review F1 — CRITICAL) -----------------
// `zip` UPDATES an existing archive: a reused path retained the previous
// recipient's PDFs inside the next recipient's zip. build_fresh_zip must
// always produce an archive containing EXACTLY the requested files, even
// at a path where an older archive exists.
(async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { execFileSync } = require("child_process");
  const { build_fresh_zip } = require("../output/fresh_zip");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sme-zip-"));
  const mk = (name) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, name);
    return p;
  };
  const a1 = mk("customer-a-doc1.pdf");
  const a2 = mk("customer-a-doc2.pdf");
  const b1 = mk("customer-b-doc1.pdf");
  const zip_path = path.join(tmp, "digest.zip");
  await build_fresh_zip(zip_path, [a1, a2]);
  await build_fresh_zip(zip_path, [b1]); // same path, new recipient
  const listing = execFileSync("zip", ["-sf", zip_path]).toString();
  assert.ok(listing.includes("customer-b-doc1.pdf"), "new recipient's file present");
  assert.ok(
    !listing.includes("customer-a-doc1.pdf") && !listing.includes("customer-a-doc2.pdf"),
    `previous recipient's files must NOT survive: ${listing}`
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  // --- vendor registration completeness (fail-closed routing, phase 2) -----
  // Every vendor must carry a units query, and no orphan query may name a
  // vendor that does not exist — the lookup in data.fetch_units throws on a
  // miss, and this pins the registries to each other at check time.
  {
    const { VENDORS } = require("../vendors");
    const { units_queries } = require("../sql/sql");
    assert.deepStrictEqual(
      Object.keys(units_queries).sort(),
      Object.keys(VENDORS).sort(),
      "VENDORS and units_queries must register the same vendor keys"
    );
  }

  console.log("check_config: all assertions passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

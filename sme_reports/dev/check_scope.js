const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Scope resolution + scoped-request loading (PLAN-SCOPED-WEEKLY.md A1),
// exercised without a database: validate_scope and rows_to_resolution are
// pure, and the loader paths run on temp files. The SQL itself is verified
// by live probe (resolution results recorded in the plan doc).

const {
  validate_scope,
  rows_to_resolution,
  scope_artifact_id
} = require("../scope");
const {
  load_requests,
  materialize_scoped_requests
} = require("../request_loader");

// --- validate_scope ----------------------------------------------------------
{
  assert.deepStrictEqual(validate_scope({ customer_id: " C0151 " }), {
    kind: "customer_id",
    value: "C0151"
  });
  assert.deepStrictEqual(validate_scope({ site_ids: ["C002684"] }), {
    kind: "site_ids",
    value: ["C002684"]
  });
  assert.deepStrictEqual(validate_scope({ system_ids: ["SME01096", "SME01097"] }), {
    kind: "system_ids",
    value: ["SME01096", "SME01097"]
  });
  // Idempotent: the loader canonicalizes, then resolve_scope validates the
  // same object again — the canonical form must survive the round trip
  // (caught live: the double validation rejected its own output).
  assert.deepStrictEqual(
    validate_scope(validate_scope({ customer_id: "C0151" })),
    { kind: "customer_id", value: "C0151" }
  );
  const bad = [
    [null, "must be an object"],
    [[], "must be an object"],
    [{}, "exactly one of"],
    [{ customer_id: "C1", site_ids: ["S1"] }, "exactly one of"],
    [{ customer: "C1" }, "exactly one of"], // unknown key never silently ignored
    // Round-1 F6: a recognized key BESIDE an unknown one must fail — a
    // typo'd second selector must never silently broaden the scope.
    [{ customer_id: "C1", site_id: "S1" }, "exactly one of"],
    [{ customer_id: "C1", typo_filter: "C2" }, "exactly one of"],
    [{ customer_id: "  " }, "non-empty string"],
    [{ site_ids: [] }, "non-empty array"],
    [{ site_ids: [42] }, "must be strings"],
    [{ system_ids: ["NOTANID"] }, "not a system id"]
  ];
  for (const [scope, msg] of bad)
    assert.throws(() => validate_scope(scope), new RegExp(msg), JSON.stringify(scope));
}

// --- rows_to_resolution ------------------------------------------------------
{
  const rows = [
    { system_id: "SME01096", site_id: "S1", site_name: "Alpha", customer_id: "C1", customer_name: "Acme Health" },
    { system_id: "SME01097", site_id: "S2", site_name: "Beta", customer_id: "C1", customer_name: "Acme Health" }
  ];
  const res = rows_to_resolution({ kind: "customer_id", value: "C1" }, rows);
  assert.deepStrictEqual(res.system_ids, ["SME01096", "SME01097"]);
  assert.strictEqual(res.label, "Acme Health");
  assert.deepStrictEqual(res.detail, { kind: "customer_id", customers: 1, sites: 2, systems: 2 });

  // Zero systems is fatal — never an empty report.
  assert.throws(
    () => rows_to_resolution({ kind: "customer_id", value: "C9" }, []),
    /resolved to no mag-processed systems/
  );
  // A requested site or system that resolves to nothing is a loud error,
  // not a silently smaller report.
  assert.throws(
    () => rows_to_resolution({ kind: "site_ids", value: ["S1", "S9"] }, rows),
    /site_ids not found.*S9/
  );
  assert.throws(
    () => rows_to_resolution({ kind: "system_ids", value: ["SME01096", "SME99999"] }, rows),
    /system_ids not found.*SME99999/
  );
  // Multi-customer resolution (explicit system list spanning customers)
  // labels every customer, hiding none.
  const span = rows.concat([
    { system_id: "SME02000", site_id: "S3", site_name: "Gamma", customer_id: "C2", customer_name: "Bravo Med" }
  ]);
  const multi = rows_to_resolution(
    { kind: "system_ids", value: ["SME01096", "SME01097", "SME02000"] },
    span
  );
  assert.strictEqual(multi.label, "Acme Health / Bravo Med");
  assert.strictEqual(multi.detail.customers, 2);
}

// --- loader: scoped requests -------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sme-scope-"));
  const write = (name, obj) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, JSON.stringify(obj));
    return p;
  };

  // A scoped file loads to a pending resolution, not to requests.
  const scoped = load_requests(
    write("scoped.json", {
      scope: { customer_id: "C0151" },
      report_defaults: {
        recipients: ["dev@example.com"],
        output: { html: true, pdf: false, email: false, archive: false }
      }
    })
  );
  assert.strictEqual(scoped.scoped, true);
  assert.deepStrictEqual(scoped.scope, { kind: "customer_id", value: "C0151" });

  // Scope + reports[] is a contract violation, not a merge.
  assert.throws(
    () =>
      load_requests(
        write("both.json", {
          scope: { customer_id: "C1" },
          reports: [{ report_type: "magnet_health", system_id: "SME01096", recipients: ["dev@example.com"] }]
        })
      ),
    /either scope or reports/
  );
  // report_defaults without a scope has nothing to apply to.
  assert.throws(
    () =>
      load_requests(
        write("defaults.json", {
          report_defaults: { recipients: ["dev@example.com"] },
          reports: [{ report_type: "magnet_health", system_id: "SME01096", recipients: ["dev@example.com"] }]
        })
      ),
    /report_defaults only applies to scoped/
  );
  // Scope shape errors surface at load time, before any DB work.
  assert.throws(
    () => load_requests(write("badscope.json", { scope: { site_ids: [] } })),
    /non-empty array/
  );

  // Materialization synthesizes one normalized request per resolved system,
  // applying report_defaults, and runs the SAME assembly path as explicit
  // batches — exclusions still apply and are still reported.
  const m = materialize_scoped_requests(
    {
      scope: { customer_id: "C0151" },
      report_defaults: {
        recipients: ["dev@example.com"],
        output: { html: true, pdf: false, email: false, archive: false }
      },
      exclude: ["SME01097"],
      exclude_note: "test rig"
    },
    ["SME01096", "SME01097", "SME01098"]
  );
  assert.deepStrictEqual(
    m.requests.map((r) => r.system_id),
    ["SME01096", "SME01098"]
  );
  assert.deepStrictEqual(m.excluded, { ids: ["SME01097"], note: "test rig" });
  for (const r of m.requests) {
    assert.deepStrictEqual(r.recipients, ["dev@example.com"]);
    assert.strictEqual(r.output.pdf, false);
    assert.strictEqual(r.output.email, false);
  }

  // Round-1 F1 (blocker): the scope is the ONLY authority on which systems
  // run. report_defaults must not be able to smuggle in a system id or a
  // report type — that replaced every scope-resolved system with an
  // arbitrary, possibly other-customer, one.
  for (const k of ["system_id", "report_type"])
    assert.throws(
      () =>
        materialize_scoped_requests(
          {
            scope: { customer_id: "C0151" },
            report_defaults: { recipients: ["dev@example.com"], [k]: k === "system_id" ? "SME99999" : "magnet_health" }
          },
          ["SME01096"]
        ),
      new RegExp(`report_defaults.${k} is not allowed`),
      `reserved key ${k}`
    );
  // ...and even benign defaults can never change the materialized ids.
  const authoritative = materialize_scoped_requests(
    {
      scope: { customer_id: "C0151" },
      report_defaults: {
        recipients: ["dev@example.com"],
        output: { html: true, pdf: false, email: false, archive: false }
      }
    },
    ["SME01096", "SME01098"]
  );
  assert.deepStrictEqual(
    authoritative.requests.map((r) => r.system_id),
    ["SME01096", "SME01098"],
    "materialized ids are exactly the resolved ids"
  );

  // With a batch_email block, synthesized entries inherit batch recipients
  // and the batch pdf/email overrides, exactly like explicit members.
  const b = materialize_scoped_requests(
    {
      scope: { customer_id: "C0151" },
      batch_email: { recipients: ["ops@example.com"], summary: true, summary_pdf: true }
    },
    ["SME01096"]
  );
  assert.deepStrictEqual(b.requests[0].recipients, ["ops@example.com"]);
  assert.strictEqual(b.requests[0].output.pdf, true);
  assert.strictEqual(b.requests[0].output.email, false);
  assert.strictEqual(b.batch_email.summary_pdf, true);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- lookback_days: the batch period (plan A3) -------------------------------
{
  const DAY = 24 * 3600000;
  // Explicit-reports loader round trip via a temp file.
  const load_and_mix = (obj) => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "sme-period-"));
    const p = path.join(t, "r.json");
    fs.writeFileSync(p, JSON.stringify(obj));
    try {
      return load_requests(p);
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  };
  const base = {
    scope: { customer_id: "C0151" },
    report_defaults: {
      recipients: ["dev@example.com"],
      output: { html: true, pdf: false, email: false, archive: false }
    }
  };
  // Batch default applies to every synthesized report.
  const weekly = materialize_scoped_requests({ ...base, lookback_days: 7 }, ["SME01096"]);
  assert.strictEqual(weekly.lookback_days, 7);
  const w = weekly.requests[0].window;
  assert.strictEqual(w.lookback_days, 7);
  const span_days = (w.end.toMillis() - w.start.toMillis()) / DAY;
  assert.ok(span_days >= 7 && span_days < 8.1, `7-day default spans ~7 days, got ${span_days.toFixed(2)}`);
  // A per-report window still wins over the batch default.
  const override = materialize_scoped_requests(
    { ...base, lookback_days: 7, report_defaults: { ...base.report_defaults, window: { lookback_days: 14 } } },
    ["SME01096"]
  );
  assert.strictEqual(override.requests[0].window.lookback_days, 14, "per-report lookback outranks the batch default");
  // Explicit dates mean lookback is not the chosen period — null, no tag.
  const dated = materialize_scoped_requests(
    { ...base, report_defaults: { ...base.report_defaults, window: { start: "2026-07-01", end: "2026-07-31" } } },
    ["SME01096"]
  );
  assert.strictEqual(dated.requests[0].window.lookback_days, null, "explicit dates carry no period tag");
  // Absent -> the 30-day default, everywhere.
  const monthly = materialize_scoped_requests(base, ["SME01096"]);
  assert.strictEqual(monthly.lookback_days, 30);
  assert.strictEqual(monthly.requests[0].window.lookback_days, 30);
  // Nonsense values fail loudly.
  for (const bad of [0, -7, 1.5, "7"])
    assert.throws(
      () => materialize_scoped_requests({ ...base, lookback_days: bad }, ["SME01096"]),
      /lookback_days must be a positive integer/,
      `lookback_days ${JSON.stringify(bad)}`
    );
  // Round-1 F7: a per-report zero must FAIL, never silently become 30
  // under a 7-day batch (`||` swallowed it before validation).
  assert.throws(
    () =>
      materialize_scoped_requests(
        { ...base, lookback_days: 7, report_defaults: { ...base.report_defaults, window: { lookback_days: 0 } } },
        ["SME01096"]
      ),
    /lookback_days must be a positive integer, got 0/
  );

  // Round-1 F3: the batch period is the EFFECTIVE one, derived from the
  // normalized windows — never the top-level default.
  // Per-report lookback with no top-level field still yields the period.
  const weekly_by_report = materialize_scoped_requests(
    { ...base, report_defaults: { ...base.report_defaults, window: { lookback_days: 7 } } },
    ["SME01096"]
  );
  assert.strictEqual(weekly_by_report.lookback_days, 7, "effective period without a top-level default");
  // Uniform explicit dates mean NO period, even under a top-level default.
  const dated_batch = materialize_scoped_requests(
    { ...base, lookback_days: 7, report_defaults: { ...base.report_defaults, window: { start: "2026-07-01", end: "2026-07-31" } } },
    ["SME01096"]
  );
  assert.strictEqual(dated_batch.lookback_days, null, "explicit dates carry no batch period");
  // A summary batch mixing effective periods is a fatal request error, not
  // a mislabeled artifact.
  assert.throws(
    () =>
      load_and_mix({
        lookback_days: 7,
        batch_email: { recipients: ["dev@example.com"], summary_pdf: true },
        reports: [
          { report_type: "magnet_health", system_id: "SME01096" },
          { report_type: "magnet_health", system_id: "SME01098", window: { lookback_days: 14 } }
        ]
      }),
    /summary batch must share one period/
  );
  // Without a summary document, mixed periods are allowed (independent
  // briefs) — the batch just has no single period to tag.
  const mixed_briefs = load_and_mix({
    reports: [
      { report_type: "magnet_health", system_id: "SME01096", recipients: ["dev@example.com"], output: { email: false, pdf: false } },
      { report_type: "magnet_health", system_id: "SME01098", recipients: ["dev@example.com"], window: { lookback_days: 7 }, output: { email: false, pdf: false } }
    ]
  });
  assert.strictEqual(mixed_briefs.lookback_days, null, "mixed periods yield no batch tag");
}

// Round-1 F2: artifact identity = slug + scope-set hash, never the
// internal fleet name.
{
  const res = (ids, label) => ({
    system_ids: ids,
    label,
    scope_hash: require("crypto").createHash("sha1").update([...ids].sort().join(",")).digest("hex").slice(0, 8)
  });
  const a = scope_artifact_id(res(["SME00001", "SME00002"], "Acme Health"));
  const b = scope_artifact_id(res(["SME00001", "SME00003"], "Acme Health"));
  assert.ok(a.startsWith("Acme-Health-"), a);
  assert.notStrictEqual(a, b, "same label, different scope-sets: different artifact ids");
  assert.strictEqual(
    a,
    scope_artifact_id(res(["SME00002", "SME00001"], "Acme Health")),
    "hash is order-independent: same set, same id"
  );
  // A label with no ASCII word characters must never fall back to the
  // internal fleet artifact names.
  const cjk = scope_artifact_id(res(["SME00001"], "医疗集团"));
  assert.ok(/^Scoped-[0-9a-f]{8}$/.test(cjk), `non-ASCII label gets the Scoped fallback: ${cjk}`);
}

console.log("check_scope: all assertions passed");

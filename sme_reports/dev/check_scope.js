const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Scope resolution + scoped-request loading (PLAN-SCOPED-WEEKLY.md A1),
// exercised without a database: validate_scope and rows_to_resolution are
// pure, and the loader paths run on temp files. The SQL itself is verified
// by live probe (resolution results recorded in the plan doc).

const { validate_scope, rows_to_resolution } = require("../scope");
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

console.log("check_scope: all assertions passed");

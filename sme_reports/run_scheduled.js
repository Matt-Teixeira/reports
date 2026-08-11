const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const { run_batch } = require("./index");
const { materialize_scoped_requests } = require("./request_loader");
const { resolve_scope } = require("./scope");
const {
  validate_config,
  resolve_audience,
  plan_documents,
  access_covers,
  config_to_raw,
  smtp_outcomes
} = require("./fanout");
const { is_attention, is_urgent } = require("./conditions");
const {
  current_slot,
  load_slot_configs,
  load_config,
  load_audience_pool,
  load_user_caches,
  record_send
} = require("./config_loader");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat }
} = require("../utils/logger/enums");

// Scheduled (DB-config) runner — PLAN-SCOPED-WEEKLY.md B2–B4, reworked
// after review B round 1 (F4–F7). Fired by cron with no file argument:
// matches the current slot against alert.sme_reports, fans each row out,
// delivers, and writes one alert.sme_report_sends row per envelope
// recipient per attempt.
//
// Send-status integrity rules (F4/F5):
// - SMTP, persistence, and rendering are SEPARATE error boundaries. A
//   record-write failure after a successful send is a persistence failure
//   (logged, run marked failed) — it must never fabricate an "error" row
//   for an email that was delivered.
// - Every recipient gets AT MOST one row per attempt: backfills only cover
//   recipients with no recorded outcome.
// - A row/group that dies before delivery still owes its whole intended
//   audience error rows, so "did X get their report" is always answerable.

// Delivered documents are archived under an ATTEMPT-unique name BEFORE
// sending (F7; round-2 F2): out/ is overwrite-by-design scratch, so the
// name a sends row carries must be immutable — and the process-wide job id
// alone was not unique enough (two configs in one slot with the same scope
// but different exclusions produced different documents under one name).
// config id + a fresh uuid per document, copied with EXCL so a collision
// FAILS instead of overwriting history. Dry runs deliberately archive
// nothing — their rows carry the scratch name of what WOULD have sent.
const archive_delivered = (pdf_path, config_id) => {
  const archive_dir = path.join(__dirname, "archive");
  fs.mkdirSync(archive_dir, { recursive: true });
  const name = `${path.basename(pdf_path, ".pdf")}-cfg${config_id}-${uuidv4().slice(0, 8)}.pdf`;
  fs.copyFileSync(pdf_path, path.join(archive_dir, name), fs.constants.COPYFILE_EXCL);
  return name;
};

// Record one recipient's outcome. `outcomes` marks the recipient as
// handled BEFORE the insert attempt: if the insert fails, the recipient
// must not be backfilled with a second (contradictory) row.
const record_outcome = async (outcomes, counts, row) => {
  outcomes.add(row.recipient);
  try {
    await record_send(row);
  } catch (error) {
    counts.persist_errors += 1;
    console.error(`send record failed for ${row.recipient}: ${error.message}`);
  }
};

// Error rows for every intended recipient who has no recorded outcome yet
// (F5). Best-effort by design — this runs on failure paths.
const backfill_errors = async (outcomes, base, intended, message) => {
  for (const { email, role } of intended) {
    if (outcomes.has(email)) continue;
    outcomes.add(email);
    await record_send({
      ...base,
      recipient: email,
      recipient_role: role,
      status: "error",
      error: message
    }).catch(() => {});
  }
};

// Explicit-audience delivery (customer_summary / fleet_summary): one email
// to the To list with CC, every envelope recipient recorded (F6).
const deliver_explicit = async (run_log, job_id, cfg, slot, ctx, outcomes, counts) => {
  const { results, failures, fleet_pdf_path, resolution } = ctx;
  const doc = cfg.dry_run
    ? path.basename(fleet_pdf_path)
    : archive_delivered(fleet_pdf_path, cfg.id);
  const base = {
    config_id: cfg.id,
    slot,
    scope_hash: resolution ? resolution.scope_hash : null,
    document: doc
  };
  const envelope = [
    ...cfg.recipients.map((email) => ({ email, role: "to" })),
    ...cfg.cc_list.map((email) => ({ email, role: "cc" }))
  ];
  if (cfg.dry_run) {
    for (const { email, role } of envelope)
      await record_outcome(outcomes, counts, { ...base, recipient: email, recipient_role: role, status: "dry_run" });
    return;
  }
  // Per-recipient SMTP truth (round-2 F1): nodemailer resolves on PARTIAL
  // rejection, so each envelope address is graded from the returned
  // accepted list, never from "the promise resolved".
  let per_recipient;
  try {
    const send_summary_email = require("./output/send_summary_email");
    const info = await send_summary_email(
      run_log,
      job_id,
      { recipients: cfg.recipients, cc_list: cfg.cc_list },
      results,
      failures,
      fleet_pdf_path,
      {
        scope_label: resolution ? resolution.label : null,
        lookback_days: cfg.lookback_days
      }
    );
    const { smtp_outcomes } = require("./fanout");
    per_recipient = smtp_outcomes(info, envelope.map((e) => e.email));
  } catch (error) {
    per_recipient = new Map(envelope.map((e) => [e.email, "error"]));
    per_recipient.error_message = error.message;
  }
  for (const { email, role } of envelope) {
    const status = per_recipient.get(email);
    if (status === "sent") counts.sent += 1;
    else counts.send_errors += 1;
    await record_outcome(outcomes, counts, {
      ...base,
      recipient: email,
      recipient_role: role,
      status,
      error: status === "sent" ? null : per_recipient.error_message || "rejected by mail server"
    });
  }
};

const run_customer_or_fleet = async (run_log, job_id, cfg, slot, counts) => {
  const outcomes = new Set();
  const intended = [
    ...cfg.recipients.map((email) => ({ email, role: "to" })),
    ...cfg.cc_list.map((email) => ({ email, role: "cc" }))
  ];
  try {
    let resolution = null;
    let system_ids;
    if (cfg.kind === "customer_summary") {
      resolution = await resolve_scope(cfg.scope);
      system_ids = resolution.system_ids;
      // Loud resolution, same contract as file mode.
      const note = { job_id, config_id: cfg.id, label: resolution.label, ...resolution.detail };
      await addLogEvent(I, run_log, "run_scheduled_scope", det, note, null);
      console.log(
        `config ${cfg.id}: scope ${resolution.label} — ${resolution.detail.systems} systems (${resolution.detail.sites} sites)`
      );
    } else {
      // fleet_summary: the whole mag fleet, rendered as the INTERNAL
      // document (no scope -> unscoped title, fleet wording, raw reasons).
      const { mag_ids } = await load_audience_pool();
      system_ids = mag_ids;
    }
    const raw = config_to_raw(cfg, { recipients: cfg.recipients });
    const loaded = materialize_scoped_requests(raw, system_ids);
    const batch = await run_batch(run_log, job_id, loaded, resolution);
    if (!batch.fleet_pdf_path)
      throw new Error("run produced no summary document; nothing to deliver");
    await deliver_explicit(run_log, job_id, cfg, slot, { ...batch, resolution }, outcomes, counts);
  } catch (error) {
    // Pre-delivery failures (resolution, render) still owe the intended
    // audience their error rows (F5).
    await backfill_errors(
      outcomes,
      { config_id: cfg.id, slot, scope_hash: null, document: null },
      intended,
      error.message
    );
    throw error;
  }
  if (counts.send_errors || counts.persist_errors)
    throw new Error(
      `${counts.send_errors} send failure(s), ${counts.persist_errors} record failure(s)`
    );
};

// The weekly flagship, per the decided per-customer paradigm: the document
// unit is (customer × system-subset) — never a cross-customer merge. Each
// active, notifiable user's magnet scope is partitioned by owning
// customer; users sharing a (customer, subset) share one rendered
// document; each user receives ONE digest email carrying all their
// customer documents (zipped when more than one, size-chunked into parts
// only when the attachments outgrow the message budget). The {"users":
// [...]} scope variant narrows the audience to named addresses — the
// pilot mechanism.
const run_user_summary = async (run_log, job_id, cfg, slot) => {
  const { users, mag_ids, system_customer } = await load_audience_pool();
  const allowed =
    cfg.scope && Array.isArray(cfg.scope.users) ? cfg.scope.users : null;
  const audience = resolve_audience(users, mag_ids, allowed);
  if (!audience.length) {
    // A pilot scope naming an inactive/opted-out user must say so loudly
    // rather than silently doing nothing.
    throw new Error(
      allowed
        ? `scope users [${allowed.join(", ")}] resolved to no active, notifiable magnet users`
        : "audience resolved to no active, notifiable magnet users"
    );
  }
  const { units, user_units } = plan_documents(audience, system_customer);
  const deliveries = [...user_units.values()].reduce((n, k) => n + k.length, 0);
  const note = {
    job_id,
    config_id: cfg.id,
    audience: audience.length,
    units: units.length,
    deliveries
  };
  await addLogEvent(I, run_log, "run_user_summary", det, note, null);
  console.log(
    `config ${cfg.id}: audience ${audience.length} user${audience.length === 1 ? "" : "s"} → ${units.length} customer document${units.length === 1 ? "" : "s"} (${deliveries} deliveries)${cfg.dry_run ? " (dry run)" : ""}`
  );

  // Phase 1 — render each (customer, subset) document once, isolated: one
  // customer's bad data must not sink the other ninety-nine documents.
  const rendered = new Map();
  for (const unit of units) {
    try {
      const resolution = await resolve_scope({ system_ids: unit.system_ids });
      const raw = config_to_raw(cfg, { recipients: unit.users });
      const loaded = materialize_scoped_requests(raw, resolution.system_ids);
      const batch = await run_batch(run_log, job_id, loaded, resolution);
      if (!batch.fleet_pdf_path)
        throw new Error("unit produced no summary document");
      const doc = cfg.dry_run
        ? path.basename(batch.fleet_pdf_path)
        : archive_delivered(batch.fleet_pdf_path, cfg.id);
      const graded = batch.results.map((r) => ({ ...(r.summary || {}), archetype: r.archetype }));
      rendered.set(unit.key, {
        ok: true,
        unit,
        doc,
        pdf_path: batch.fleet_pdf_path,
        counts: {
          systems: batch.results.length,
          attention: graded.filter(is_attention).length,
          urgent: graded.filter(is_urgent).length
        }
      });
    } catch (error) {
      rendered.set(unit.key, { ok: false, unit, error: error.message });
      await addLogEvent(E, run_log, "run_user_summary", cat, { job_id, config_id: cfg.id, customer: unit.customer_id, scope_hash: unit.scope_hash }, error);
      console.error(`customer document ${unit.customer_name} (${unit.scope_hash}) failed: ${error.message}`);
    }
  }
  const failed_units = [...rendered.values()].filter((r) => !r.ok).length;

  // Phase 2 — one digest per user, isolated. Partial delivery is right:
  // one failed customer document yields an error row for that unit while
  // the user's other documents still go out.
  const caches = await load_user_caches([...user_units.keys()]);
  const user_failures = [];
  let sent_docs = 0;
  for (const [email, keys] of user_units) {
    const counts = { sent: 0, send_errors: 0, persist_errors: 0 };
    const outcomes = new Set();
    const base = { config_id: cfg.id, slot };
    const record_unit = async (key, extra) => {
      outcomes.add(key);
      const r = rendered.get(key);
      try {
        await record_send({
          ...base,
          recipient: email,
          recipient_role: "to",
          scope_hash: r.unit.scope_hash,
          document: r.ok ? r.doc : null,
          ...extra
        });
      } catch (error) {
        counts.persist_errors += 1;
        console.error(`send record failed for ${email}/${key}: ${error.message}`);
      }
    };
    try {
      const u = caches.get(email);
      const user_ok = u && u.status === "active" && u.notify_email === true;
      const deliverable = [];
      for (const key of keys) {
        const r = rendered.get(key);
        if (!r.ok) {
          await record_unit(key, { status: "error", error: r.error });
          continue;
        }
        // Send-time re-check per unit against the CURRENT cache.
        if (!user_ok || !access_covers(u.system_list_cache, r.unit.system_ids)) {
          await record_unit(key, { status: "skipped_access" });
          continue;
        }
        deliverable.push(r);
      }
      if (cfg.dry_run) {
        for (const r of deliverable) await record_unit(r.unit.key, { status: "dry_run" });
      } else if (deliverable.length) {
        const send_digest_email = require("./output/send_digest_email");
        const parts = await send_digest_email(
          run_log,
          job_id,
          email,
          cfg.cc_list,
          deliverable.map((r) => ({
            key: r.unit.key,
            customer_name: r.unit.customer_name,
            pdf_path: r.pdf_path,
            counts: r.counts
          })),
          { lookback_days: cfg.lookback_days, out_dir: path.join(__dirname, "out") }
        );
        // Grade each unit from ITS part's SMTP result.
        for (const part of parts) {
          const outcome = part.error
            ? "error"
            : smtp_outcomes(part.info, [email]).get(email);
          for (const key of part.unit_keys) {
            if (outcome === "sent") {
              counts.sent += 1;
              sent_docs += 1;
              await record_unit(key, { status: "sent" });
            } else {
              counts.send_errors += 1;
              await record_unit(key, { status: "error", error: part.error || "rejected by mail server" });
            }
          }
        }
      }
      if (counts.send_errors || counts.persist_errors)
        throw new Error(
          `${counts.send_errors} document send failure(s), ${counts.persist_errors} record failure(s)`
        );
    } catch (error) {
      user_failures.push({ email, message: error.message });
      await addLogEvent(E, run_log, "run_user_summary", cat, { job_id, config_id: cfg.id, recipient: email }, error);
      console.error(`digest for ${email} failed: ${error.message}`);
      // Units without a recorded outcome get error rows — never a second
      // row for one already recorded.
      for (const key of keys) {
        if (outcomes.has(key)) continue;
        outcomes.add(key);
        const r = rendered.get(key);
        await record_send({
          ...base,
          recipient: email,
          recipient_role: "to",
          scope_hash: r ? r.unit.scope_hash : null,
          document: r && r.ok ? r.doc : null,
          status: "error",
          error: error.message
        }).catch(() => {});
      }
    }
  }
  if (failed_units || user_failures.length)
    throw new Error(
      `${failed_units} customer document(s) failed to render, ${user_failures.length} digest(s) failed to deliver`
    );
  return { users: user_units.size, units: units.length, sent_docs };
};

const run_scheduled = async (run_log, opts = {}) => {
  const job_id = uuidv4();
  const { close_pdf_renderer } = require("./output/render_pdf");
  const slot = opts.slot || current_slot();
  try {
    let rows;
    if (opts.config_id !== null && opts.config_id !== undefined) {
      const row = await load_config(opts.config_id);
      if (!row) throw new Error(`no config row with id ${opts.config_id}`);
      if (!row.enabled && !opts.force_dry_run)
        throw new Error(`config row ${opts.config_id} is disabled; use --dry-run to exercise it`);
      rows = [row];
    } else {
      rows = await load_slot_configs(slot);
    }
    const note = { job_id, slot, configs: rows.map((r) => r.id) };
    await addLogEvent(I, run_log, "run_scheduled", cal, note, null);
    if (!rows.length) {
      console.log(`slot ${slot}: no enabled report configs`);
      return { slot, ran: 0 };
    }
    console.log(`slot ${slot}: ${rows.length} config row${rows.length === 1 ? "" : "s"}`);

    const row_failures = [];
    for (const row of rows) {
      // Per-row isolation: one bad config never sinks the others.
      try {
        const cfg = validate_config(row);
        // Operator --dry-run forces the safe path regardless of the row.
        if (opts.force_dry_run) cfg.dry_run = true;
        if (cfg.kind === "user_summary")
          await run_user_summary(run_log, job_id, cfg, slot);
        else {
          const counts = { sent: 0, send_errors: 0, persist_errors: 0 };
          await run_customer_or_fleet(run_log, job_id, cfg, slot, counts);
        }
      } catch (error) {
        row_failures.push({ id: row.id, message: error.message });
        await addLogEvent(E, run_log, "run_scheduled", cat, { job_id, config_id: row.id }, error);
        console.error(`config ${row.id} failed: ${error.message}`);
      }
    }
    if (row_failures.length)
      throw new Error(
        `${row_failures.length} of ${rows.length} config rows failed: ${row_failures.map((f) => f.id).join(", ")}`
      );
    return { slot, ran: rows.length };
  } finally {
    await close_pdf_renderer();
  }
};

module.exports = run_scheduled;

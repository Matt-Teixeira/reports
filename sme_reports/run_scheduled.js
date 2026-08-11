const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const { run_batch, write_records_sidecar } = require("./index");
const { materialize_scoped_requests } = require("./request_loader");
const { resolve_scope } = require("./scope");
const {
  validate_config,
  coalesce_user_rows,
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

// The weekly flagship, per the decided per-customer + SUBSCRIPTION
// paradigm: every user_summary row firing on a slot joins a COALITION
// (rows sharing lookback/options), whose combined audience is planned and
// rendered ONCE — shared (customer, subset) documents render a single
// time however many subscribers they serve — while each user's sends rows
// attribute to THEIR OWN config row (coalition.owner_of) and honor their
// own row's dry_run gate. The per-run cache means a system computes once
// per window across every document that contains it, and run_batch runs
// systems concurrently.
//
// Ordering rules (subscriptions review F3): a live unit's document is
// archived at RENDER time, before any SMTP — an archive failure fails the
// unit pre-delivery, and a delivered email always has its immutable
// artifact on disk first. Skipped/error rows never archive anything.
const RENDER_CONCURRENCY = 4;

const run_user_summary = async (run_log, job_id, coalition, slot, cache) => {
  const base_cfg = coalition.cfgs[0]; // render inputs identical by construction
  const ids = coalition.cfgs.map((c) => c.id).join(",");
  const { users, mag_ids, system_customer } = await load_audience_pool();
  const audience = resolve_audience(users, mag_ids, coalition.allowed);

  // A named subscriber/pilot who did NOT resolve gets an error row — a
  // subscription that silently produces nothing is unanswerable support
  // load. DELIBERATE (review F4 disposition): unresolved subscribers WARN
  // and are recorded, but do not fail the run — a deactivated subscriber
  // is user state, not a run failure, and failing cron weekly until a row
  // is edited would be alert fatigue. A failed error-row INSERT is a
  // persistence failure and does fail the coalition.
  const resolved = new Set(audience.map((a) => String(a.email).toLowerCase()));
  let unresolved = 0;
  let unresolved_persist_errors = 0;
  if (coalition.allowed) {
    for (const email of coalition.allowed) {
      if (resolved.has(email)) continue;
      unresolved += 1;
      try {
        await record_send({
          config_id: coalition.owner_of(email),
          slot,
          recipient: email,
          recipient_role: "to",
          scope_hash: null,
          document: null,
          status: "error",
          error: "subscriber is not an active, notifiable user with magnet access"
        });
      } catch (error) {
        unresolved_persist_errors += 1;
        console.error(`send record failed for unresolved subscriber ${email}: ${error.message}`);
      }
    }
    if (unresolved) {
      await addLogEvent(W, run_log, "run_user_summary", det, { job_id, config_ids: ids, unresolved }, null);
      console.warn(
        `config ${ids}: ${unresolved} subscriber${unresolved === 1 ? "" : "s"} did not resolve (inactive, opted out, or no magnet access) — error rows recorded`
      );
    }
  }
  if (!audience.length) {
    if (unresolved_persist_errors)
      throw new Error(`${unresolved_persist_errors} unresolved-subscriber record failure(s)`);
    // Round-2 F5: the unresolved policy must not depend on WHO ELSE shares
    // the coalition. Unresolved named subscribers never fail the run —
    // whether they are alone or beside valid ones — they warn and carry
    // their error rows. An ALL_USERS row resolving to nobody is different:
    // that is a config aimed at an empty universe, and stays fatal.
    if (coalition.allowed) {
      console.warn(`config ${ids}: no subscriber resolved — nothing to deliver`);
      return { users: 0, units: 0, sent_docs: 0, unresolved };
    }
    throw new Error("audience resolved to no active, notifiable magnet users");
  }

  const { units, user_units } = plan_documents(audience, system_customer);
  const deliveries = [...user_units.values()].reduce((n, k) => n + k.length, 0);
  const any_live = audience.some((a) => coalition.dry_run_of(a.email) === false);
  const note = { job_id, config_ids: ids, audience: audience.length, units: units.length, deliveries };
  await addLogEvent(I, run_log, "run_user_summary", det, note, null);
  console.log(
    `config ${ids}: audience ${audience.length} user${audience.length === 1 ? "" : "s"} → ${units.length} customer document${units.length === 1 ? "" : "s"} (${deliveries} deliveries)${any_live ? "" : " (dry run)"}`
  );

  // Phase 1 — render each (customer, subset) document once, isolated.
  // Liveness is PER UNIT (review F5): a unit whose recipients are all dry
  // writes no history sidecar and archives nothing, even inside a mixed
  // coalition. Live units archive HERE, pre-SMTP (review F3).
  const rendered = new Map();
  for (const unit of units) {
    try {
      const resolution = await resolve_scope({ system_ids: unit.system_ids });
      // Ownership may move between planning and rendering (review F2): the
      // resolved rows' CURRENT customers must be exactly the unit's — a
      // document must never ship under a stale customer identity.
      if (resolution.customer_ids.length !== 1 || resolution.customer_ids[0] !== unit.customer_id)
        throw new Error(
          `customer ownership changed between planning and rendering (planned ${unit.customer_id}, resolved ${resolution.customer_ids.join(", ")})`
        );
      // History sidecars are DEFERRED (round-3 F2): auto-persistence is
      // suppressed at render; the eligibility step below writes the
      // sidecar only for units approved for archival.
      const raw = config_to_raw({ ...base_cfg, dry_run: true }, { recipients: unit.users });
      const loaded = materialize_scoped_requests(raw, resolution.system_ids);
      const batch = await run_batch(run_log, job_id, loaded, resolution, {
        concurrency: RENDER_CONCURRENCY,
        cache
      });
      if (!batch.fleet_pdf_path)
        throw new Error("unit produced no summary document");
      const graded = batch.results.map((r) => ({ ...(r.summary || {}), archetype: r.archetype }));
      rendered.set(unit.key, {
        ok: true,
        unit,
        // Archived in the eligibility step below — after the send-time
        // access recheck decides the unit actually has a live, eligible
        // recipient, and still BEFORE any SMTP (rounds 1-2, F3/F4).
        archived_doc: null,
        scratch_doc: path.basename(batch.fleet_pdf_path),
        pdf_path: batch.fleet_pdf_path,
        resolution,
        records: batch.results.map((x) => x.summary).filter(Boolean),
        failures: batch.failures,
        counts: {
          // Honest counts (review F6): attempted = produced + failed;
          // failures surface as "status unavailable", never as a
          // reassuring zero.
          systems: batch.results.length + batch.failures.length,
          attention: graded.filter(is_attention).length,
          urgent: graded.filter(is_urgent).length,
          unavailable: batch.failures.length
        }
      });
    } catch (error) {
      rendered.set(unit.key, { ok: false, unit, error: error.message });
      await addLogEvent(E, run_log, "run_user_summary", cat, { job_id, config_ids: ids, customer: unit.customer_id, scope_hash: unit.scope_hash }, error);
      console.error(`customer document ${unit.customer_name} (${unit.scope_hash}) failed: ${error.message}`);
    }
  }
  let failed_units = [...rendered.values()].filter((r) => !r.ok).length;

  // Between phases (round-2 F1/F4): with CURRENT caches in hand, decide
  // which units actually have at least one live, access-eligible
  // recipient. Only those units are archived — after a POST-RENDER
  // ownership recheck (the render window is long enough for a system to
  // change customers; a document must never be archived or shipped under
  // a stale customer identity) and still before any SMTP. Units whose
  // live recipients all lost access archive nothing.
  const caches = await load_user_caches([...user_units.keys()]);
  const eligible = (email, r) => {
    const u = caches.get(email);
    return (
      u &&
      u.status === "active" &&
      u.notify_email === true &&
      access_covers(u.system_list_cache, r.unit.system_ids)
    );
  };
  for (const r of rendered.values()) {
    if (!r.ok) continue;
    try {
      // Post-render ownership recheck for EVERY unit (round-3 F3): a
      // dry-run row must not name a document rendered under stale
      // customer ownership any more than a live one may ship it.
      const recheck = await resolve_scope({ system_ids: r.unit.system_ids });
      if (recheck.customer_ids.length !== 1 || recheck.customer_ids[0] !== r.unit.customer_id)
        throw new Error(
          `customer ownership changed during rendering (planned ${r.unit.customer_id}, now ${recheck.customer_ids.join(", ")})`
        );
      const has_live_eligible = r.unit.users.some(
        (e) => coalition.dry_run_of(e) === false && eligible(e, r)
      );
      if (!has_live_eligible) continue;
      r.archived_doc = archive_delivered(r.pdf_path, base_cfg.id);
      // Deferred history sidecar (round-3 F2), best-effort: capture never
      // blocks delivery.
      try {
        write_records_sidecar({
          scope: r.resolution,
          period_tag: base_cfg.lookback_days !== 30 ? `-${base_cfg.lookback_days}d` : "",
          records: r.records,
          failures: r.failures
        });
      } catch (sidecar_error) {
        console.error(`records sidecar failed for ${r.unit.customer_name} (delivery unaffected): ${sidecar_error.message}`);
      }
    } catch (error) {
      rendered.set(r.unit.key, { ok: false, unit: r.unit, error: error.message });
      failed_units += 1;
      await addLogEvent(E, run_log, "run_user_summary", cat, { job_id, config_ids: ids, customer: r.unit.customer_id, scope_hash: r.unit.scope_hash }, error);
      console.error(`customer document ${r.unit.customer_name} (${r.unit.scope_hash}) failed pre-archive: ${error.message}`);
    }
  }

  // Phase 2 — one digest per user, isolated; sends attribute to the
  // user's OWN config row and honor their own dry_run gate. Partial
  // delivery is deliberate: one failed customer document yields an error
  // row while the user's other documents still go out. record_unit is
  // persistence-ONLY (review F3): document names were resolved above.
  const user_failures = [];
  let sent_docs = 0;
  for (const [email, keys] of user_units) {
    const cfg_id = coalition.owner_of(email);
    const user_dry = coalition.dry_run_of(email);
    const counts = { sent: 0, send_errors: 0, persist_errors: 0 };
    const outcomes = new Set();
    const base = { config_id: cfg_id, slot };
    const record_unit = async (key, document, extra) => {
      outcomes.add(key);
      const r = rendered.get(key);
      try {
        await record_send({
          ...base,
          recipient: email,
          recipient_role: "to",
          scope_hash: r.unit.scope_hash,
          document,
          ...extra
        });
      } catch (error) {
        counts.persist_errors += 1;
        console.error(`send record failed for ${email}/${key}: ${error.message}`);
      }
    };
    try {
      const deliverable = [];
      for (const key of keys) {
        const r = rendered.get(key);
        if (!r.ok) {
          await record_unit(key, null, { status: "error", error: r.error });
          continue;
        }
        // Send-time re-check per unit against the SAME cache snapshot the
        // archive-eligibility step used. Skipped deliveries archive
        // nothing and name nothing.
        if (!eligible(email, r)) {
          await record_unit(key, null, { status: "skipped_access" });
          continue;
        }
        deliverable.push(r);
      }
      if (user_dry) {
        for (const r of deliverable)
          await record_unit(r.unit.key, r.scratch_doc, { status: "dry_run" });
      } else if (deliverable.length) {
        const send_digest_email = require("./output/send_digest_email");
        const parts = await send_digest_email(
          run_log,
          job_id,
          email,
          [],
          deliverable.map((r) => ({
            key: r.unit.key,
            customer_name: r.unit.customer_name,
            pdf_path: r.pdf_path,
            counts: r.counts
          })),
          { lookback_days: base_cfg.lookback_days, out_dir: path.join(__dirname, "out") }
        );
        // Grade each unit from ITS part's SMTP result.
        for (const part of parts) {
          const outcome = part.error
            ? "error"
            : smtp_outcomes(part.info, [email]).get(email);
          for (const key of part.unit_keys) {
            const r = rendered.get(key);
            if (outcome === "sent") {
              counts.sent += 1;
              sent_docs += 1;
              await record_unit(key, r.archived_doc, { status: "sent" });
            } else {
              counts.send_errors += 1;
              await record_unit(key, r.archived_doc, { status: "error", error: part.error || "rejected by mail server" });
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
      await addLogEvent(E, run_log, "run_user_summary", cat, { job_id, config_id: cfg_id, recipient: email }, error);
      console.error(`digest for ${email} failed: ${error.message}`);
      for (const key of keys) {
        if (outcomes.has(key)) continue;
        outcomes.add(key);
        const r = rendered.get(key);
        await record_send({
          ...base,
          recipient: email,
          recipient_role: "to",
          scope_hash: r ? r.unit.scope_hash : null,
          document: null,
          status: "error",
          error: error.message
        }).catch(() => {});
      }
    }
  }
  if (failed_units || user_failures.length || unresolved_persist_errors)
    throw new Error(
      `${failed_units} customer document(s) failed to render, ${user_failures.length} digest(s) failed to deliver, ${unresolved_persist_errors} unresolved-subscriber record failure(s)`
    );
  return { users: user_units.size, units: units.length, sent_docs, unresolved };
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
    const user_cfgs = [];
    for (const row of rows) {
      // Per-row isolation: one bad config never sinks the others.
      try {
        const cfg = validate_config(row);
        // Operator --dry-run forces the safe path regardless of the row.
        if (opts.force_dry_run) cfg.dry_run = true;
        if (cfg.kind === "user_summary") {
          user_cfgs.push(cfg); // coalesced below
          continue;
        }
        const counts = { sent: 0, send_errors: 0, persist_errors: 0 };
        await run_customer_or_fleet(run_log, job_id, cfg, slot, counts);
      } catch (error) {
        row_failures.push({ id: row.id, message: error.message });
        await addLogEvent(E, run_log, "run_scheduled", cat, { job_id, config_id: row.id }, error);
        console.error(`config ${row.id} failed: ${error.message}`);
      }
    }
    // All user_summary rows on this slot coalesce: one audience, one plan,
    // shared renders, per-subscription attribution. The per-run cache also
    // spans coalitions (differing lookbacks never share keys anyway).
    if (user_cfgs.length) {
      const cache = new Map();
      for (const coalition of coalesce_user_rows(user_cfgs)) {
        try {
          await run_user_summary(run_log, job_id, coalition, slot, cache);
        } catch (error) {
          for (const cfg of coalition.cfgs)
            row_failures.push({ id: cfg.id, message: error.message });
          await addLogEvent(E, run_log, "run_scheduled", cat, { job_id, config_ids: coalition.cfgs.map((c) => c.id) }, error);
          console.error(`user_summary coalition [${coalition.cfgs.map((c) => c.id).join(",")}] failed: ${error.message}`);
        }
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

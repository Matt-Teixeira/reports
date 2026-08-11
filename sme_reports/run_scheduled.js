const path = require("path");
const { v4: uuidv4 } = require("uuid");

const { run_batch } = require("./index");
const { materialize_scoped_requests } = require("./request_loader");
const { resolve_scope } = require("./scope");
const {
  validate_config,
  resolve_audience,
  group_by_scope,
  access_covers,
  config_to_raw
} = require("./fanout");
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

// Scheduled (DB-config) runner — PLAN-SCOPED-WEEKLY.md B2–B4. Fired by
// cron with no file argument: matches the current slot against
// alert.sme_reports, fans each row out (user_summary rows group users by
// identical magnet scope and render once per group), delivers, and writes
// one alert.sme_report_sends row per recipient per attempt.
//
// Isolation mirrors the file-mode delivery-integrity rule: a failing row
// never sinks the other rows, a failing scope-group never sinks the other
// groups — but the process exits nonzero if ANY row or group failed, so
// cron can see it.

// Delivery for one rendered document to one explicit audience list (the
// customer_summary / fleet_summary path — explicit recipients are the
// config author's deliberate choice, so no per-user access re-check).
const deliver_explicit = async (run_log, job_id, cfg, slot, ctx) => {
  const { results, failures, fleet_pdf_path, resolution } = ctx;
  const doc = path.basename(fleet_pdf_path);
  const scope_hash = resolution ? resolution.scope_hash : null;
  const base = { config_id: cfg.id, slot, scope_hash, document: doc };
  if (cfg.dry_run) {
    for (const r of cfg.recipients)
      await record_send({ ...base, recipient: r, status: "dry_run" });
    return { sent: 0, errors: 0 };
  }
  try {
    const send_summary_email = require("./output/send_summary_email");
    await send_summary_email(
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
    for (const r of cfg.recipients)
      await record_send({ ...base, recipient: r, status: "sent" });
    return { sent: cfg.recipients.length, errors: 0 };
  } catch (error) {
    for (const r of cfg.recipients)
      await record_send({ ...base, recipient: r, status: "error", error: error.message });
    throw error;
  }
};

const run_customer_or_fleet = async (run_log, job_id, cfg, slot) => {
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
  return deliver_explicit(run_log, job_id, cfg, slot, { ...batch, resolution });
};

// The weekly flagship: every active, notifiable user with magnets, grouped
// by identical magnet scope; one render per group, one email per user,
// send-time access re-check per recipient.
const run_user_summary = async (run_log, job_id, cfg, slot) => {
  const { users, mag_ids } = await load_audience_pool();
  const audience = resolve_audience(users, mag_ids);
  const groups = group_by_scope(audience);
  const note = {
    job_id,
    config_id: cfg.id,
    audience: audience.length,
    groups: groups.length
  };
  await addLogEvent(I, run_log, "run_user_summary", det, note, null);
  console.log(
    `config ${cfg.id}: audience ${audience.length} users → ${groups.length} scope-group document${groups.length === 1 ? "" : "s"}${cfg.dry_run ? " (dry run)" : ""}`
  );

  const group_failures = [];
  let sent = 0;
  for (const group of groups) {
    const base = { config_id: cfg.id, slot, scope_hash: group.scope_hash };
    try {
      const resolution = await resolve_scope({ system_ids: group.system_ids });
      const raw = config_to_raw(cfg, { recipients: group.users });
      const loaded = materialize_scoped_requests(raw, resolution.system_ids);
      const batch = await run_batch(run_log, job_id, loaded, resolution);
      if (!batch.fleet_pdf_path)
        throw new Error("group produced no summary document");
      const doc = path.basename(batch.fleet_pdf_path);

      // Send-time access re-check against CURRENT caches: access revoked
      // (or a user deactivated) between render and send must not receive
      // this document.
      const caches = await load_user_caches(group.users);
      let send_errors = 0;
      for (const email of group.users) {
        const u = caches.get(email);
        const still_allowed =
          u &&
          u.status === "active" &&
          u.notify_email === true &&
          access_covers(u.system_list_cache, resolution.system_ids);
        if (!still_allowed) {
          await record_send({ ...base, recipient: email, document: doc, status: "skipped_access" });
          continue;
        }
        if (cfg.dry_run) {
          await record_send({ ...base, recipient: email, document: doc, status: "dry_run" });
          continue;
        }
        try {
          const send_summary_email = require("./output/send_summary_email");
          await send_summary_email(
            run_log,
            job_id,
            { recipients: [email], cc_list: cfg.cc_list },
            batch.results,
            batch.failures,
            batch.fleet_pdf_path,
            { scope_label: resolution.label, lookback_days: cfg.lookback_days }
          );
          await record_send({ ...base, recipient: email, document: doc, status: "sent" });
          sent += 1;
        } catch (error) {
          send_errors += 1;
          await record_send({ ...base, recipient: email, document: doc, status: "error", error: error.message });
        }
      }
      if (send_errors)
        throw new Error(`${send_errors} of ${group.users.length} sends failed`);
    } catch (error) {
      group_failures.push({ scope_hash: group.scope_hash, message: error.message });
      await addLogEvent(E, run_log, "run_user_summary", cat, { job_id, config_id: cfg.id, scope_hash: group.scope_hash }, error);
      console.error(`scope-group ${group.scope_hash} failed: ${error.message}`);
      // A group that failed before delivery still owes the sends table its
      // audience: every intended recipient gets an error row, so "did
      // customer X get their report" is answerable even for this path.
      for (const email of group.users)
        await record_send({ ...base, recipient: email, status: "error", error: error.message }).catch(() => {});
    }
  }
  if (group_failures.length)
    throw new Error(`${group_failures.length} of ${groups.length} scope-groups failed`);
  return { sent, groups: groups.length };
};

const run_scheduled = async (run_log, opts = {}) => {
  const job_id = uuidv4();
  const { close_pdf_renderer } = require("./output/render_pdf");
  const slot = opts.slot || current_slot();
  try {
    let rows;
    if (opts.config_id) {
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
        else await run_customer_or_fleet(run_log, job_id, cfg, slot);
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

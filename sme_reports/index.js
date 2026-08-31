const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const {
  load_requests,
  load_raw_request,
  materialize_scoped_requests
} = require("./request_loader");
const {
  fetch_identity,
  resolve_system_vendor,
  fetch_series,
  fetch_edu_series,
  fetch_thresholds,
  fetch_units
} = require("./data");
const { build_render_model } = require("./render/model");
const { analyze_system } = require("./compute/analyze");
const { build_page } = require("./render/page");
const { build_summary_facts, build_limited_record } = require("./compute/summary_facts");
// Aliased on import: `period_tag` is also a STRING parameter on the fleet
// summary / sidecar helpers below, and one name for both would read as a
// shadowed function at every glance.
const { period_tag: period_tag_of } = require("./periods");
const write_html = require("./output/write_html");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat }
} = require("../utils/logger/enums");

// Orchestrator for the single-SME Magnet Health Brief paradigm.
// Phase 1: request file -> data -> compute -> HTML on disk.
// Phase 2 adds PDF rendering + email; the output flags already gate them.

// on_facts: dev-only observation channel (parity --facts) — called with the
// EXACT facts object this run computed, so a witness can never disagree
// with the artifacts of its own run (a re-fetch against the same window is
// not a database snapshot). Production callers never pass it.
const run_one = async (run_log, job_id, request, on_facts = null) => {
  let note = { job_id, system_id: request.system_id };
  await addLogEvent(I, run_log, "run_sme_report", cal, note, null);

  const identity = await fetch_identity(request.system_id);
  const resolution = await resolve_system_vendor(identity);

  // LIMITED coverage (classify_manufacturer allowlist): identity + EDU
  // statements only — no analysis, no judgments. Product decision
  // (phase 9): no per-system brief exists for these, so a brief-producing
  // request fails LOUDLY as a named failure row (the scoped document words
  // it via the customer whitelist); summary-only shapes carry the limited
  // record into the fleet document's LIMITED section instead. Note this is
  // per-run-shape: the same system is a stated row in a summary sweep and
  // a named failure in a briefs batch — never silent in either.
  if (resolution.limited) {
    if (request.output.html || request.output.pdf || request.output.email)
      throw new Error(
        `${request.system_id} is limited coverage (${resolution.label}): no Magnet Health Brief — included in summary documents only`
      );
    const { edu_source, edu } = await fetch_edu_series(
      request.system_id,
      request.window
    );
    const { build_edu_facts } = require("./compute/analyze");
    const summary = build_limited_record({
      identity,
      label: resolution.label,
      window: request.window,
      edu_facts: build_edu_facts(edu, edu_source)
    });
    note = {
      job_id,
      system_id: request.system_id,
      limited: resolution.label,
      edu_source,
      edu_captures: edu.length
    };
    await addLogEvent(I, run_log, "run_sme_report", det, note, null);
    return {
      system_id: identity.system_id,
      site_name: identity.site_name,
      manufacturer: identity.manufacturer,
      modality: identity.modality,
      summary
    };
  }

  const { vendor, routing } = resolution;
  // The four remaining pulls are independent once the vendor is known.
  const [{ source, series }, { edu_source, edu }, thresholds, units] =
    await Promise.all([
      fetch_series(identity, request.window, vendor, routing),
      fetch_edu_series(request.system_id, request.window),
      fetch_thresholds(request.system_id, vendor),
      fetch_units(request.system_id, vendor)
    ]);

  note = {
    job_id,
    system_id: request.system_id,
    vendor: vendor.key,
    source,
    captures: series.length,
    edu_source,
    edu_captures: edu.length,
    thresholds,
    units
  };
  await addLogEvent(I, run_log, "run_sme_report", det, note, null);

  // Summary-only runs (html/pdf/email all off) skip the RENDERER entirely:
  // the fleet document needs only the analysis facts, and the render model
  // built tiles, narrative, and both chart SVGs even when nothing would be
  // delivered. The no-data throw lives in compute/analyze either way, so
  // failure messages and the batch's failure records are identical on both
  // paths. email-without-pdf still goes through the render path so its
  // "output.email requires output.pdf" error is preserved. Deliberate
  // narrowing: a presentation-side failure can no longer fail a
  // summary-only record — story coverage is check-gated instead.
  const renders =
    request.output.html || request.output.pdf || request.output.email;
  let facts;
  let html = null;
  if (renders) {
    const vm = build_render_model({
      identity,
      vendor,
      series,
      source,
      request,
      edu,
      edu_source,
      thresholds,
      units
    });
    facts = vm.facts;
    if (request.output.html || request.output.pdf) html = build_page(vm);
  } else {
    ({ facts } = analyze_system({
      system_id: request.system_id,
      vendor,
      series,
      window: request.window,
      event_window: request.event_window,
      edu,
      edu_source,
      thresholds,
      units
    }));
  }

  if (on_facts) on_facts(request.system_id, facts);

  const outputs = { archetype: facts.archetype };
  if (request.output.html) {
    outputs.html_path = write_html(
      request.output.out_dir,
      request.system_id,
      html
    );
  }

  if (request.output.pdf) {
    const { render_pdf } = require("./output/render_pdf");
    outputs.pdf_path = await render_pdf(
      request.output.out_dir,
      request.system_id,
      html
    );
    // ARCHIVE-DISABLED 2026-08-31 (owner decision): no copies of delivered
    // PDFs are kept on disk. The block below kept a dated copy under
    // sme_reports/archive/, which grows unboundedly and — on the release
    // copy — is destroyed by build-release.sh's wipe anyway. Restore by
    // uncommenting; `request.output.archive` still gates it, so no caller
    // needs to change. outputs.archive_path stays unset.
    //
    // if (request.output.archive) {
    //   const archive_dir = path.join(__dirname, "archive");
    //   fs.mkdirSync(archive_dir, { recursive: true });
    //   // Non-default periods tag the archived name: a 7-day, a 6-month and a
    //   // 30-day brief archived the same day must not overwrite each other.
    //   // The tag vocabulary is shared (periods.js) so a filename and the
    //   // email announcing it can never name the span differently.
    //   const tag = period_tag_of(request.window.lookback_days);
    //   const dated = `Avante-${request.system_id}-Magnet-Health${tag}-${new Date().toISOString().slice(0, 10)}.pdf`;
    //   outputs.archive_path = path.join(archive_dir, dated);
    //   fs.copyFileSync(outputs.pdf_path, outputs.archive_path);
    // }
  }

  if (request.output.email) {
    if (!outputs.pdf_path)
      throw new Error("output.email requires output.pdf (PDF is the attachment)");
    const send_report_email = require("./output/send_report_email");
    await send_report_email(run_log, job_id, request, identity, outputs.pdf_path);
  }

  note = { job_id, system_id: request.system_id, outputs };
  await addLogEvent(I, run_log, "run_sme_report", det, note, null);
  return {
    ...outputs,
    system_id: identity.system_id,
    site_name: identity.site_name,
    manufacturer: identity.manufacturer,
    modality: identity.modality,
    // The distilled per-system state. Without this every metric computed
    // above dies here and the fleet summary has nothing but an archetype.
    summary: build_summary_facts(facts, identity)
  };
};

// Persist the distilled per-system records beside the archived PDFs —
// deliberate history capture ("changes since last report" needs weeks of
// these). Callers isolate failures: capture must never block delivery.
// Exported so the scheduled runner can defer a unit's sidecar until the
// eligibility and ownership checks approve archival (subscriptions review
// round-3 F2).
const write_records_sidecar = ({ scope, period_tag, records, failures }) => {
  const { scope_artifact_id } = require("./scope");
  const archive_dir = path.join(__dirname, "archive");
  fs.mkdirSync(archive_dir, { recursive: true });
  const slug = scope ? scope_artifact_id(scope) : null;
  const date = new Date().toISOString().slice(0, 10);
  const sidecar = path.join(
    archive_dir,
    `summary-records-${slug || "fleet"}${period_tag || ""}-${date}.json`
  );
  fs.writeFileSync(
    sidecar,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scope: scope || null,
        period_tag: period_tag || null,
        records,
        failures
      },
      null,
      1
    )
  );
  return sidecar;
};

// Builds the multi-page fleet summary from the distilled per-system records.
// A failure here must not sink the batch — the per-system PDFs are already
// on disk and the summary email can still go out without an attachment —
// but it must never be SILENT either: the error is returned so the summary
// email states the missing document and the run is recorded as failed
// (review round-2 F1: a partition violation soft-failed into a successful,
// quiet delivery, visible only in logs). Returns { pdf_path, error }.
const build_fleet_summary = async (run_log, job_id, results, failures, out_dir, excluded, scope, period_tag = "", opts = {}) => {
  const { build_fleet_model } = require("./render/fleet_model");
  const { build_fleet_page } = require("./render/fleet_page");
  const { render_pdf_document } = require("./output/render_pdf");
  try {
    const records = results.map((r) => r.summary).filter(Boolean);
    const vm = build_fleet_model(records, failures, { excluded, scope });
    const date = new Date().toISOString().slice(0, 10);
    const html = build_fleet_page(vm);
    // Scoped documents are named by their scope IDENTITY (slug + scope-set
    // hash — see scope_artifact_id) so a customer summary can never collide
    // with the internal fleet document, with another subset under the same
    // customer label, or with its own history sidecar from a different
    // scope the same day.
    const { scope_artifact_id } = require("./scope");
    const slug = scope ? scope_artifact_id(scope) : null;
    const base = slug
      ? `Avante-${slug}-Magnet-Health-Summary${period_tag}-${date}`
      : `Avante-Fleet-Magnet-Health${period_tag}-${date}`;
    // The HTML lands next to the PDF under the same name — it is the only
    // way to read the document without a PDF viewer, and page breaks are
    // the thing most likely to need a look. write_html is not used here: it
    // appends the per-system "-Magnet-Health" suffix.
    fs.mkdirSync(out_dir, { recursive: true });
    fs.writeFileSync(path.join(out_dir, `${base}.html`), html);
    const pdf_path = await render_pdf_document(out_dir, `${base}.pdf`, html);
    // Distilled-records sidecar (plan A4): the flat per-system records this
    // document rendered from, archived so future runs can diff against
    // them ("changes since last report" is buildable only if this history
    // exists). Capture starts now, consumer comes later.
    // ARCHIVE-DISABLED 2026-08-31 (owner decision): the records sidecar
    // writes JSON into sme_reports/archive/, so it is off with the rest of
    // on-disk archiving. fanout.js still sets archive_records (!dry_run) —
    // the flag is left intact so restoring is just an uncomment.
    //
    // if (opts.archive_records) {
    //   // Isolated: history capture is auxiliary — a failed sidecar write
    //   // must never sink the summary document's delivery.
    //   try {
    //     write_records_sidecar({ scope, period_tag, records, failures });
    //   } catch (sidecar_error) {
    //     await addLogEvent(E, run_log, "build_fleet_summary", cat, { job_id, sidecar: true }, sidecar_error);
    //     console.error(`records sidecar failed (delivery unaffected): ${sidecar_error.message}`);
    //   }
    // }
    const note = {
      job_id,
      systems: vm.total,
      pages: vm.page_count,
      attention: vm.attention_count,
      urgent: vm.urgent_count,
      failures: vm.failure_count,
      pdf_path
    };
    await addLogEvent(I, run_log, "build_fleet_summary", det, note, null);
    return { pdf_path, error: null };
  } catch (error) {
    await addLogEvent(E, run_log, "build_fleet_summary", cat, { job_id }, error);
    console.error(`fleet summary failed: ${error.message}`);
    return { pdf_path: null, error: error.message };
  }
};

// One assembled batch, end to end: per-system reports, then the batch
// email / fleet-summary block. Shared by file-mode (run_sme_report) and
// the scheduled DB-config runner (run_scheduled.js), which calls it once
// per scope-group. Does NOT close the shared Chromium instance — that is
// the entry point's job, since a scheduled run executes many batches.
const run_batch = async (run_log, job_id, loaded, scope_resolution, opts = {}) => {
    const { requests, batch_email, summary_only, excluded, out_dir, lookback_days } = loaded;
    // opts.concurrency: parallel per-system computation (worker pool over
    // the request list; results stay in request order). Default 1 keeps
    // file-mode behavior byte-identical. opts.cache: a per-RUN map shared
    // across scheduled scope-units — the same system in the same window
    // computes once however many customer documents contain it; failures
    // cache too (the same dead system must not re-fetch per document).
    // opts.on_facts: dev-only facts observer threaded to run_one (parity
    // --facts). Cache HITS skip run_one and therefore the observer — fine
    // for the harness, which never passes a cache.
    const { concurrency = 1, cache = null, on_facts = null } = opts;
    // Null = explicit-date windows: no chosen period, no tag (F3).
    const batch_period_tag = period_tag_of(lookback_days);
    const slots = new Array(requests.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= requests.length) return;
        const request = requests[i];
        const key = cache
          ? `${request.system_id}|${request.window.start.toMillis()}|${request.window.end.toMillis()}`
          : null;
        if (key && cache.has(key)) {
          slots[i] = cache.get(key);
          continue;
        }
        let out;
        // Per-report try/catch so one failure doesn't kill a bulk batch.
        try {
          out = { ok: true, result: await run_one(run_log, job_id, request, on_facts) };
        } catch (error) {
          out = { ok: false, message: error.message };
          const note = { job_id, system_id: request.system_id };
          await addLogEvent(E, run_log, "run_sme_report", cat, note, error);
          console.error(
            `sme_report failed for ${request.system_id}: ${error.message}`
          );
        }
        if (key) cache.set(key, out);
        slots[i] = out;
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(concurrency, requests.length || 1)) }, worker)
    );
    const results = [];
    const failures = [];
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].ok) results.push(slots[i].result);
      else failures.push({ system_id: requests[i].system_id, message: slots[i].message });
    }

    let fleet_pdf_path = null;
    let fleet_error = null;
    if (batch_email) {
      // The summary covers every system that produced facts. Only the
      // attachment email needs a PDF on disk, so that filter belongs to it
      // alone — applying it to the summary is what made summary-only runs
      // come back empty.
      const attachable = results.filter((r) => r.pdf_path);
      // Exclusions count as content: an all-excluded run still owes the
      // reader the document that names what was excluded and why.
      const has_content =
        results.length ||
        failures.length ||
        (excluded && excluded.ids.length > 0);

      if (batch_email.summary_pdf && has_content) {
        const fleet = await build_fleet_summary(
          run_log,
          job_id,
          results,
          failures,
          out_dir,
          excluded,
          scope_resolution,
          batch_period_tag,
          { archive_records: batch_email.archive_records }
        );
        fleet_pdf_path = fleet.pdf_path;
        fleet_error = fleet.error;
        // A soft failure is right for a normal batch — the per-system briefs
        // are still valid deliverables. In summary-only mode there are none,
        // so sending the thin email would report success having produced
        // nothing.
        if (!fleet_pdf_path && summary_only)
          throw new Error(
            "summary_only run produced no fleet summary document; nothing to send"
          );
      }

      if (batch_email.summary && has_content) {
        const send_summary_email = require("./output/send_summary_email");
        await send_summary_email(
          run_log,
          job_id,
          batch_email,
          results,
          failures,
          fleet_pdf_path,
          {
            scope_label: scope_resolution ? scope_resolution.label : null,
            lookback_days,
            // A requested-but-failed summary document must be STATED in the
            // email, never just an absent attachment (round-2 F1).
            fleet_error
          }
        );
      }
      if (!summary_only && batch_email.attachments && attachable.length) {
        const send_batch_email = require("./output/send_batch_email");
        await send_batch_email(
          run_log,
          job_id,
          batch_email,
          attachable,
          out_dir
        );
      } else if (!summary_only && !attachable.length) {
        await addLogEvent(
          W,
          run_log,
          "run_sme_report",
          det,
          { job_id, message: "batch_email set but no PDFs were produced" },
          null
        );
      }
    }
    return { results, failures, fleet_pdf_path, fleet_error, lookback_days };
};

// One entry path for every request-driven run, whatever produced the
// request: `load` is a thunk returning what the loader returned (file mode
// reads a file; the one-off CLI hands over an object it composed from its
// job config). Everything after loading — scope resolution, the batch, the
// fatal-summary rule, the error boundary, and closing Chromium — is shared,
// so a one-off run cannot drift from a scheduled one on any of it.
const run_entry = async (run_log, load) => {
  const job_id = uuidv4();
  const { close_pdf_renderer } = require("./output/render_pdf");
  try {
    let loaded = load();
    let scope_resolution = null;
    if (loaded.scoped) {
      // Resolution is LOUD, never silent (PLAN-SCOPED-WEEKLY.md A1): the
      // log and the console both state what the scope became, and a scope
      // resolving to zero systems threw inside resolve_scope — a fatal
      // request error, not an empty report.
      const { resolve_scope } = require("./scope");
      scope_resolution = await resolve_scope(loaded.scope);
      const note = {
        job_id,
        scope: loaded.scope,
        label: scope_resolution.label,
        ...scope_resolution.detail,
        system_ids: scope_resolution.system_ids
      };
      await addLogEvent(I, run_log, "resolve_scope", det, note, null);
      console.log(
        `scope: ${scope_resolution.label} — ${scope_resolution.detail.systems} systems ` +
          `(${scope_resolution.detail.sites} sites, ${scope_resolution.detail.customers} customer${scope_resolution.detail.customers === 1 ? "" : "s"})`
      );
      loaded = materialize_scoped_requests(loaded.raw, scope_resolution.system_ids);
    }
    const batch = await run_batch(run_log, job_id, loaded, scope_resolution);
    // A requested summary document that failed to build is a RUN failure,
    // recorded after every authorized deliverable has gone out: the briefs
    // are on disk, the emails (which state the missing document) are sent,
    // and only then does the process report nonzero so a scheduler can see
    // it — a partition violation or render error must never resolve into a
    // quiet exit 0 (review round-2 F1). Scheduled runs make this decision
    // per unit in run_scheduled instead.
    if (batch.fleet_error)
      throw new Error(
        `fleet summary document failed after per-system delivery: ${batch.fleet_error}`
      );
    return { ...batch, scope_resolution };
  } catch (error) {
    await addLogEvent(E, run_log, "run_sme_report", cat, { job_id }, error);
    console.error(`sme_report failed: ${error.message}`);
    // Anything reaching this catch is FATAL — per-system failures were
    // already isolated inside the loop. Swallowing it here returned [] and
    // exit code 0 to cron with nothing delivered, which reads as success.
    throw error;
  } finally {
    // Shared Chromium instance — without this the process never exits.
    await close_pdf_renderer();
  }
};

// File mode — unchanged contract: resolves to the per-system results and
// throws on any fatal run error.
const run_sme_report = async (run_log, request_path) =>
  (await run_entry(run_log, () => load_requests(request_path))).results;

// In-memory mode, for the one-off CLI. Returns the whole batch (results,
// failures, the summary document's path, the resolved scope) because a
// one-off run's caller prints what it produced rather than emailing it.
const run_request_object = (run_log, raw) =>
  run_entry(run_log, () => load_raw_request(raw));

module.exports = run_sme_report;
module.exports.run_batch = run_batch;
module.exports.run_request_object = run_request_object;
module.exports.write_records_sidecar = write_records_sidecar;

const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const { load_requests, materialize_scoped_requests } = require("./request_loader");
const {
  fetch_identity,
  resolve_system_vendor,
  fetch_series,
  fetch_edu_series,
  fetch_thresholds,
  fetch_units
} = require("./data");
const { build_render_model } = require("./render/model");
const { build_page } = require("./render/page");
const { build_summary_facts } = require("./compute/summary_facts");
const write_html = require("./output/write_html");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat }
} = require("../utils/logger/enums");

// Orchestrator for the single-SME Magnet Health Brief paradigm.
// Phase 1: request file -> data -> compute -> HTML on disk.
// Phase 2 adds PDF rendering + email; the output flags already gate them.

const run_one = async (run_log, job_id, request) => {
  let note = { job_id, system_id: request.system_id };
  await addLogEvent(I, run_log, "run_sme_report", cal, note, null);

  const identity = await fetch_identity(request.system_id);
  const { vendor, routing } = await resolve_system_vendor(identity);
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

  // Summary-only runs skip every rendering step; the facts above are all the
  // fleet document needs, and rendering is what makes a report cost seconds.
  const renders = request.output.html || request.output.pdf;
  const html = renders ? build_page(vm) : null;

  const outputs = { archetype: vm.facts.archetype };
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
    // Keep a dated, version-controlled copy for self-reference — out/ is
    // gitignored scratch that gets overwritten every run. output.archive
    // false skips this (bulk sweeps would bloat the repo).
    if (request.output.archive) {
      const archive_dir = path.join(__dirname, "archive");
      fs.mkdirSync(archive_dir, { recursive: true });
      // Non-default periods tag the archived name: a 7-day and a 30-day
      // brief archived the same day must not overwrite each other.
      const lb = request.window.lookback_days;
      const period_tag = lb && lb !== 30 ? `-${lb}d` : "";
      const dated = `Avante-${request.system_id}-Magnet-Health${period_tag}-${new Date().toISOString().slice(0, 10)}.pdf`;
      outputs.archive_path = path.join(archive_dir, dated);
      fs.copyFileSync(outputs.pdf_path, outputs.archive_path);
    }
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
    summary: build_summary_facts(vm.facts, identity)
  };
};

// Builds the multi-page fleet summary from the distilled per-system records.
// A failure here must not sink the batch — the per-system PDFs are already
// on disk and the summary email can still go out without an attachment.
const build_fleet_summary = async (run_log, job_id, results, failures, out_dir, excluded, scope, period_tag = "", opts = {}) => {
  const { build_fleet_model } = require("./render/fleet_model");
  const { build_fleet_page } = require("./render/fleet_page");
  const { render_pdf_document } = require("./output/render_pdf");
  try {
    const records = results.map((r) => r.summary).filter(Boolean);
    const vm = build_fleet_model(records, failures, { excluded, scope });
    const date = new Date().toISOString().slice(0, 10);
    const html = build_fleet_page(vm);
    // Scoped documents are named by their scope so a customer summary can
    // never collide with (or be mistaken for) the internal fleet document.
    const slug = scope
      ? scope.label.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      : null;
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
    if (opts.archive_records) {
      const archive_dir = path.join(__dirname, "archive");
      fs.mkdirSync(archive_dir, { recursive: true });
      const sidecar = path.join(
        archive_dir,
        `summary-records-${slug || "fleet"}${period_tag}-${date}.json`
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
    }
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
    return pdf_path;
  } catch (error) {
    await addLogEvent(E, run_log, "build_fleet_summary", cat, { job_id }, error);
    console.error(`fleet summary failed: ${error.message}`);
    return null;
  }
};

const run_sme_report = async (run_log, request_path) => {
  const job_id = uuidv4();
  const { close_pdf_renderer } = require("./output/render_pdf");
  try {
    let loaded = load_requests(request_path);
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
    const { requests, batch_email, summary_only, excluded, out_dir, lookback_days } = loaded;
    const period_tag = lookback_days !== 30 ? `-${lookback_days}d` : "";
    const results = [];
    const failures = [];
    for (const request of requests) {
      // Per-report try/catch so one failure doesn't kill a bulk batch.
      try {
        results.push(await run_one(run_log, job_id, request));
      } catch (error) {
        failures.push({ system_id: request.system_id, message: error.message });
        const note = { job_id, system_id: request.system_id };
        await addLogEvent(E, run_log, "run_sme_report", cat, note, error);
        console.error(
          `sme_report failed for ${request.system_id}: ${error.message}`
        );
      }
    }

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

      let fleet_pdf_path = null;
      if (batch_email.summary_pdf && has_content) {
        fleet_pdf_path = await build_fleet_summary(
          run_log,
          job_id,
          results,
          failures,
          out_dir,
          excluded,
          scope_resolution,
          period_tag,
          { archive_records: batch_email.archive_records }
        );
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
            lookback_days
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
    return results;
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

module.exports = run_sme_report;

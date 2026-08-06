const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const { load_requests } = require("./request_loader");
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
  const html = build_page(vm);

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
      const dated = `Avante-${request.system_id}-Magnet-Health-${new Date().toISOString().slice(0, 10)}.pdf`;
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
    modality: identity.modality
  };
};

const run_sme_report = async (run_log, request_path) => {
  const job_id = uuidv4();
  const { close_pdf_renderer } = require("./output/render_pdf");
  try {
    const { requests, batch_email } = load_requests(request_path);
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
      const sendable = results.filter((r) => r.pdf_path);
      if (batch_email.summary && (sendable.length || failures.length)) {
        const send_summary_email = require("./output/send_summary_email");
        await send_summary_email(run_log, job_id, batch_email, sendable, failures);
      }
      if (batch_email.attachments && sendable.length) {
        const send_batch_email = require("./output/send_batch_email");
        await send_batch_email(
          run_log,
          job_id,
          batch_email,
          sendable,
          requests[0].output.out_dir
        );
      } else if (!sendable.length) {
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
    return [];
  } finally {
    // Shared Chromium instance — without this the process never exits.
    await close_pdf_renderer();
  }
};

module.exports = run_sme_report;

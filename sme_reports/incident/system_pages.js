const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { v4: uuidv4 } = require("uuid");

const { is_attention, is_data_issue } = require("../conditions");
const { build_fresh_zip } = require("../output/fresh_zip");
const { load_activity_data } = require("./activity_data");
const { scrub_avante, avante_keys } = require("./scrub");
const { analyze_activity } = require("./activity");
const { build_system_page, system_page_name } = require("./system_page");

const [addLogEvent] = require("../../utils/logger/log");
const {
  type: { I, E },
  tag: { det, cat }
} = require("../../utils/logger/enums");

// Per-system ACTIVITY pages for a summary batch (PLAN-FLEET-SYSTEM-PAGES.md):
// one interactive HTML page for every system that needs attention, has a
// data issue, or could not be analyzed, zipped into parts that each fit an
// O365 message.
//
// Isolation: a page is auxiliary to the summary, so one system's failure
// never sinks the others or the summary — but it is never silent either:
// it is logged with its cause and returned, and the email names the system.

// Compressed budget per zip part — the same 12 MB send_batch_email.js holds
// PDFs to, which stays under O365's ~25 MB after base64 growth.
const CHUNK_BYTES = 12 * 1024 * 1024;

// The distilled record the summary email and fleet document grade, so the
// pages cover exactly the systems those documents call out.
const facts_of = (r) => ({ ...(r.summary || {}), archetype: r.archetype });

// results/failures: run_batch's. Returns the systems that get a page, in
// result order then failure order: { system_id, result | null, message | null }.
const select_page_systems = (results, failures) => [
  ...results
    .filter((r) => is_attention(facts_of(r)) || is_data_issue(facts_of(r)))
    .map((r) => ({ system_id: r.system_id, result: r, message: null })),
  ...failures.map((f) => ({ system_id: f.system_id, result: null, message: f.message }))
];

// Greedy, order-preserving split by DEFLATED size (zip -j's per-file cost,
// to within headers). A single page over budget still gets its own part.
const chunk_pages = (pages, budget = CHUNK_BYTES) => {
  const parts = [];
  let cur = [];
  let bytes = 0;
  for (const p of pages) {
    if (cur.length && bytes + p.deflated > budget) {
      parts.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(p);
    bytes += p.deflated;
  }
  if (cur.length) parts.push(cur);
  return parts;
};

// requests: the batch's request list (each system's window). out_dir: where
// the pages and zips land. scope_tag: filename-safe scope label ("fleet" or
// a customer slug). period_tag / period_label: periods.js wording.
// audience: "external" (scrubbed, for the customer) or "internal" (Avante
// staff kept and labelled) — incident/page_policy.js decides which.
const build_system_pages = async (
  run_log,
  job_id,
  { results, failures, requests, out_dir, scope_tag = "fleet", period_tag = "", period_label = null, audience }
) => {
  if (!["internal", "external"].includes(audience)) throw new Error(`build_system_pages: unknown audience ${audience}`);
  const internal = audience === "internal";
  const db = require("../../utils/db/pg-pool");
  const { customer_failure_reason } = require("../render/fleet_model");
  const window_of = new Map(requests.map((r) => [r.system_id, r.window]));
  const selected = select_page_systems(results, failures);
  fs.mkdirSync(out_dir, { recursive: true });

  const pages = [];
  const page_failures = [];
  for (const sel of selected) {
    try {
      const w = window_of.get(sel.system_id);
      if (!w) throw new Error(`no request window for ${sel.system_id}`);
      const from = w.start.toMillis();
      const to = w.end.toMillis();
      const raw = await load_activity_data(db, { system_id: sel.system_id, from: new Date(from), to: new Date(to) });
      // External: Avante rows removed before analysis. Internal: kept whole,
      // with the same test marking who is Avante's.
      const scrubbed = internal ? null : scrub_avante(raw);
      const data = internal ? raw : { ...raw, notifications: scrubbed.notifications, recipients: scrubbed.recipients };
      const staff = internal ? avante_keys(raw) : null;
      const readings = sel.result ? sel.result.activity || null : null;
      if (sel.result && !readings) throw new Error(`no activity readings on the result for ${sel.system_id} (run_one opts.activity off?)`);
      const a = analyze_activity(data, readings, { from, to, avante_keys: staff });
      const notice = sel.result
        ? null
        : `This system could not be analyzed for this period (${customer_failure_reason(sel.message)}), so no readings are shown. Its alert detections and notifications are below.`;
      const html = build_system_page(a, {
        identity: raw.identity,
        meta: raw.meta,
        model_count: raw.models.length,
        period_label,
        notice,
        audience
      });
      const file = path.join(out_dir, system_page_name(sel.system_id, to, period_tag, audience));
      fs.writeFileSync(file, html);
      const buf = Buffer.from(html);
      pages.push({ system_id: sel.system_id, path: file, bytes: buf.length, deflated: zlib.deflateRawSync(buf).length });
      // Run log only: the dropped-address count never reaches the page.
      await addLogEvent(I, run_log, "build_system_pages", det, {
        job_id,
        system_id: sel.system_id,
        audience,
        analyzed: !!readings,
        slots: a.slots.length,
        detections: a.counts.detections,
        notifications: a.counts.notifications,
        recipients: a.counts.recipients,
        ...(internal ? { avante_addresses_kept: staff.size } : { avante_addresses_dropped: scrubbed.dropped_addresses }),
        bytes: buf.length
      }, null);
    } catch (error) {
      page_failures.push({ system_id: sel.system_id, message: error.message });
      await addLogEvent(E, run_log, "build_system_pages", cat, { job_id, system_id: sel.system_id }, error);
      console.error(`activity page failed for ${sel.system_id} (summary still sent): ${error.message}`);
    }
  }

  // Zip parts. Paths are per-run unique (fresh_zip.js F1: never reuse an
  // archive path); the attachment filename is the clean name.
  const parts = chunk_pages(pages);
  const date = pages.length ? path.basename(pages[0].path).match(/(\d{4}-\d{2}-\d{2})\.html$/)[1] : null;
  const zips = [];
  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.length > 1 ? `-part-${i + 1}-of-${parts.length}` : "";
    const filename = `Avante-${scope_tag}-System-Activity${internal ? "-Internal" : ""}${period_tag}-${date}${suffix}.zip`;
    const zip_path = path.join(out_dir, `activity-${uuidv4().slice(0, 8)}-${filename}`);
    await build_fresh_zip(zip_path, parts[i].map((p) => p.path));
    zips.push({
      path: zip_path,
      filename,
      part: i + 1,
      parts: parts.length,
      systems: parts[i].map((p) => p.system_id),
      bytes: fs.statSync(zip_path).size
    });
  }
  return { audience, selected: selected.map((s) => s.system_id), pages, page_failures, zips };
};

module.exports = { build_system_pages, select_page_systems, chunk_pages, CHUNK_BYTES };

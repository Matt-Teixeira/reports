const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { v4: uuidv4 } = require("uuid");

const { is_attention, is_data_issue, attention_sort, condition_status } = require("../conditions");
const { COLORS } = require("../output/email_theme");
const { build_fresh_zip } = require("../output/fresh_zip");
const { load_activity_data } = require("./activity_data");
const { scrub_avante, avante_keys } = require("./scrub");
const { analyze_activity } = require("./activity");
const { build_system_page, system_section, system_page_name } = require("./system_page");
const { build_system_app, system_app_name } = require("./system_app");

const [addLogEvent] = require("../../utils/logger/log");
const {
  type: { I, E },
  tag: { det, cat }
} = require("../../utils/logger/enums");

// Per-system ACTIVITY for a summary batch (PLAN-FLEET-SYSTEM-PAGES.md): every
// system that needs attention, has a data issue, or could not be analyzed,
// zipped into parts that each fit an O365 message. Two formats
// (PLAN-SYSTEM-ACTIVITY-APP.md):
//   app   — one HTML file per part (incident/system_app.js): a dashboard of
//           every flagged system, each linking to that system's view.
//   pages — one HTML file per system (incident/system_page.js).
//
// Isolation: a system's activity is auxiliary to the summary, so one
// system's failure never sinks the others or the summary — but it is never
// silent either: it is logged with its cause and returned, the email names
// the system, and the app's dashboard lists it as not available.

const { PAGE_FORMATS: FORMATS } = require("./page_policy");

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

// The app dashboard's order: what needs attention, worst first (the
// summary's own attention_sort), then data issues, then systems that could
// not be analyzed; selection order otherwise. Adds each system's group.
const GROUP_RANK = { attention: 0, data_issue: 1, failed: 2 };
const group_of = (sel) => (!sel.result ? "failed" : is_data_issue(facts_of(sel.result)) ? "data_issue" : "attention");
const dashboard_order = (selected) =>
  selected
    .map((sel) => ({ ...sel, group: group_of(sel) }))
    .sort(
      (a, b) =>
        GROUP_RANK[a.group] - GROUP_RANK[b.group] ||
        (a.group === "attention" ? attention_sort(facts_of(a.result), facts_of(b.result)) : 0)
    );

// The summary's words and color for a system; a failed one has no record.
const NOT_ANALYZED = { label: "could not be analyzed", color: COLORS.grey, strong: false, mark: false };
const status_of = (sel) => (sel.result ? condition_status(facts_of(sel.result)) : NOT_ANALYZED);

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
// the files and zips land. scope_tag: filename-safe scope label ("Fleet" or
// a customer slug); scope_label: the same for reading (the app's title).
// period_tag / period_label: periods.js wording. audience: "external"
// (scrubbed, for the customer) or "internal" (Avante staff kept and
// labelled) — incident/page_policy.js decides which. format: "app" | "pages".
const build_system_pages = async (
  run_log,
  job_id,
  {
    results,
    failures,
    requests,
    out_dir,
    scope_tag = "fleet",
    scope_label = null,
    period_tag = "",
    period_label = null,
    audience,
    format = "app"
  }
) => {
  if (!["internal", "external"].includes(audience)) throw new Error(`build_system_pages: unknown audience ${audience}`);
  if (!FORMATS.includes(format)) throw new Error(`build_system_pages: unknown format ${format}`);
  const internal = audience === "internal";
  const app = format === "app";
  const db = require("../../utils/db/pg-pool");
  const { customer_failure_reason } = require("../render/fleet_model");
  const window_of = new Map(requests.map((r) => [r.system_id, r.window]));
  const selected = select_page_systems(results, failures);
  const order = app ? dashboard_order(selected) : selected;
  fs.mkdirSync(out_dir, { recursive: true });

  // One entry per system built: { system_id, path, bytes, deflated } — for
  // the app, bytes are its section's and path is the part's file.
  const pages = [];
  const sections = new Map();
  const page_failures = [];
  for (const sel of order) {
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
      const ctx = { identity: raw.identity, meta: raw.meta, model_count: raw.models.length, period_label, notice, audience };
      let buf;
      let file = null;
      if (app) {
        const section = system_section(a, ctx);
        sections.set(sel.system_id, section);
        buf = Buffer.from(section.body + section.payload_json);
      } else {
        const html = build_system_page(a, ctx);
        file = path.join(out_dir, system_page_name(sel.system_id, to, period_tag, audience));
        fs.writeFileSync(file, html);
        buf = Buffer.from(html);
      }
      pages.push({ system_id: sel.system_id, path: file, bytes: buf.length, deflated: zlib.deflateRawSync(buf).length });
      // Run log only: the dropped-address count never reaches the page.
      await addLogEvent(I, run_log, "build_system_pages", det, {
        job_id,
        system_id: sel.system_id,
        audience,
        format,
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
  const zips = [];
  const zip_part = async (i, files, filename, extra = {}) => {
    const zip_path = path.join(out_dir, `activity-${uuidv4().slice(0, 8)}-${filename}`);
    await build_fresh_zip(zip_path, files);
    zips.push({
      path: zip_path,
      filename,
      part: i + 1,
      parts: parts.length,
      systems: parts[i].map((p) => p.system_id),
      bytes: fs.statSync(zip_path).size,
      ...extra
    });
  };

  if (app) {
    // Every part's dashboard lists every flagged system; a part carries the
    // views of its own.
    parts.forEach((p, i) => p.forEach((pg) => (pg.part = i + 1)));
    const part_of = new Map(pages.map((p) => [p.system_id, p.part]));
    const first = pages.length ? sections.get(pages[0].system_id) : null;
    for (let i = 0; i < parts.length; i++) {
      const part = i + 1;
      const entries = order.map((sel) => {
        const s = sections.get(sel.system_id) || null;
        const at = s ? part_of.get(sel.system_id) : null;
        return { system_id: sel.system_id, group: sel.group, status: status_of(sel), summary: s && s.summary, part: at, section: at === part ? s : null };
      });
      const html = build_system_app(entries, {
        scope_label: scope_label || scope_tag.replace(/-/g, " "),
        period_label,
        audience,
        date: first.date,
        span: first.span,
        part,
        parts: parts.length
      });
      const file = path.join(out_dir, system_app_name({ scope_tag, period_tag, date: first.date, audience, part, parts: parts.length }));
      fs.writeFileSync(file, html);
      for (const p of parts[i]) p.path = file;
      await zip_part(i, [file], path.basename(file).replace(/\.html$/, ".zip"), { app: file });
      await addLogEvent(I, run_log, "build_system_app", det, {
        job_id,
        audience,
        part,
        parts: parts.length,
        systems: parts[i].length,
        listed: entries.length,
        bytes: Buffer.byteLength(html)
      }, null);
    }
  } else {
    const date = pages.length ? path.basename(pages[0].path).match(/(\d{4}-\d{2}-\d{2})\.html$/)[1] : null;
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.length > 1 ? `-part-${i + 1}-of-${parts.length}` : "";
      await zip_part(i, parts[i].map((p) => p.path), `Avante-${scope_tag}-System-Activity${internal ? "-Internal" : ""}${period_tag}-${date}${suffix}.zip`);
    }
  }
  return { audience, format, selected: selected.map((s) => s.system_id), pages, page_failures, zips };
};

module.exports = { build_system_pages, select_page_systems, dashboard_order, status_of, chunk_pages, CHUNK_BYTES, FORMATS };

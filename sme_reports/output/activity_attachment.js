const fs = require("fs");
const path = require("path");
const { AVANTE_MAILBOX } = require("../incident/page_policy");

// Which file carries a summary's System Activity part 1: the zip, or the
// app's HTML itself. Decided at SEND time, from the envelope the message is
// actually addressed to (a scheduled row's CC never reaches the builder).
//
// Unzipped only when ALL of:
//   - the envelope is Avante mailboxes only (@avantehs.com, To and CC) —
//     some hospital mail gateways quarantine or strip .html attachments,
//     and customer delivery is proven on zips, so any outside address
//     keeps the zip;
//   - the app format (one file; the per-system "pages" format is many);
//   - one part (several parts are already over the zip budget);
//   - the HTML is at most UNZIPPED_MAX_BYTES. Base64 grows it ~37%, so
//     5 MB leaves ~7 MB on the wire — under nearly any mail server's cap.
// Otherwise the zip, exactly as before. The zip and the per-run HTML
// snapshot are built either way and removed by the callers after delivery;
// the HTML in out/ stays.
//
// Pure apart from one stat of the snapshot; dev/check_system_pages.js covers it.

const UNZIPPED_MAX_BYTES = 5 * 1024 * 1024;

const avante_only = (recipients = [], cc_list = []) => {
  const all = [...recipients, ...cc_list].map((e) => String(e || "").trim()).filter(Boolean);
  return all.length > 0 && all.every((e) => AVANTE_MAILBOX.test(e));
};

// first: activity.zips[0] ({ path, filename, app?, snapshot? }); parts: zips.length.
// app is the out/ copy (its name is the attachment's name); snapshot is this
// run's private copy of the same HTML, the one actually attached.
// -> { filename, path, zipped }
const activity_attachment = (first, { parts, recipients, cc_list }) => {
  if (first.app && first.snapshot && parts === 1 && avante_only(recipients, cc_list)) {
    let bytes = Infinity;
    try {
      bytes = fs.statSync(first.snapshot).size;
    } catch {
      // Missing snapshot: fall through to the zip.
    }
    if (bytes <= UNZIPPED_MAX_BYTES) return { filename: path.basename(first.app), path: first.snapshot, zipped: false };
  }
  return { filename: first.filename, path: first.path, zipped: true };
};

module.exports = { activity_attachment, avante_only, UNZIPPED_MAX_BYTES };

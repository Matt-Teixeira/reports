const { doc_head, doc_tail } = require("../email/templates/doc-caps");
const process_template = require("../email/process-template");
const {
  table_header_3,
  table_header_4,
  table_report_header_5,
  table_report_header_6,
  table_footer
} = require("../email/templates/table-caps");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../utils/logger/enums");

async function build_full_email(
  run_log,
  job_id,
  processed_row,
  report_name,
  col_num
) {
  let note = { job_id };
  try {
    await addLogEvent(I, run_log, "build_full_email", cal, note, null);

    let table_head;

    if (col_num === 5) {
      table_head = await process_template(table_report_header_5, {
        report_name: report_name
      });
    }
    if (col_num === 6) {
      table_head = await process_template(table_report_header_6, {
        report_name: report_name
      });
    } else if (col_num === 4) {
      table_head = await process_template(table_header_4, {
        report_name: report_name
      });
    } else if (col_num === 3) {
      table_head = await process_template(table_header_3, {
        report_name: report_name
      });
    }

    let full_email_text = "";

    full_email_text =
      doc_head + table_head + processed_row + table_footer + doc_tail;

    return full_email_text;
  } catch (error) {
    await addLogEvent(E, run_log, "build_full_email", cat, note, error);
  }
}

module.exports = build_full_email;

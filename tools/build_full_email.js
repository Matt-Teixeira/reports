const { doc_head, doc_tail } = require("../email/templates/doc-caps");
const process_template = require("../email/process-template");
const {
  table_header_alert,
  table_header_warn,
  table_footer
} = require("../email/templates/table-caps");

async function build_full_email(processed_row, report_name) {
  let table_head = await process_template(table_header_alert, {
    report_name: report_name
  });
  let full_email_text = "";

  full_email_text =
    doc_head + table_head + processed_row + table_footer + doc_tail;

  return full_email_text;
}

module.exports = build_full_email;

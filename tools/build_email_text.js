const { DateTime } = require("luxon");
const process_template = require("../email/process-template");
const {
  col_0_alert,
  col_0_warn,
  col_1,
  col_2_less_than,
  col_2_greater_than,
  col_2_equals,
  col_2_delta_neg,
  col_2_offline,
  col_2_contains,
  col_2_composite_equals,
  col_3_end
} = require("../email/templates/rows");

const build_email_text = async (report_meta_data, reports) => {
  let processed_row = "";

  // Loop though each index and conver to email template
  for await (const report of reports) {
    // CONVERT TO STRING
    const dt_iso = report.capture_datetime.toISOString();

    // CREATE LUXON DT OBJECT
    // TODO: MAKE ZONE DYNAMIC AND SYSTEM SPECIFIC
    const dt_ny = DateTime.fromISO(dt_iso, {
      zone: "America/New_York"
    });

    // MAP DATA AND PROCESS TEMPLATE
    const col_0_1_data = {
      view_link: "https://remote2.avantehs.com/machine/" + report.system_id,
      system_id: report.system_id,
      manufacturer: report.manufacturer,
      modality: report.modality,
      time: dt_ny.toFormat("t ZZZZ"), // 9:07 AM EST,
      date: dt_ny.toFormat("DD") // Aug 6, 2014,
    };

    processed_row += await process_template(col_0_alert + col_1, col_0_1_data);

    console.log("\nprocessed_row");
    //console.log(processed_row);

    const less_than_data = {
      field_name: report_meta_data.field_name,
      resolved_field_content: report.helium_value, // Need to change to general name
      operator: report_meta_data.operator,
      threshold_units: report.helium_units
    };
    const greater_than_data = {
      field_name: report_meta_data.field_name,
      resolved_field_content: report.helium_value, // Need to change to general name
      operator: report_meta_data.operator,
      threshold_units: report.helium_units
    };

    processed_row += await process_template(col_2_less_than, less_than_data);

    console.log(processed_row);
  }
};

module.exports = build_email_text;

/* 
{
  author: 'Ryan.Anderson@avantehs.com',
  field_name: 'he_level_value',
  operator: 'less_than',
  custom_threshold: '90',
  threshold_data_type: 'int',
  cc_list: [ 'hello.email@aol.com', 'fake.emailguy@gmail.com' ]
}
*/

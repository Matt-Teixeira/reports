const { DateTime } = require("luxon");
const process_template = require("../email/process-template");
const {
  col_0_alert,
  col_0_report,
  col_0_warn,
  col_1,
  col_2_less_than,
  col_2_less_than_report,
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

    processed_row += await process_template(col_0_report + col_1, col_0_1_data);

    const less_than_data = {
      field_name: report_meta_data.field_name,
      resolved_field_content: report.helium_value, // Need to change to general name
      threshold_units: report.helium_units
    };
    console.log(less_than_data);
    const greater_than_data = {
      field_name: report_meta_data.field_name,
      resolved_field_content: report.helium_value, // Need to change to general name
      threshold_units: report.helium_units
    };

    processed_row += await process_template(
      col_2_less_than_report,
      less_than_data
    );

    const col_3_data = {
      site_name: report.site_name,
      city: report.city,
      state: report.state
    };

    processed_row += await process_template(col_3_end, col_3_data);
  }
  return processed_row;
};

module.exports = build_email_text;

/* 

'7b8078d8-8093-4cbe-98bb-eb3eae1687c8'
'899bba44-9109-4f7b-9c3b-a60c2c13a265'
'cc239e33-7e61-4ff5-8c57-4a8e9b294c80'
'2d2831a4-8ee3-4349-99af-60fa071ee817'
'3ea8f996-1e82-49e8-9f5a-633ea18e4446'
'091ec9f1-05e8-4877-a51d-de940937eacf'
'106d3f9d-610e-4689-bbb0-e0b730f7d6a6'
'5e32500f-007c-4e9b-9329-efdb598405ab'
'b5aa80e8-26ee-4664-88af-bf92e1f3faeb'
'fa8e6a62-b9a5-46a6-b91a-21e0f25a57a5'
'829215f2-6a31-47fb-b9d2-ba16a00b4117'
'25a5ef45-cc5c-4358-ab07-2ee841d1b03a'
'28863769-685b-44a6-9731-f7cae40d94a7'
'4ad085b8-aae4-4502-befa-0290084e4aee'
'bc9ff7e3-5400-408e-95db-f69cfdc8a997'
'66973fd6-5420-4fe9-b372-c22e7a3a9db5'
'727e2402-d24c-496e-bbe3-c838424b4d08'
'907f18df-6acd-4cc1-ba39-3f7ec4192f1f'
'05c63c3c-0050-4c9b-86bc-25c0e2050e7c'
'b8964879-d41f-49ce-9ff0-9e1cf9b80b28'
'15ecd1d7-388c-42b8-9fe1-4ae464af91b2'
'd9d82347-6e8d-405e-ac99-a02ff969b5dd'
'2ce178c0-7816-4ac2-98b1-0d9b68de0ac6'
'46d60cdc-d9e8-4ad9-87e9-b5f887268413'
'6739c5f9-72b5-475c-9652-848ca8568a0e'

*/

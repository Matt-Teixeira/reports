// TODO: UPDATE TERMINOLOGY
// const alert_data = {
//    view_link:
//       'https://remote2.avantehs.com/machine/' +
//       not.alert.machine_id,
//    time: dt_ny.toFormat('t ZZZZ'), // 9:07 AM EST
//    date: dt_ny.toFormat('DD'), // Aug 6, 2014
//    system_id: not.alert.machine_id,
//    manufacturer: sys_md.manufacturer,
//    modality: sys_md.modality,
//    site_name: sys_md.site_name,
//    city: sys_md.city,
//    state: sys_md.state,
//    field: not.alert.field_name,
//    field_value: not.alert.field_content,
//    condition: not.alert.operator,
//    alert_threshold: not.alert.threshold,
// };

const col_0_alert =
  '<tr class="data-row" style="background-color: white; border-bottom: none;" bgcolor="white">' +
  '<td class="link" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle"><a href="{{view_link}}" style="padding: 2px 6px; border-radius: 6px; text-decoration: none; color: #e51b1d; background-color: #fff2f2;">{{system_id}}</a>' +
  "<br>" +
  '<span class="bot" style="color: darkgrey; font-size: 14px; margin-top: 2px;">{{manufacturer}} · {{modality}}</span>' +
  "</td>";

const col_0_report =
  '<tr class="data-row" style="background-color: white; border-bottom: none;" bgcolor="white">' +
  '<td class="link" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 24px;" align="center" valign="middle"><a href="{{view_link}}" style="padding: 2px 6px; border-radius: 6px; text-decoration: none; color: #005b94; background-color: #E4F7FF;">{{system_id}}</a>' +
  "<br>" +
  '<span class="bot" style="color: darkgrey; font-size: 14px; margin-top: 2px;">{{manufacturer}} · {{modality}}</span>' +
  "</td>";

const col_0_conn_report =
  '<tr class="data-row" style="background-color: white; border-bottom: none;" bgcolor="white">' +
  '<td class="link" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 24px;" align="center" valign="middle"><a href="{{view_link}}" style="padding: 2px 6px; border-radius: 6px; text-decoration: none; color: #005b94; background-color: #E4F7FF;">{{system_id}}</a>' +
  "<br>" +
  '<span class="bot" style="color: darkgrey; font-size: 14px; margin-top: 2px;">{{manufacturer}} · {{modality}}</span>' +
  "<br>" +
  '<span class="bot" style="color: darkgrey; font-size: 14px; margin-top: 2px;">{{name}}</span>' +
  "</td>";

const col_0_72_hr_report =
  '<tr class="data-row" style="background-color: white; border-bottom: none;" bgcolor="white">' +
  '<td class="link" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 24px;" align="center" valign="middle"><a href="{{view_link}}" style="padding: 2px 6px; border-radius: 6px; text-decoration: none; color: #005b94; background-color: #E4F7FF;">{{system_id}}</a>' +
  "<br>" +
  '<span class="bot" style="color: darkgrey; font-size: 14px; margin-top: 2px;">{{manufacturer}} · {{modality}}</span>' +
  "<br>" +
  '<span class="bot" style="color: darkgrey; font-size: 14px; margin-top: 2px;">{{model}}</span>';
("</td>");

const col_0_warn =
  '<tr class="data-row" style="background-color: white; border-bottom: none;" bgcolor="white">' +
  '<td class="link" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle"><a href="{{view_link}}" style="padding: 2px 6px; border-radius: 6px; text-decoration: none; color: #fda005; background-color: #ffeecc;">{{system_id}}</a>' +
  "<br>" +
  '<span class="bot" style="color: darkgrey; font-size: 14px; margin-top: 2px;">{{manufacturer}} · {{modality}}</span>' +
  "</td>";
const col_1 =
  '<td class="dt" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">{{time}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{date}}</div>' +
  "</td>";

const col_2_less_than =
  '<td class="condition" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">{{field_name_alias}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{resolved_field_content}} BELOW {{threshold}}{{threshold_units}}</div>' +
  "</td>";

const col_2_report =
  '<td class="condition" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">{{field_name}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{resolved_field_content}} {{threshold_units}}</div>' +
  "</td>";

const col_2_greater_than =
  '<td class="condition" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">{{field_name_alias}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{resolved_field_content}} ABOVE {{threshold}}{{threshold_units}}</div>' +
  "</td>";

const col_2_equals =
  '<td class="condition" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">{{field_name_alias}} OFF</div>' +
  "</td>";

const col_2_delta_neg =
  '<td class="condition" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">{{field_name_alias}} {{threshold}}{{threshold_units}} DROP</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">24H Min/Max {{resolved_threshold_content}} / {{resolved_field_content}}</div>' +
  "</td>";

const col_2_offline =
  '<td class="condition" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">{{field_name_alias}} {{threshold}}+ {{threshold_units}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">LAST CONN {{resolved_field_content}}</div>' +
  "</td>";

const col_2_contains =
  '<td class="condition" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">{{field_name_alias}}</div>' +
  "</td>";

const col_2_composite_equals =
  '<td class="condition" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">{{field_name_alias}}</div>' +
  "</td>";

const col_3_end =
  '<td class="geo" style="border: none; text-align: left; vertical-align: middle; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">{{site_name}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{city}} · {{state}}</div>' +
  "</td>" +
  "</tr>";

const col_3 =
  '<td class="geo" style="border: none; text-align: left; vertical-align: middle; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">{{site_name}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{city}} · {{state}}</div>';
("</td>");

const col_4_report =
  '<td class="geo" style="padding-left: 1rem; border: none; text-align: left; vertical-align: middle; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Model</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{model}}</div>';
("</td>");

const col_1_72_hr_report =
  '<td class="geo" style="border: none; text-align: left; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Data Points</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{datapoint_count}}</div>';
("</td>");

const col_2_72_hr_report =
  '<td class="geo" style="border: none; text-align: left; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Min Value · {{min_value}} {{unit}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{time}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{date}}</div>' +
  "</td>";

const col_3_72_hr_report =
  '<td class="geo" style="border: none; text-align: left; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Max Value · {{max_value}} {{unit}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{time}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{date}}</div>' +
  "</td>";

const col_1_conn_report =
  '<td class="geo" style="border: none; text-align: left; margin-left: 20px; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Ticket Created At</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{time}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{date}}</div>' +
  "</td>";

const col_2_conn_report =
  '<td class="geo" style="border: none; text-align: left; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Ticket Updated At</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{time}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{date}}</div>' +
  "</td>";

const col_3_conn_report =
  '<td class="geo" style="border: none; text-align: left; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Last Connected</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{time}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{date}}</div>' +
  "</td>";

const col_4_conn_report =
  '<td class="geo" style="border: none; text-align: left; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Last Connection Attempt</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{time}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{date}}</div>' +
  "</td>";
("</tr>");

const col_5_conn_report =
  '<td class="geo" style="border: none; text-align: left; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Manual Intervention</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{intervention_detected}}</div>' +
  "</td>";
("</tr>");

const col_0_issue_tracker_report =
  '<tr class="data-row" style="background-color: white; border-bottom: none;" bgcolor="white">' +
  '<td class="link" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 24px;" align="center" valign="middle"><a href="{{view_link}}" style="padding: 2px 6px; border-radius: 6px; text-decoration: none; color: #005b94; background-color: #E4F7FF;">{{system_id}}</a>' +
  "<br>" +
  '<span class="bot" style="color: darkgrey; font-size: 14px; margin-top: 2px;">{{manufacturer}} · {{modality}}</span>' +
  "<br>" +
  '<span class="bot" style="color: darkgrey; font-size: 14px; margin-top: 2px;">{{name}}</span>' +
  "</td>";

const col_1_issue_tracker_report =
  '<td class="geo" style="border: none; text-align: left; margin-left: 20px; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Ticket Created At</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{time}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{date}}</div>' +
  "</td>";

const col_2_issue_tracker_report =
  '<td class="geo" style="border: none; text-align: left; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Ticket Updated At</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{time}}</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{date}}</div>' +
  "</td>";
("</tr>");

const col_3_issue_tracker_report =
  '<td class="geo" style="border: none; text-align: left; margin-left: 20px; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Notes</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{notes}}</div>' +
  "</td>";

const col_4_issue_tracker_report =
  '<td class="geo" style="border: none; text-align: left; margin-left: 20px; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Diagnoses</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{diagnoses}}</div>' +
  "</td>";

  const col_5_issue_tracker_report =
  '<td class="geo" style="border: none; text-align: left; margin-left: 20px; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Reported By</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{reported_by}}</div>' +
  "</td>";

  const col_0_default_alert_report =
  '<tr class="data-row" style="background-color: white; border-bottom: none;" bgcolor="white">' +
  '<td class="link" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 24px;" align="center" valign="middle"><a href="{{view_link}}" style="padding: 2px 6px; border-radius: 6px; text-decoration: none; color: #005b94; background-color: #E4F7FF;">{{system_id}}</a>' +
  "<br>" +
  "</td>";

  const col_1_default_alert_report =
  '<td class="geo" style="border: none; text-align: left; vertical-align: center; width: 25%; padding: 10px 12px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Alert Model Id</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{alert_model_id}}</div>' +
  "</td>";

  const col_2_default_alert_report =
  '<td class="geo" style="border: none; text-align: left; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Field Name</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{field_name}}</div>' +
  "</td>";

  const col_3_default_alert_report =
  '<td class="geo" style="border: none; text-align: left; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Operator</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{operator}}</div>' +
  "</td>";

  const col_4_default_alert_report =
  '<td class="geo" style="border: none; text-align: left; vertical-align: center; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
  '<div class="top" style="color: #005b94; font-size: 16px;">Enabled</div>' +
  '<div class="bot" style="color: darkgrey; font-size: 14px;">{{enabled}}</div>' +
  "</td>";

module.exports = {
  col_0_alert,
  col_0_report,
  col_0_conn_report,
  col_1_conn_report,
  col_2_conn_report,
  col_3_conn_report,
  col_4_conn_report,
  col_5_conn_report,
  col_0_72_hr_report,
  col_0_warn,
  col_1,
  col_2_less_than,
  col_2_report,
  col_2_greater_than,
  col_2_equals,
  col_2_delta_neg,
  col_2_offline,
  col_2_contains,
  col_2_composite_equals,
  col_3_end,
  col_4_report,
  col_3,
  col_1_72_hr_report,
  col_2_72_hr_report,
  col_3_72_hr_report,
  col_0_issue_tracker_report,
  col_1_issue_tracker_report,
  col_2_issue_tracker_report,
  col_3_issue_tracker_report,
  col_4_issue_tracker_report,
  col_5_issue_tracker_report,
  col_0_default_alert_report,
  col_1_default_alert_report,
  col_2_default_alert_report,
  col_3_default_alert_report,
  col_4_default_alert_report
};

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
   '<br>' +
   '<span class="bot" style="color: darkgrey; font-size: 14px; margin-top: 2px;">{{manufacturer}} · {{modality}}</span>' +
   '</td>';
const col_0_warn =
   '<tr class="data-row" style="background-color: white; border-bottom: none;" bgcolor="white">' +
   '<td class="link" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle"><a href="{{view_link}}" style="padding: 2px 6px; border-radius: 6px; text-decoration: none; color: #fda005; background-color: #ffeecc;">{{system_id}}</a>' +
   '<br>' +
   '<span class="bot" style="color: darkgrey; font-size: 14px; margin-top: 2px;">{{manufacturer}} · {{modality}}</span>' +
   '</td>';
const col_1 =
   '<td class="dt" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">{{time}}</div>' +
   '<div class="bot" style="color: darkgrey; font-size: 14px;">{{date}}</div>' +
   '</td>';

const col_2_less_than =
   '<td class="condition" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">{{field_name_alias}}</div>' +
   '<div class="bot" style="color: darkgrey; font-size: 14px;">{{resolved_field_content}} BELOW {{threshold}}{{threshold_units}}</div>' +
   '</td>';

const col_2_greater_than =
   '<td class="condition" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">{{field_name_alias}}</div>' +
   '<div class="bot" style="color: darkgrey; font-size: 14px;">{{resolved_field_content}} ABOVE {{threshold}}{{threshold_units}}</div>' +
   '</td>';

const col_2_equals =
   '<td class="condition" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">{{field_name_alias}} OFF</div>' +
   '</td>';

const col_2_delta_neg =
   '<td class="condition" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">{{field_name_alias}} {{threshold}}{{threshold_units}} DROP</div>' +
   '<div class="bot" style="color: darkgrey; font-size: 14px;">24H Min/Max {{resolved_threshold_content}} / {{resolved_field_content}}</div>' +
   '</td>';

const col_2_offline =
   '<td class="condition" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">{{field_name_alias}} {{threshold}}+ {{threshold_units}}</div>' +
   '<div class="bot" style="color: darkgrey; font-size: 14px;">LAST CONN {{resolved_field_content}}</div>' +
   '</td>';

const col_2_contains =
   '<td class="condition" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">{{field_name_alias}}</div>' +
   '</td>';

const col_2_composite_equals =
   '<td class="condition" style="border: none; text-align: left; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">{{field_name_alias}}</div>' +
   '</td>';

const col_3_end =
   '<td class="geo" style="border: none; text-align: left; vertical-align: middle; width: 25%; padding: 10px 1px;" width="25%" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">{{site_name}}</div>' +
   '<div class="bot" style="color: darkgrey; font-size: 14px;">{{city}} · {{state}}</div>' +
   '</td>' +
   '</tr>';

module.exports = {
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
   col_3_end,
};
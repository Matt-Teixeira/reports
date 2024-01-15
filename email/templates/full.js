const Handlebars = require('handlebars');

const full =
   '<!DOCTYPE html>' +
   '<html style="margin: 0;">' +
   '<head>' +
   '<meta charset="UTF-8">' +
   '<title>Example Table</title>' +
   '</head>' +
   '<body style="margin: 0;">' +
   '<table class="wrapper" style="border-collapse: collapse; border-spacing: 0; width: 90%; font-family: Kirvante, Helvetica, sans-serif; margin: 0 auto;" width="90%">' +
   '<thead class="banner">' +
   '<tr>' +
   '<td style="border: none; text-align: center; vertical-align: middle; padding: 20px 0;" align="center" valign="middle">' +
   '<img src="data:image/png;base64,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" alt="Avante Health Solutions" style="display: block; height: 35px; margin: 0 auto;" height="35">' +
   '</td>' +
   '</tr>' +
   '</thead>' +
   '<tbody>' +
   '<tr>' +
   '<td style="border: none; text-align: center; vertical-align: middle;" align="center" valign="middle">' +
   '<table class="high" style="border-collapse: collapse; border-spacing: 0; width: 90%; font-family: Kirvante, Helvetica, sans-serif; margin: 0 auto;" width="90%">' +
   '<thead>' +
   '<tr class="header" style="font-style: italic; letter-spacing: 2px; color: #e51b1d; background-color: #fff2f2;" bgcolor="#fff2f2">' +
   '<td colspan="4" style="border: none; text-align: center; vertical-align: middle; padding: 4px 0; border-radius: 6px;" align="center" valign="middle">HIGH SEVERITY ALERTS</td>' +
   '</tr>' +
   '</thead>' +
   '<tbody>' +
   '<tr class="data-row" style="background-color: white; border-bottom: none;" bgcolor="white">' +
   '<td class="link" style="border: none; text-align: center; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle"><a href="https://remote2.avantehs.com/machine/SME01096" style="padding: 2px 6px; border-radius: 6px; text-decoration: none; color: #e51b1d; background-color: #fff2f2;">SME01096</a>' +
   '<br>' +
   '<span class="bot" style="color: darkgrey; font-size: 12px; margin-top: 2px;">GE·MRI</span>' +
   '</td>' +
   '<td class="dt" style="border: none; text-align: center; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">3:15 PM EST</div>' +
   '<div class="bot" style="color: darkgrey; font-size: 12px;">Mar 11, 2023</div>' +
   '</td>' +
   '<td class="condition" style="border: none; text-align: center; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">comp_vib_status = false</div>' +
   '<div class="bot" style="color: darkgrey; font-size: 12px;">equals·0</div>' +
   '</td>' +
   '<td class="geo" style="border: none; text-align: center; vertical-align: middle; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">Piedmont Athens</div>' +
   '<div class="bot" style="color: darkgrey; font-size: 12px;">Athens·GA</div>' +
   '</td>' +
   '</tr>' +
   '</tbody>' +
   '</table>' +
   '<br>' +
   '<table class="med" style="border-collapse: collapse; border-spacing: 0; width: 90%; font-family: Kirvante, Helvetica, sans-serif; margin: 0 auto;" width="90%">' +
   '<thead>' +
   '<tr class="header" style="font-style: italic; letter-spacing: 2px; color: #fda005; background-color: #ffeecc;" bgcolor="#ffeecc">' +
   '<td colspan="4" style="border: none; text-align: center; vertical-align: middle; padding: 4px 0; border-radius: 6px;" align="center" valign="middle">MEDIUM SEVERITY ALERTS</td>' +
   '</tr>' +
   '</thead>' +
   '<tbody>' +
   '<tr class="data-row" style="background-color: white; border-bottom: none;" bgcolor="white">' +
   '<td class="link" style="border: none; text-align: center; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle"><a href="https://remote2.avantehs.com/machine/SME10259" style="padding: 2px 6px; border-radius: 6px; text-decoration: none; color: #fda005; background-color: #ffeecc;">SME10259</a>' +
   '<br>' +
   '<span class="bot" style="color: darkgrey; font-size: 12px; margin-top: 2px;">GE·MRI</span>' +
   '</td>' +
   '<td class="dt" style="border: none; text-align: center; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">3:15 PM EST</div>' +
   '<div class="bot" style="color: darkgrey; font-size: 12px;">Mar 11, 2023</div>' +
   '</td>' +
   '<td class="condition" style="border: none; text-align: center; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">he_level_value = 59.23</div>' +
   '<div class="bot" style="color: darkgrey; font-size: 12px;">less_than·65</div>' +
   '</td>' +
   '<td class="geo" style="border: none; text-align: center; vertical-align: middle; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">Hillcrest And Even More Stuff</div>' +
   '<div class="bot" style="color: darkgrey; font-size: 12px;">Claremore·OK</div>' +
   '</td>' +
   '</tr>' +
   '</tbody>' +
   '</table>' +
   '<br>' +
   '<table class="low" style="border-collapse: collapse; border-spacing: 0; width: 90%; font-family: Kirvante, Helvetica, sans-serif; margin: 0 auto;" width="90%">' +
   '<thead>' +
   '<tr class="header" style="font-style: italic; letter-spacing: 2px; color: darkgrey; background-color: #e6e5e3;" bgcolor="#e6e5e3">' +
   '<td colspan="4" style="border: none; text-align: center; vertical-align: middle; padding: 4px 0; border-radius: 6px;" align="center" valign="middle">LOW SEVERITY ALERTS</td>' +
   '</tr>' +
   '</thead>' +
   '<tbody>' +
   '<tr class="data-row" style="background-color: white; border-bottom: none;" bgcolor="white">' +
   '<td class="link" style="border: none; text-align: center; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle"><a href="https://remote2.avantehs.com/machine/SME01096" style="padding: 2px 6px; border-radius: 6px; text-decoration: none; color: darkgrey; background-color: #e6e5e3;">SME01096</a>' +
   '<br>' +
   '<span class="bot" style="color: darkgrey; font-size: 12px; margin-top: 2px;">GE·MRI</span>' +
   '</td>' +
   '<td class="dt" style="border: none; text-align: center; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">3:15 PM EST</div>' +
   '<div class="bot" style="color: darkgrey; font-size: 12px;">Mar 11, 2023</div>' +
   '</td>' +
   '<td class="condition" style="border: none; text-align: center; vertical-align: middle; min-width: 100px; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">comp_vib_status = false</div>' +
   '<div class="bot" style="color: darkgrey; font-size: 12px;">equals·0</div>' +
   '</td>' +
   '<td class="geo" style="border: none; text-align: center; vertical-align: middle; padding: 10px 1px;" align="center" valign="middle">' +
   '<div class="top" style="color: #005b94; font-size: 16px;">Piedmont Athens</div>' +
   '<div class="bot" style="color: darkgrey; font-size: 12px;">Athens·GA</div>' +
   '</td>' +
   '</tr>' +
   '</tbody>' +
   '</table>' +
   '</td>' +
   '</tr>' +
   '</tbody>' +
   '</table>' +
   '</body>' +
   '</html>';

const full_template = Handlebars.compile(full);
const full_data = {
   view_link: 'https://remote2.avantehs.com/',
   time: '11:45 AM',
   date: 'Feb 2, 2023',
   system_id: 'SME01872',
   manufacturer: 'SIEMENS',
   modality: 'MRI',
   site_name: 'Avante',
   city: 'Concord',
   state: 'NC',
   field: 'he_pressure',
   field_value: '90',
   condition: 'greaterThan',
   alert_threshold: '85',
};
const table_email_text = full_template(full_data);

module.exports = table_email_text;

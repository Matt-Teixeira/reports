const table_header_alert =
   '<table class="high" style="border-collapse: collapse; border-spacing: 0; width: 90%; font-family: Kirvante, Helvetica, sans-serif; margin: 0 auto;" width="90%">' +
   '<thead>' +
   '<tr class="header" style="font-style: italic; letter-spacing: 2px; color: #e51b1d; background-color: #fff2f2;" bgcolor="#fff2f2">' +
   '<td colspan="4" style="border: none; text-align: center; vertical-align: middle; padding: 4px 0; border-radius: 6px;" align="center" valign="middle">ALERTS !</td>' +
   '</tr>' +
   '</thead>' +
   '<tbody>';

const table_header_warn =
   '<table class="med" style="border-collapse: collapse; border-spacing: 0; width: 90%; font-family: Kirvante, Helvetica, sans-serif; margin: 0 auto;" width="90%">' +
   '<thead>' +
   '<tr class="header" style="font-style: italic; letter-spacing: 2px; color: #fda005; background-color: #ffeecc;" bgcolor="#ffeecc">' +
   '<td colspan="4" style="border: none; text-align: center; vertical-align: middle; padding: 4px 0; border-radius: 6px;" align="center" valign="middle">WARNINGS</td>' +
   '</tr>' +
   '</thead>' +
   '<tbody>';

const table_footer = '</tbody>' + '</table>' + '<br>';

module.exports = {
   table_header_alert,
   table_header_warn,
   table_footer,
};

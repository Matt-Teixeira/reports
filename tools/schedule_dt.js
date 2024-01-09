const { DateTime } = require("luxon");

const formatted_dt = (timezone) => {
  const now = DateTime.now().setZone("America/New_York");
  const formatted = now.toFormat("ccc-HH:mm");
  return formatted.toLocaleLowerCase();
};

module.exports = formatted_dt;

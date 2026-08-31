const fs = require("fs");
const path = require("path");

const write_html = (out_dir, system_id, html) => {
  fs.mkdirSync(out_dir, { recursive: true });
  const file_path = path.join(out_dir, `Avante-${system_id}-Magnet-Health.html`);
  fs.writeFileSync(file_path, html);
  return file_path;
};

module.exports = write_html;

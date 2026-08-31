const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const exec_file = promisify(execFile);

// A FRESH archive at the given path, always (subscriptions review F1 —
// CRITICAL): `zip` UPDATES an existing archive rather than replacing it,
// so a reused date-based path silently retained the PREVIOUS recipient's
// PDFs inside the next recipient's zip — a cross-user data leak. Any
// stale file at the path is removed first; callers additionally use
// per-send unique paths so concurrent or interrupted runs cannot collide.
//
// Standalone module with no logger/db imports so the DB-free dev checks
// can regression-test it directly.
const build_fresh_zip = async (zip_path, files) => {
  fs.rmSync(zip_path, { force: true });
  await exec_file("zip", ["-j", zip_path, ...files]);
  return zip_path;
};

module.exports = { build_fresh_zip };

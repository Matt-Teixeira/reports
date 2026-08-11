// Strict CLI parsing for `npm start sme_report` invocations (Phase B
// review F2: `--config abc` parsed to NaN, fell through the truthiness
// check, and executed the LIVE slot batch instead of one row). Pure and
// loud: every token must be recognized, every value must validate, and a
// parse error aborts before any run state exists.

const SLOT_RE = /^(sun|mon|tue|wed|thu|fri|sat)-([01]\d|2[0-3]):[0-5]\d$/;

const fail = (msg) => {
  throw new Error(`sme_report arguments invalid: ${msg}`);
};

const parse_sme_args = (args) => {
  const out = { request_path: null, slot: null, config_id: null, force_dry_run: false };
  for (let i = 0; i < (args || []).length; i++) {
    const a = args[i];
    if (a.endsWith(".json")) {
      if (out.request_path) fail("more than one request file given");
      out.request_path = a;
      continue;
    }
    if (a === "--dry-run") {
      out.force_dry_run = true;
      continue;
    }
    if (a === "--slot") {
      const v = args[++i];
      if (!v || !SLOT_RE.test(v)) fail(`--slot requires day-HH:MM (e.g. mon-08:00), got "${v ?? ""}"`);
      out.slot = v;
      continue;
    }
    if (a === "--config") {
      const v = args[++i];
      // Anchored integer: "abc", "1junk", "0", and "-3" all fail here
      // rather than silently selecting the wrong mode or row.
      if (!v || !/^[1-9]\d*$/.test(v)) fail(`--config requires a positive integer row id, got "${v ?? ""}"`);
      out.config_id = parseInt(v, 10);
      continue;
    }
    fail(`unknown argument "${a}"`);
  }
  if (out.request_path && (out.slot !== null || out.config_id !== null || out.force_dry_run))
    fail("file mode takes no scheduler flags (--slot/--config/--dry-run)");
  return out;
};

module.exports = { parse_sme_args, SLOT_RE };

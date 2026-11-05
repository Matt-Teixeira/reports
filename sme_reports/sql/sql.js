const { QueryFile } = require("pg-promise");
const { join: joinPath } = require("path");

// Local QueryFile registry for the SME report paradigm. These queries live in
// this repo (not utils/db/sql) because utils/ is a separate shared repository
// git-ignored here — keeping them local keeps them version controlled.
const sql = (file) => {
  const fullPath = joinPath(__dirname, file);
  return new QueryFile(fullPath, { minify: true });
};

// "The latest N rows BEFORE the window" for a vendor series query: the same
// columns and table, with the window's BETWEEN replaced by `< $2` and the
// order reversed. Derived from the series file itself so the two can never
// drift; a file whose shape changes fails loudly here at load, never
// silently at run time. Used only for the compressor merge's boundary
// context (data.fetch_boundary_context).
const { readFileSync } = require("fs");
const before_sql = (file, limit) => {
  let text = readFileSync(joinPath(__dirname, file), "utf8");
  for (const [a, b] of [
    ["AND capture_datetime BETWEEN $2 AND $3", "AND capture_datetime < $2"],
    ["ORDER BY capture_datetime ASC", `ORDER BY capture_datetime DESC\nLIMIT ${limit}`]
  ]) {
    if (text.split(a).length !== 2) throw new Error(`${file}: cannot derive its before-window query (expected exactly one "${a}")`);
    text = text.replace(a, b);
  }
  return text;
};
const BEFORE_ROWS = 336; // ~7 days at the usual 30-min cadence

module.exports = {
  BEFORE_ROWS,
  // Keyed by fetch_series' `source`, so the context reads the same table.
  series_before: {
    "mag.philips_mri_monitoring_data_agg": before_sql("philips-series.sql", BEFORE_ROWS),
    "mag.ge_mm3": before_sql("ge-mm3-series.sql", BEFORE_ROWS),
    "mag.ge_mm4": before_sql("ge-mm4-series.sql", BEFORE_ROWS),
    "mag.siemens": before_sql("siemens-series.sql", BEFORE_ROWS),
    // No compressor channel, but its host times let the thermal stale
    // filter judge the first in-window shield reading (Codex round 4, F2).
    "mag.siemens_non_tim": before_sql("siemens-non-tim-series.sql", BEFORE_ROWS)
  },
  get_system_identity: sql("get-system-identity.sql"),
  scope_systems: sql("scope-systems.sql"),
  config_slot: sql("config-slot.sql"),
  config_by_id: sql("config-by-id.sql"),
  audience_users: sql("audience-users.sql"),
  mag_system_ids: sql("mag-system-ids.sql"),
  mag_system_customers: sql("mag-system-customers.sql"),
  user_caches: sql("user-caches.sql"),
  insert_send: sql("insert-send.sql"),
  philips_series: sql("philips-series.sql"),
  ge_mm3_series: sql("ge-mm3-series.sql"),
  ge_mm4_series: sql("ge-mm4-series.sql"),
  siemens_series: sql("siemens-series.sql"),
  siemens_non_tim_series: sql("siemens-non-tim-series.sql"),
  get_default_thresholds: sql("get-default-thresholds.sql"),
  get_mag_routing: sql("get-mag-routing.sql"),
  site_group_users: sql("site-group-users.sql"),
  customer_users: sql("customer-users.sql"),
  units_queries: {
    PHILIPS: sql("units-philips.sql"),
    GE: sql("units-ge.sql"),
    SIEMENS: sql("units-siemens.sql"),
    SIEMENS_NON_TIM: sql("units-siemens-non-tim.sql")
  },
  edu_config: sql("edu-config.sql"),
  edu_series: {
    v1: sql("edu-v1-series.sql"),
    v2: sql("edu-v2-series.sql"),
    v3: sql("edu-v3-series.sql")
  }
};

const { QueryFile } = require("pg-promise");
const { join: joinPath } = require("path");

// Local QueryFile registry for the SME report paradigm. These queries live in
// this repo (not utils/db/sql) because utils/ is a separate shared repository
// git-ignored here — keeping them local keeps them version controlled.
const sql = (file) => {
  const fullPath = joinPath(__dirname, file);
  return new QueryFile(fullPath, { minify: true });
};

module.exports = {
  get_system_identity: sql("get-system-identity.sql"),
  philips_series: sql("philips-series.sql"),
  ge_mm3_series: sql("ge-mm3-series.sql"),
  ge_mm4_series: sql("ge-mm4-series.sql"),
  siemens_series: sql("siemens-series.sql"),
  get_default_thresholds: sql("get-default-thresholds.sql"),
  get_mag_routing: sql("get-mag-routing.sql"),
  units_queries: {
    PHILIPS: sql("units-philips.sql"),
    GE: sql("units-ge.sql"),
    SIEMENS: sql("units-siemens.sql")
  },
  edu_config: sql("edu-config.sql"),
  edu_series: {
    v1: sql("edu-v1-series.sql"),
    v2: sql("edu-v2-series.sql"),
    v3: sql("edu-v3-series.sql")
  }
};

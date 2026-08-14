// Compressor-state provenance vocabulary (RULES.md §6). The source strings
// originate in vendors.js `compressor.source` plus the per-system EDU
// override in render/model.js:
//
//   "cryo_comp_malf_value"  Philips — reported by the system
//   "compressor_status"     Siemens 4K — reported by the system
//   "edu_comp_vib"          EDU vibration sensor — MEASURED
//   "coldhead_ruo_value"    GE fallback — INFERRED from coldhead temperature
//
// Only the inference carries the ᶜ provenance mark ("conclusions, and only
// conclusions"). Every surface that prints the mark — brief tiles, the
// narrative's state words, the fleet compressor cell — shares this
// predicate, so the documents can never disagree about which states are
// concluded rather than read.
const is_inferred = (source) => source === "coldhead_ruo_value";

module.exports = { is_inferred };

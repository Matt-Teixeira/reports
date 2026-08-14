// Compressor-state provenance vocabulary (RULES.md §6) — a CLOSED registry.
// The source strings originate in vendors.js `compressor.source` plus the
// per-system EDU override in render/model.js. Every lookup resolves through
// source_kind, which throws on anything unregistered: a new or typoed
// source must never fail open as "measured" — that would skip the
// derived-reading screening and drop every ᶜ mark, silently presenting a
// conclusion as a reading.
const SOURCE_KIND = {
  cryo_comp_malf_value: "reported", // Philips — reported by the system
  compressor_status: "reported", // Siemens 4K — reported by the system
  edu_comp_vib: "measured", // EDU vibration sensor — measured
  coldhead_ruo_value: "inferred" // GE fallback — inferred from coldhead temp
};

const source_kind = (source) => {
  const kind = SOURCE_KIND[source];
  if (!kind)
    throw new Error(
      `unknown compressor source "${source}" — register it in compute/provenance.js SOURCE_KIND`
    );
  return kind;
};

// Only inferences carry the ᶜ provenance mark ("conclusions, and only
// conclusions"). Shared by the brief tiles, the narrative's state words,
// and the fleet compressor cell, so the surfaces can never disagree about
// which states are concluded rather than read.
const is_inferred = (source) => source_kind(source) === "inferred";

module.exports = { SOURCE_KIND, source_kind, is_inferred };

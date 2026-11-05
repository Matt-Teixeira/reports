// Boundary context is optional (data.fetch_boundary_context): it only
// sharpens the compressor merge's edge checks. A failure fetching it must
// never fail a report that its own window's data can carry (Codex round 4,
// F1). The report continues without context, exactly as a window with no
// neighbouring readings would, and the caller logs the reason.
//
// Pure: no database import, so dev/check_compute.js exercises it directly.
const with_context_fallback = async (fetch) => {
  try {
    return { context: await fetch(), context_error: null };
  } catch (error) {
    return { context: null, context_error: (error && error.message) || String(error) };
  }
};

module.exports = { with_context_fallback };

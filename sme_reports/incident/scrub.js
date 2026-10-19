// The Avante scrub for customer-facing activity pages: ONE rule, applied to
// the raw rows BEFORE analysis, so no tile, filter, count, note or table
// downstream can ever see — or reveal by its absence — an Avante user.
//
// A recipient is Avante's when "avante" appears anywhere in the address
// (avantehs.com, avante-hs.com, avantehealth..., a personal address with the
// name in it) or in the user's first or last name. Matching is
// case-insensitive and deliberately broad: a false positive drops one
// recipient from a customer's page; a false negative shows a customer an
// Avante staff address, which the page promises never to do.
//
// Pure: no I/O. dev/check_system_pages.js exercises it.

const AVANTE = /avante/i;

const is_avante_user = (email, user) =>
  AVANTE.test(String(email || "")) ||
  (user ? AVANTE.test(String(user.first_name || "")) || AVANTE.test(String(user.last_name || "")) : false);

// rows: { notifications, recipients } as incident/sql returns them.
// Returns the scrubbed rows plus the dropped-address count — for the RUN LOG
// only; callers must never put it on a page.
const scrub_avante = ({ notifications, recipients }) => {
  const user_by_email = new Map(recipients.map((u) => [String(u.email_address).toLowerCase(), u]));
  const dropped = new Set();
  const keep = (email) => {
    const key = String(email || "").toLowerCase();
    if (is_avante_user(key, user_by_email.get(key))) {
      dropped.add(key);
      return false;
    }
    return true;
  };
  return {
    notifications: notifications.filter((n) => keep(n.user_id)),
    recipients: recipients.filter((u) => keep(u.email_address)),
    dropped_addresses: dropped.size
  };
};

module.exports = { scrub_avante, is_avante_user, AVANTE };

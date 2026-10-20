// The Avante scrub for customer-facing activity pages: ONE rule, applied to
// the raw rows BEFORE analysis, so no tile, filter, count, note or table
// downstream can ever see — or reveal by its absence — an Avante user.
//
// A recipient is Avante's when "avante" appears anywhere in the address
// (avantehs.com, avante-hs.com, avantehealth..., a personal address with the
// name in it) or in the user's first or last name, OR when their app roles
// include a staff-only role (superuser, network, developer — no customer
// account carries one; "admin" and "site-admin" are customer roles).
// Matching is case-insensitive and deliberately broad: a false positive
// drops one recipient from a customer's page; a false negative shows a
// customer an Avante staff address, which the page promises never to do.
//
// The same test labels Avante users on INTERNAL pages (avante_keys), where
// nobody is removed.
//
// Pure: no I/O. dev/check_system_pages.js exercises it.

const AVANTE = /avante/i;
const STAFF_ROLES = ["superuser", "network", "developer"];

const is_avante_user = (email, user) =>
  AVANTE.test(String(email || "")) ||
  (user
    ? AVANTE.test(String(user.first_name || "")) ||
      AVANTE.test(String(user.last_name || "")) ||
      (user.roles || []).some((r) => STAFF_ROLES.includes(String(r).toLowerCase()))
    : false);

// rows: { notifications, recipients } as incident/sql returns them. The
// lowercased address of every notified or listed Avante user.
const avante_keys = ({ notifications, recipients }) => {
  const user_by_email = new Map(recipients.map((u) => [String(u.email_address).toLowerCase(), u]));
  const keys = new Set();
  for (const email of [...notifications.map((n) => n.user_id), ...recipients.map((u) => u.email_address)]) {
    const key = String(email || "").toLowerCase();
    if (is_avante_user(key, user_by_email.get(key))) keys.add(key);
  }
  return keys;
};

// Returns the scrubbed rows plus the dropped-address count — for the RUN LOG
// only; callers must never put it on a page.
const scrub_avante = (rows) => {
  const dropped = avante_keys(rows);
  const keep = (email) => !dropped.has(String(email || "").toLowerCase());
  return {
    notifications: rows.notifications.filter((n) => keep(n.user_id)),
    recipients: rows.recipients.filter((u) => keep(u.email_address)),
    dropped_addresses: dropped.size
  };
};

module.exports = { scrub_avante, avante_keys, is_avante_user, AVANTE, STAFF_ROLES };

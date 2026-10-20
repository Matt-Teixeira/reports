# Plan — per-system activity pages on fleet and customer summaries

Drafted 2026-10-19. For every system in a fleet or customer summary that
shows an issue, add one interactive HTML page to the summary email — the
Anomaly Report's timeline (`incident/`, see `PLAN-ANOMALY-REPORT.md`)
without the story: alert detections, notifications and readings, with the
lanes, filters, slot table and detail pane, and **no hypothesis, evidence
lines, inferred delivery status, or any other conjecture**.

## Decided (2026-10-19)

- **Who gets a page:** every system that is `is_attention` **or**
  `is_data_issue` (`conditions.js`). A data issue (sensor-suspect chain, or
  a compressor reading "off" all window with no thermal response) is a
  monitoring problem, and its detections/notifications are exactly where
  the cause shows up — so it gets a page too.
- **Delivery:** the pages are zipped and batched — one zip on the summary
  email when it fits, size-split into "part n/N" emails when it does not
  (same O365 budget as `send_batch_email.js`: `CHUNK_PDF_BYTES`, ~25 MB
  after base64).
- **Audience: external (customers).** (v2 adds an internal copy — see
  the 2026-10-20 update.) Nothing relating to Avante users appears on a
  customer page: no Avante recipient, address, name or count — not
  even "N Avante recipients hidden". Avante's own branding (logo, palette,
  footer) stays; it is Avante's report.

## What the page shows

From the Anomaly Report's external version, keeping:

- system tiles (system, equipment + serial, site + address, customer +
  site group, monitoring feeds) and period tiles (period, readings,
  detections, notifications, recipients reached);
- swimlanes — Data, Detections, Notifications — with y-axis min/max;
- alert-model and recipient filters;
- day-grouped slot table and detail pane (readings, the raw
  `alert.detections` columns, notifications by recipient);
- Eastern / Site / UTC and clock toggles; method note; footer.

Removing: Hypothesis, "What the data shows", Steps for improvement,
"expected, not detected" (it predicts what *should* have triggered —
conjecture), re-create queries, and the late / never-received delivery
status (inferred from the alert engine's log, not observed). A slot shows
what is in the database — a reading or no reading — and nothing about why.

## Build

### 1. A no-conjecture analysis (`incident/activity.js`, pure)

New module beside `analyze.js`, not a mode of it: the Anomaly Report keeps
working unchanged. Builds the 30-minute slot spine over the window, puts
the readings, the detection runs and the notifications in their slots, and
computes per-model and per-recipient counts. No stop, outage, timing or
batch inference, and it never throws on "no compressor stop".

### 2. Vendor-agnostic readings

Use the canonical series `run_one` already fetched
(`{ t, pressure, helium, compressor_on, coldhead_k, shield_k, ... }` via
`normalize.js` / `vendors.js`) for every vendor, instead of
`incident/sql/ge-mm3-readings.sql`. `run_one` currently drops the series
after the summary facts are built; return it on the result only when the
request asks for system pages, so other runs carry nothing extra.

### 3. The alert reads, for selected systems only

After classification, for each selected system: `alert-models.sql`,
`detections.sql`, `notifications.sql`, `recipients.sql`, `system-meta.sql`
(all exist in `incident/sql/`). Running these only for selected systems
avoids querying healthy systems. Each system's page is isolated
like the site-group users lookup: a failure is logged and named in the
email ("page unavailable for SMEnnnnn"), never fatal and never silent.

### 4. The Avante scrub (`incident/scrub.js`, one rule, applied once)

Drop a recipient when `/avante/i` matches the address **or** the user's
first/last name; drop their notifications before anything is counted, so
no tile, filter, count or note can reveal them. Applied to the data before
analysis, so nothing downstream ever sees an Avante row. (Today's page
filters at render time and still counts them in the internal notes.)

### 5. The page (`incident/system_page.js`)

Built from `timeline.js`'s sections and CSS, driving the existing
`timeline.client.js` unchanged where possible. Light only, Helvetica, no
external requests (opens offline from a zip). One file per system:
`Avante-<system>-Activity-<period tag>-<date>.html`.

### 6. Wiring

- **Opt-in:** `options.system_pages: true` on the batch (DB config row
  `options` jsonb; one-off job config / `--system-pages` flag). Default
  off, so existing scheduled rows and jobs behave exactly as today.
- In `run_batch`, after `build_fleet_summary`: select systems, build
  pages, zip, then hand the zip(s) to `send_summary_email`.
- Applies to `fleet_summary`, `customer_summary` and `user_summary` — the
  pages follow the summary's own scope, so a customer only ever receives
  pages for the systems already in its document.

### 7. Checks (`dev/check_system_pages.js`)

Synthetic fixtures, matching the other `dev/check_*.js`:

- selection = attention ∪ data issue, nothing else;
- one GE, one Siemens, one Philips series render without error;
- **no Avante email address or Avante user name anywhere on a page**
  (regex over the full HTML, with the branding strings allowlisted);
- none of the removed sections' headings or markers present;
- byte-identical output for the same inputs (no `Date.now()`);
- each page loads in puppeteer with zero page errors;
- zip chunking honours the size budget.

## Resolved (2026-10-19, second round)

1. **Window = the summary's own window.** A 6-month summary is ~8,760
   slots and possibly tens of thousands of detection rows per system
   (SME21284 had 613 in 7 days), so page size and browser responsiveness
   are measured on a real 6-month system as part of the build, and the
   page is made to cope — not the window shortened.
2. **Non-Avante recipients outside the customer are kept** (e.g.
   contractors whose access spans several customers). The only scrub
   rule is the Avante one. No customer recipients are configured yet:
   test sends go to the job's default address only.
3. **Failed systems get a page.** A system that failed analysis (e.g. "no
   monitor data") has no facts or classification, so its page carries
   the detections and notifications with whatever readings exist (often
   none), and says it could not be analyzed — not why.
4. **Limited-coverage systems: no page — out of scope here.** The owner
   considers the limited-coverage treatment itself wrong; that is a
   separate update to the reports, and these pages follow it if and when
   it lands.

## Status (2026-10-19) — v1 built

Built as planned, on the `run_batch` path (request files and the one-off
CLI: `fleet_summary`, `customer_summary`), opt-in via
`batch_email.system_pages` / job `system_pages` / `--system-pages`.

| Piece | File |
|---|---|
| readings carried out of the analysis | `compute/analyze.js` (`views.compressor_rows`), `index.js` `run_one(..., { activity })` |
| alert reads | `incident/activity_data.js`, `incident/sql/activity-notifications.sql` |
| Avante scrub | `incident/scrub.js` |
| facts | `incident/activity.js` |
| page | `incident/system_page.js` (+ shared `timeline.js` CSS, `timeline.client.js`) |
| select, build, zip | `incident/system_pages.js` |
| delivery | `output/send_summary_email.js` (part 1), `output/send_activity_parts.js` (2..N) |
| checks | `dev/check_system_pages.js` (`npm run check:system-pages`) |

The shared browser script gained payload-driven options (vendor labels,
units and decimals, a floating primary-axis floor, null-safe cells,
`org_order`, `recipients_label`, `data_sub`), thinned day ticks, merged
compressor runs and one detection mark per pixel column. Defaults keep
the Anomaly Report's payload rendering as before.

Measured on Piedmont HealthCare (C0137), 6 months, 43 systems: 21 pages
(9 flagged, 12 failed "no monitor data"), ~30 s for the pages, 0.9–2.4 MB
each, one 7.2 MB zip; no Avante address in any page; every page loads in
~1 s with zero page errors; row clicks, filters and zone switches
70–390 ms ("Expand all" on 182 days: 2–3 s). The notifications query was
the one hot spot — 23 s per system against every user's model copies,
0.4 s against the default models (same rows; verified).

## Update (2026-10-20) — v2: two audiences, scheduled delivery, pilot gate

Decided with the owner:

- **Internal and external copies.** `system_pages` is now `true` (the
  summary's own audience: **fleet → internal, customer → external**),
  `"internal"`, or `"external"`; CLI `--system-pages` /
  `--pages-audience internal|external`. The external copy is the v1 page.
  The internal copy keeps every recipient, groups Avante staff first under
  "Avante", and says Internal in the header tag, `<title>`, method note,
  page file name (`Avante-<sys>-Activity-Internal-…`), zip name and
  follow-up subjects, so it cannot pass for the customer copy. Neither
  copy carries any interpretation. Rules: `incident/page_policy.js`.
- **Scheduled delivery** for `customer_summary` and `fleet_summary`
  `alert.sme_reports` rows: `options.system_pages` → `config_to_raw` →
  `run_batch` builds the pages → `run_scheduled.deliver_explicit` attaches
  part 1 to the summary email and sends parts 2..N to the same envelope
  once the summary reached someone; zips are removed after delivery (dry,
  live or failed). A failed follow-up part fails the run without touching
  the summary's sends rows. `user_summary` rows reject the option
  ("not implemented") — per-subscriber digests are a separate build.
- **Pilot gate:** any run that emails pages may address only
  `PILOT_RECIPIENTS` (`matt.teixeira@avantehs.com`; Joe Anello and
  Jonathan Pope added the same day for the Friday C0137 rows), To and CC
  alike —
  checked by the request loader (one-off/file runs that send), by
  `validate_config` on every row (dry rows too, so flipping `dry_run`
  cannot unlock a send), and again at send time (a refusal withholds the
  pages, not the summary, and fails the run). Permanent rule beside it:
  internal pages go only to `@avantehs.com`. Widen the pilot list in code
  review when the pages are cleared for customers.
- **Scrub by role too:** a user whose app roles include `superuser`,
  `network` or `developer` is Avante's even when address and name do not
  say so (all 19 such users today also match `/avante/i`; this closes the
  gap for the next one). Recipients now come from
  `sql/activity-recipients.sql`, which carries `roles` and no longer drops
  users whose `system_list_config` is not an array. **DB grant:** the
  run's role needs SELECT on `public.users.roles` as well.
- **Downscaled logo** (`render/assets/logo_small.js`, 360×92, 11 KB of
  base64, generated by `dev/gen_logo_small.js`) instead of the 9779×2500
  original (422 KB, ~240 KB of every zipped page). Piedmont 6-month: zip
  7.5 → 2.3 MB. Fleet 6-month: 4 zips → 2.

Measured on the non-Docker DEV host (2026-10-20, production data):
Piedmont 23 external pages in ~25 s, 0.6–2.4 MB each, one 2.3 MB zip;
fleet 108 internal pages in ~86 s, 0.4–6.8 MB each, 12.2 + 0.4 MB zips;
the largest internal page (SME15807, 6.8 MB) loads in 3.3 s, "Expand all"
2.3 s, zero page errors. The scheduled path was driven end to end with
stubbed SMTP and sends-row writes (refused envelope, dry row, live
customer row, live 6-month fleet row with two parts).

**Anomaly Report regression on real data — done.** That host's database
carries SME21284's Oct 9–11 event: `incident/run.js` at cb2c438 and after
this feature embeds identical data (internal and external) and loads with
zero errors; the one visible change is the intended merged compressor
runs (one solid bar instead of per-slot blocks).

**Not yet:**

- **Pages on `user_summary`** (the per-subscriber weekly digest) —
  rejected loudly until built.
- **Archiving the emailed zips** beside the archived summary PDF; today
  the pages stay in `out/` (scratch) and the zips are removed after send.
- **Site-local time.** Eastern and UTC only — the database carries no site
  time zone.
- **Limited-coverage systems** — out of scope (Resolved 4).

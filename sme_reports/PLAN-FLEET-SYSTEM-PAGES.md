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
- **Audience: external (customers).** Nothing relating to Avante users
  appears on a page: no Avante recipient, address, name or count — not
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

**Not yet:**

- **Scheduled delivery.** `run_scheduled` / `fanout.js` deliver summaries
  through their own send loop (`summary: false` into `run_batch`), so
  `options.system_pages` on an `alert.sme_reports` row is not wired.
  Next step if scheduled summaries should carry pages.
- **Site-local time.** Eastern and UTC only — the database carries no site
  time zone.
- **Limited-coverage systems** — out of scope (Resolved 4).
- **Anomaly Report regression on real data** could not be run here: this
  staging copy ends SME21284's readings on Oct 8, before the Oct 9–11
  event, so `incident/run.js` stops at "no compressor stop" on any
  version of the code. Its payload builder is unchanged; the shared
  client changes are covered by `check_system_pages.js` in Chromium.

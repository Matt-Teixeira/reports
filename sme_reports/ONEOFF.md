# One-off reports — run a report by hand

Everything in `sme_reports/oneoff/` exists for operator-run reports: a
customer's summary document by customer id, a Magnet Health Brief for one
or more MRIs, the internal fleet summary — on any supported period,
including the **6-month** one.

It is a thin layer. A job is composed into the *same* request object a
request file describes, then handed to the *same* loader, batch runner,
renderers and senders the scheduled product uses. Nothing here is on the
scheduled path: deleting this directory would leave cron, `npm start
sme_report`, and every file in `requests/` untouched.

## Running

```bash
npm run report:list                                  # what jobs exist
npm run report:customer -- --customer C0137 --period 6mo
npm run report:sme      -- --system SME19034 --period 6mo
npm run report:customer-briefs -- --customer C0137 --period 7d   # every brief, one zip email
npm run report:fleet    -- --period 6mo
npm run report:sme      -- --system SME21284 --from "2026-10-09 14:00" --to "2026-10-11 18:00"
npm run report:sme      -- --system SME21284 --to 2026-10-12 --period 7d   # the 7 days before
npm run report -- customer                           # any job by name
```

Documents land in `sme_reports/out/` (override with `--out-dir`). **Nothing
is emailed** unless the job says `"email": true` or you pass `--email` —
the summary document is still built either way, so a one-off run is safe
to fire while you are deciding what it should say.

| Flag | Effect |
|---|---|
| `--period <spec>` | `7d`, `30d`, `90d`, `6mo`, or a plain day count — the rolling period ending today (drops any window the job config sets) |
| `--from <when>` / `--to <when>` | an explicit window — see [Windows](#windows) |
| `--tz <zone>` | the zone `--from`/`--to` are read in when they carry no `Z` or offset (default `America/New_York`) |
| `--customer <id>` | customer_summary and sme_brief jobs — overrides the scope (for a brief job it replaces any explicit system list) |
| `--system <SME#####>` | repeatable, comma lists accepted; narrows a brief job's systems (or a customer-scoped job to an explicit set) |
| `--out-dir <path>` | where documents are written |
| `--email` / `--no-email` | send, or don't (default) |
| `--system-pages` | customer_summary and fleet_summary jobs — also build a System Activity page per flagged system (see below) |
| `--config <path>` | a different job config file |
| `--list` | list configured jobs and exit |

A typo'd flag or period aborts before any work starts — never a run with
different settings than you typed.

## The config

`sme_reports/oneoff/jobs.config.json` is the file to edit. `defaults`
apply to every job; each job overrides what it needs. Keys starting with
`_` are comments (JSON has none). **Unknown keys are rejected**, so a
misspelled setting fails loudly instead of silently keeping the default.

```jsonc
{
  "defaults": {
    "period": "30d",
    "recipients": ["matt.teixeira@avantehs.com"],
    "email": false
  },
  "jobs": {
    "customer": { "kind": "customer_summary", "customer_id": "C0137", "period": "6mo" },
    "sme":      { "kind": "sme_brief", "system_ids": ["SME21824"], "period": "6mo" },
    "customer-briefs": { "kind": "sme_brief", "customer_id": "C0137", "zip": true, "email": true },
    "fleet":    { "kind": "fleet_summary", "period": "6mo", "exclude": ["SME13604"] }
  }
}
```

Add as many jobs as you like — one per customer you report on regularly,
for instance — and run them by name.

| Job kind | What it produces | Extra keys |
|---|---|---|
| `customer_summary` | one scoped Magnet Health Summary PDF (customer-facing wording, scope stated on the cover) | exactly one of `customer_id`, `site_ids`, `system_ids`; `exclude`, `exclude_note`, `system_pages`, `system_pages_format` |
| `sme_brief` | one Magnet Health Brief PDF + HTML per system | exactly one of `customer_id` (every mag system under the customer), `system_ids`; `zip` (bundle an emailed batch into one archive at any size — batches over 4 PDFs zip regardless) |
| `fleet_summary` | the internal fleet document over every mag-processed system | `exclude`, `exclude_note`, `system_pages`, `system_pages_format` |

Common settings: `period`, `recipients`, `cc_list`, `email`, `out_dir`,
`archive` (keep a dated copy of a brief in `archive/`), `summary_pdf` (add
a summary document to an emailed brief batch — it arrives as a second
email, since that email is what delivers it; without it an emailed brief
batch is exactly one message), `archive_records` (write a history sidecar
— **off** by default here, so exploring a period never deposits rows in
the scheduled product's history series), `description`.

Recipients are required even when nothing is sent: the loader uses the
address as a report's fallback recipient, and requiring it here names the
problem at the config rather than deep in request validation.

## Periods

The period vocabulary is shared (`sme_reports/periods.js`) — one place
that knows a span's day count, its filename tag and its subject wording,
so a document and the email announcing it can never name it differently.

| Spec | Days | Artifact tag | Subject wording |
|---|---|---|---|
| `7d` (`1w`, `weekly`) | 7 | `-7d` | 7-day |
| `30d` (`1mo`, `monthly`) | 30 | *(none — the default)* | *(none)* |
| `90d` (`3mo`, `quarter`) | 90 | `-90d` | 90-day |
| `6mo` (`180d`, `180`, `6-month`) | 180 | `-6mo` | 6-month |
| any other day count | N | `-Nd` | N-day |

Request files accept the same vocabulary as `"period"`, at batch level or
inside a `window`, wherever `lookback_days` was accepted:

```json
{ "scope": { "customer_id": "C0137" }, "period": "6mo", "summary_only": true }
```

`period` and `lookback_days` are the same setting — naming both is a
request error, not a precedence rule between two numbers that may
disagree.

## Windows

A report can cover any two instants instead of a period ending today.

```bash
npm run report:sme -- --system SME21284 --from "2026-10-09 14:00" --to "2026-10-11 18:00"
npm run report:customer -- --from 2026-10-01 --to 2026-10-31          # October, Eastern days
npm run report:sme -- --system SME21284 --to 2026-10-12T17:00 --period 7d
npm run report:fleet -- --from 2026-10-09T18:00Z --to 2026-10-11T22:00Z
```

| Given | Window |
|---|---|
| `--from` + `--to` | exactly those bounds |
| `--to` (+ the job's or `--period`'s period) | the period counting back from `--to` |
| `--from` alone | from then through today |
| neither | the rolling period ending today (unchanged) |

- **A date is a whole day** (`2026-10-09` = that day's midnight to
  midnight); **a date-time is that exact instant** (`2026-10-09T14:00`,
  `"2026-10-09 14:00"`, seconds optional).
- **Zone:** a bound without `Z` or an offset is read in `--tz`, default
  `America/New_York`. `--tz America/Chicago`, `--tz UTC`. A `Z` or
  `-05:00` on the bound always wins.
- **Refused before any work:** `--from` with `--period` (a window with a
  start is fixed by its ends), `--tz` without a window, a bound in the
  future, `from` not before `to`, a window under 1 hour, and anything
  that is not one of the forms above.
- The console line printed before the run states the window in its zone
  **and** as UTC instants — check it there.

Jobs take the same settings as `from`, `to` and `tz` keys
(`from` + `period` in one job is an error; `from`/`to` are not allowed in
`defaults` — a window belongs to a job). On the command line the window
travels as a unit: `--from`/`--to` replace the job's whole window, and
`--period` alone drops it.

```jsonc
"sme21284-event": { "kind": "sme_brief", "system_ids": ["SME21284"],
                    "from": "2026-10-09T14:00", "to": "2026-10-11T18:00" }
```

**What the reader sees.** Every place that states the span words it the
same way (`periods.js` `span_text`): `Oct 9 14:00 – Oct 11 18:00 ET`,
or `Oct 1 – Oct 31 ET` for whole days, on the brief's sub-line, the
summary cover and footers, the activity pages and both emails (the
summary subject names the window instead of a period). The brief's chart
headings name only the days (`OCT 9 → OCT 11`) to stay on one line, and
the chart axis labels its ends with their UTC times (`10-09 18:00Z`)
whenever the window does not sit on whole UTC days. Everything else in
the brief stays UTC, as before.

**Artifact names** carry the window's ends, in its zone, in place of the
period tag — `…-Magnet-Health-20261009T1400-to-20261011T1800-<date>.pdf`,
`…-Summary-20261001-to-20261031-<date>.pdf` — so a window can never
overwrite, or pass for, the 30-day document from the same day.

**No history records.** An explicit window never writes a records
sidecar, even with `archive_records: true`: the archived series is the
scheduled product's period history, and an investigation is not a point
in it. The console line says so.

**Request files** take the same bounds in `window.start` / `window.end`,
plus an optional `window.tz` — which defaults to **UTC** there, so every
existing request file's window is unchanged. The one difference: a
date-time bound used to be moved silently to its day's boundary; it is
now the instant written.

The scheduled config table is unchanged — scheduled reports are always
rolling periods.

## What a 6-month period changes

Nothing in the detection rules: they are period-agnostic (RULES.md §5).
What differs is what the window contains, and the report already handles
it — charts switch to the daily min/max band past 500 captures, the
brief's story is bounded (the other-events day list caps at four days,
and dense pages take the compact tier), and the summary document paginates
deterministically. Verified on live data: a 6-month brief for SME19034
(event-heavy Philips) left 564 px of page slack, and Piedmont's 43-system
6-month summary rendered 8 pages with every page inside its bounds.

One real difference worth knowing: **systems with no recent data are
analyzed at 6 months where they fail at 30 days** — Piedmont's 30-day run
records four "no monitor data in the requested period" failures that the
6-month run analyzes normally.

## System Activity pages (`system_pages` / `--system-pages`)

On a summary job, also build one interactive HTML page for every system
that needs attention, has a data issue, or could not be analyzed: its
alert detections, notifications and readings over the summary's period,
with the timeline, filters and slot table of the Anomaly Report and none
of its interpretation (`incident/system_pages.js`,
`PLAN-FLEET-SYSTEM-PAGES.md`). They land in the out dir; with `--email`
they are zipped and ride on the summary email, split into "part n/N"
follow-up emails when one zip would exceed the message limit. When every
To/CC address is `@avantehs.com` and the app's HTML is 5 MB or less, the
HTML itself is attached instead of the zip (`output/activity_attachment.js`).

Two formats (`PLAN-SYSTEM-ACTIVITY-APP.md`):

| Format | What the reader gets |
|---|---|
| `app` (default) | **one HTML file**, `Avante-<scope>-System-Activity[-Internal]-<period>-<date>.html`: a dashboard of every flagged system (the summary's status and order, totals, a find box); selecting a system opens its activity view, with links back and to the previous/next system. Works offline, straight from the zip. A batch over one email's budget is split into parts; each part lists every system and links its own. |
| `pages` | one HTML file per system, `Avante-<system>-Activity[-Internal]-<period>-<date>.html` — the original form, kept for one release as a fallback. |

`--pages-format app|pages` (job key `"system_pages_format"`) picks one and,
like `--pages-audience`, implies `--system-pages`.

Two audiences (`incident/page_policy.js`):

| Audience | What it shows | Default for |
|---|---|---|
| `external` | the customer copy — every Avante user (address, name, staff role, or access to 5+ customers) scrubbed before anything is counted | `customer_summary` |
| `internal` | every recipient, Avante staff grouped under "Avante"; marked Internal in the header, title and file name (`…-Activity-Internal-…`) | `fleet_summary` |

`--system-pages` (job key `"system_pages": true`) takes the summary's
default; `--pages-audience internal|external` (job key
`"system_pages": "internal"`) names one.

**Pilot gate:** while the pages are in pilot, a run that EMAILS them may
address only the pilot list in `incident/page_policy.js` — today
`matt.teixeira@`, `joe.anello@` and `jonathan.pope@avantehs.com` (To and
CC); anything else is
refused before any work. Internal pages may only ever go to
`@avantehs.com` addresses. Build-only runs are not gated.

```bash
npm run report:customer -- --customer C0137 --system-pages                         # customer copies, build only
npm run report:customer -- --customer C0137 --system-pages --email                 # + send
npm run report:customer -- --customer C0137 --pages-audience internal --email      # internal copies
npm run report:fleet -- --system-pages --email                                     # fleet: internal copies
npm run report:customer -- --customer C0137 --pages-format pages                   # one file per system instead
```

A 6-month customer summary (Piedmont, 25 flagged systems) builds its app in
~40 s end to end: one 31 MB file, a 2.2 MB zip, dashboard ready in ~1 s.
The 6-month fleet (108 systems) is one ~130 MB file in one ~10 MB zip;
its dashboard is ready in ~3 s and its largest system opens in ~2.5 s.

## Checks

```bash
npm run check:oneoff     # periods, job config, composed requests (no database)
npm run check:system-pages   # activity pages (no database; launches Chromium)
```

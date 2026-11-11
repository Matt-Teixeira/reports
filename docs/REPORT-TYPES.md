# Report types: what exists, how to run it, and what gets sent

A single reference for every report this repo produces. It covers each report's options, which emails go out, and what appears only under certain conditions.
The detection rules behind the content are in
[MAGNET-HEALTH-DATA-AND-RULES.md](MAGNET-HEALTH-DATA-AND-RULES.md) and
[sme_reports/RULES.md](../sme_reports/RULES.md). Each section below links to deeper material.

Accurate as of 2026-11-06 (commit 07a5693).

---

## 1. At a glance

| Report | What the reader gets | Started by | Emailed? | Audience |
|---|---|---|---|---|
| **Magnet Health Brief** | One-page PDF (plus HTML) per MRI | One-off CLI `sme` job, or a request file | Only with `--email` / `"email": true` | Internal or customer |
| **Customer Magnet Health Summary** | Multi-page PDF for one customer, site set or system set | One-off CLI `customer` job, a scheduled row, or a request file | Scheduled: yes. One-off: only with `--email` | Customer (wording is customer-facing) |
| **Fleet Magnet Health Summary** | Multi-page PDF over every mag-processed system | One-off CLI `fleet` job, daily cron (request file), or a scheduled row | Cron: yes. One-off: only with `--email` | Internal |
| **Per-user digest** (`user_summary`) | One email per subscribed user, carrying a Summary PDF for each customer they can see | Scheduled rows only | Yes (unless the row is `dry_run`) | Each user, limited to their own access |
| **System Activity app / pages** | Interactive HTML for every *flagged* system, zipped | Add-on to a Customer or Fleet Summary (`--system-pages` / `system_pages`) | Rides on the Summary email | `external` (customer copy) or `internal` |
| **Anomaly Report** | Two HTML files (internal + external) for one system and one incident window | `node sme_reports/incident/run.js` | **Never** | Internal / customer, shared by hand |
| **GE CT Insights viewer** | One-file internal HTML page for the GE CT fleet | `npm run report:ct` | **Never** | Internal, shared by hand |
| **Legacy alert.reports jobs** | HTML-table emails (helium, pressure, issue tracker, offline…) | Cron every :00 / :30, `npm start <job>` | Yes, whenever a row matches the slot | The row's author + CC |

**One rule for every hand-run report:** nothing is emailed unless you ask.
One-off jobs default to `"email": false` and build files in `sme_reports/out/`. The Anomaly Report and CT viewer have no email path at all.

---

## 2. The four ways a report starts

### 2a. One-off CLI: `npm run report`

For operators. Config file: [sme_reports/oneoff/jobs.config.json](../sme_reports/oneoff/jobs.config.json). Full docs: [sme_reports/ONEOFF.md](../sme_reports/ONEOFF.md).

```bash
npm run report:list                                         # list configured jobs
npm run report:sme      -- --system SME19034 --period 6mo   # brief(s)
npm run report:customer -- --customer C0137 --period 7d     # customer summary
npm run report:customer-briefs -- --customer C0137 --period 7d   # every brief for a customer, one zip email
npm run report:fleet    -- --period 7d --system-pages       # fleet summary + internal activity app
npm run report -- <job-name> [flags]                        # any job by name
```

Jobs configured today:

| Job | Kind | Covers | Default period | Default recipients | Emails by default? |
|---|---|---|---|---|---|
| `customer` | `customer_summary` | C0137 | 6mo | Matt, Jonathan Pope, Joe Anello | no |
| `sme` | `sme_brief` | SME21824 | 6mo | Matt, Jonathan Pope, Joe Anello | no |
| `customer-briefs` | `sme_brief` | every mag system of C0137 | 30d | Matt | **yes** (`"email": true`, zipped) |
| `fleet` | `fleet_summary` | whole mag fleet, minus 7 RF/SC service stations | 6mo | Matt | no |

> ⚠ The `customer` and `sme` jobs list Jonathan and Joe. Adding `--email` to
> either one sends to all three. To send to yourself only, use a scratch config
> (`--config /path/to/my.config.json`) whose job lists only you.

### 2b. Scheduled rows: `alert.sme_reports` table

Cron runs `npm start sme_report` with **no file argument** on every schedule slot. The runner ([sme_reports/run_scheduled.js](../sme_reports/run_scheduled.js)):

1. Finds the enabled rows whose `email_schedule` names the current slot (`"fri-10:00": true`, Eastern time).
2. Builds each row's documents.
3. Delivers them.
4. Writes one `alert.sme_report_sends` row per recipient per attempt (`sent`, `error`, `dry_run` or `skipped_access`).

Operator flags (`npm start sme_report -- …`):

| Flag | Effect |
|---|---|
| `--slot mon-08:00` | Run a specific slot now instead of waiting for cron |
| `--config 3` | Run one row by id. A disabled row needs `--dry-run` as well |
| `--dry-run` | Force the no-send path regardless of the row's `dry_run` setting |

Live rows (as of 2026-11-06):

| id | Kind | Scope | Period | Slot (ET) | Activity pages | Recipients |
|---|---|---|---|---|---|---|
| 1 | `customer_summary` | C0051 (Intelas) | 7 days | Fri 10:00 | yes (external copy) | Matt, Jonathan Pope, Joe Anello |
| 2 | `customer_summary` | C0051 (Intelas) | 7 days | Fri 10:30 | yes (external copy) | six Intelas / Crothall contacts |

### 2c. Request files (file mode): `npm start sme_report -- ./requests/<file>.json`

This JSON shape is what the other two paths build internally, so every option exists here too. The only file-mode run on cron is the **daily 07:00 fleet summary**:
`npm start sme_report -- ./requests/fleet-summary.json`. It is summary-only, the internal fleet document, emailed to Matt.
Example request files live in [requests/](../requests/).

### 2d. Standalone tools and legacy jobs

These are covered in §3.6–3.8. The Anomaly Report and CT viewer each run as their own script. The legacy jobs are `npm start <job_name>` from cron.

---

## 3. Each report in detail

### 3.1 Magnet Health Brief (`sme_brief`)

A **one-page** PDF per MRI, with the same page as an HTML file. Every run writes `sme_reports/out/Avante-<SME>-Magnet-Health.pdf` and `.html`, both overwritten on each run. With `archive` on (the default), a dated copy also goes to `sme_reports/archive/Avante-<SME>-Magnet-Health[-7d|-90d|-6mo|-window]-<date>.pdf`.

**Always on the page:**

- Header, system name and site, and a sub-line giving the period or window.
- **Five status tiles.** The set depends on the vendor:

  | Vendor | Tiles |
  |---|---|
  | Philips | Compressor · Pressure now · Event peak · Temp alarm · Helium |
  | GE | Compressor · Coldhead · Pressure now · Event peak · Helium |
  | Siemens 4K | Compressor · Coldhead · Pressure now · Event peak · Helium |
  | Siemens 10K (non-TIM) | Compressor · Shield temp now · Event peak · Cabinet · Helium |

- Two charts: the primary metric (He pressure, or shield temperature on Siemens 10K) and helium level. Both carry their alert threshold lines.
- **The story.** One narrative chosen by the system's condition (see §6), plus the timeline of events.
- **Three cards:** CURRENT (last readings), RATES, and DATA NOTES.

**Conditional on the page:**

| Appears when… | What you see |
|---|---|
| The sensor chain is convicted *(sensor suspect)* | A grey **SENSOR SUSPECTᶜ** banner under the sub-line. Tiles keep their values but drop status colors ("sensor's claim — not judged"). An EDU-measured compressor tile stays confident. Charts shrink to make room. |
| The compressor channel has read "off" since before the period, with no thermal response | A **NO SIGNALᶜ** banner. Compressor state and downtime are not reported. |
| A quench was recorded | It overrides both banners. The helium tile reads "QUENCH detected this period". |
| A channel's last raw reading is outside plausible bounds | That tile is greyed and shows the raw value with **‡**: "outside plausible bounds — not judged". |
| A channel's newest good reading is more than 24 h before the period end | The tile says **"as of Aug 5 · …"**, and DATA NOTES says when the channel stopped. |
| More than 500 captures in the period | Charts switch to a daily min–max band with the daily last value. Otherwise they plot every capture. DATA NOTES says which. |
| The period produced a lot of prose | A **compact** layout: smaller type and shorter charts, so the page still fits. |
| An explicit window that isn't on whole UTC days | Chart axis ends are labelled in UTC (`10-09 18:00Z`). Headings and the sub-line give the window in its zone. |
| The EDU reported a compressor stop, and the secondary channel read running while the magnet stayed thermally steady | The stop is still reported as off, followed by **"Based on other data, it may not have been off: …"** *(doubtful)* |
| The EDU reported a stop and the other data was missing, frozen or mixed | **"Other data does not confirm it: …"** *(unconfirmed)* |
| An EDU-reported stop was confirmed by the secondary channel or by warming | No extra note *(confirmed)*. A system whose other stops are doubtful adds "Another stop this period is confirmed by other data." |
| The EDU was silent and a scanner/vendor reading filled the gap | The compressor wording names the **backup** source. |
| Compressor state was inferred from the coldhead, or a stop was corroborated | A **ᶜ** mark, defined once in DATA NOTES ("concluded — inferred or corroborated, not directly measured"). |
| The system has an EDU | DATA NOTES gains an EDU line: captures, plus anything notable such as implausible readings excluded or a stopped channel. |
| `narrative_overrides` in a request file | Replaces the generated cards or prose. Request files only. |

**Never produced:** systems from Hitachi, Canon, Toshiba or Americomp have **limited coverage**. A brief run lists them as failures with the message "limited coverage … no Magnet Health Brief — included in summary documents only". An unknown manufacturer is always a hard failure.

### 3.2 Customer Magnet Health Summary (`customer_summary`)

A multi-page PDF scoped to **exactly one** of `customer_id`, `site_ids` or `system_ids`. It is titled by the scope and states on the cover how the scope was resolved. Wording is customer-facing; failure reasons, for example, are reworded for the customer.
File name: `Avante-<Customer>-<scope-hash>-Magnet-Health-Summary[-tag]-<date>.pdf`.

Page order, with the condition for each part:

| Part | When it appears |
|---|---|
| **Cover / overview.** Headline ("N systems analyzed — X need attention, Y urgent, Z data issues, W limited coverage") and the attention list, worst first | Always. Paginates when the list is long. "Urgent" and the other clauses appear only when nonzero |
| **Data issues.** Monitoring problems, kept out of the attention list | Only if any system is sensor-suspect or no-signal |
| **Could not be analyzed** | Only if any system failed |
| **Exclusions.** Every excluded id plus the note, verbatim | Only if `exclude` removed something |
| **Vendor sections:** Philips, GE, Siemens (4K), Siemens (10K) | One per vendor present in the scope |
| **Environmental (EDU)** | Only if any system in scope has an EDU |
| **Limited coverage — other manufacturers** | Only if any are in scope |
| **Site group users.** Group members, plus the customer's users who are in no group | **Always** on a customer document |
| Legend | Always, at the end |

On the attention list, an EDU-reported stop that the other data doesn't back is marked **`may not be off · `** (doubtful) or **`unconfirmed · `**.

### 3.3 Fleet Magnet Health Summary (`fleet_summary`)

The same document engine as §3.2 over **every mag-processed system**, worded for internal use. File name: `Avante-Fleet-Magnet-Health[-tag]-<date>.pdf`. Differences from the customer document:

- The scope is the whole fleet. A scheduled `fleet_summary` row may not carry a scope.
- The Site group users section appears **only if** fleet systems are in site groups, and it lists group members only.
- Excluded systems are named on their own page. The one-off and cron fleet runs exclude the 7 RF/SC service stations.

### 3.4 Per-user digest (`user_summary`, scheduled only)

One email **per user**. Each user's systems are split by owning customer, and they get a Customer Summary PDF for each customer. Users with identical access share one rendered document.

- **Audience shapes** (the row's `scope`):
  - absent: a *subscription*, sent to the row's author;
  - `{"users": [...]}`: named people;
  - `{"all_users": true}`: everyone.

  Either way, a user must be **active**, have `notify_email` on, and see at least one magnet. A named user who doesn't qualify gets an `error` row ("subscriber is not an active, notifiable user with magnet access"), and the run does not fail.
- Access is **re-checked at send time**. A document the user can no longer fully see is recorded as `skipped_access` and not sent.
- `recipient_mode` must be `derived`. **No CC is allowed**, because a CC would bypass the per-user access check. `system_pages` is not supported yet.

### 3.5 System Activity app / pages (add-on to a summary)

Interactive HTML for each **flagged** system, meaning any system that needs attention, has a data issue, or could not be analyzed. Stable and limited-coverage systems get none. Each view shows that system's alert detections, notifications and readings over the summary's period: timelines, filters and a 30-minute slot table, with no interpretation.

| Setting | Values | Default |
|---|---|---|
| `system_pages` / `--system-pages` | `true` (follows the summary: fleet → internal, customer → external), `"internal"`, `"external"` | off |
| `--pages-audience` | `internal` \| `external` (implies `--system-pages`) | — |
| `system_pages_format` / `--pages-format` | `app`: **one HTML file**, a dashboard listing every flagged system with links to each. `pages`: one file per system (the older form) | `app` |

| Audience | Contents | File name mark |
|---|---|---|
| `external` | Every Avante user (by address, name, staff role, or access to 5+ customers) is removed before anything is counted | `…-System-Activity-<period>-<date>.html` |
| `internal` | Every recipient. Avante staff are grouped under "Avante" | `…-System-Activity-Internal-…` |

**Conditional inside a system's view:**

- A **notice panel** when the system could not be analyzed.
- A **second compressor strip** when there is a second compressor channel (EDU vibration beside the scanner, or the reverse). Backup-only readings are drawn faded.
- A **Compressor stops** section, only when the EDU reported stops. Each stop gets a card with its verdict (confirmed, may not be off, or unconfirmed) and the evidence: how the secondary channel answered each EDU-off reading, and the pressure and coldhead numbers against their limits.
- "Expected alert, not detected" marks count only stops the alert engine would see: EDU-off, or vendor-off where there is no EDU.

**Delivery:** the files are zipped, and the zip rides on the Summary email. When one zip would exceed about 12 MB compressed, parts 2..N follow as separate emails ("… — System Activity part 2/3 — <date>"). Each part opens on the full list. Emailed zips are deleted after sending; the HTML stays in `out/`.

**Unzipped when small and Avante-only.** The app's HTML is attached directly instead of the zip when **every** To and CC address is `@avantehs.com`, the HTML is **5 MB or less**, and there is one part ([output/activity_attachment.js](../sme_reports/output/activity_attachment.js)). Any customer address keeps the zip, because some hospital mail filters quarantine `.html` attachments. Typical sizes: 7- and 30-day apps 0.1–2.5 MB; 6-month apps 20–30 MB.

**Who may receive them:**

- **Internal pages may only go to `@avantehs.com` addresses**, To and CC. This is permanent.
- **Pilot gate.** The committed code (all three branches on GitHub) still limits *any* page email to Matt, Joe Anello and Jonathan Pope, and refuses a run that addresses anyone else before any work starts.
  - On 2026-11-06 the gate was lifted **on the prod server only**, as uncommitted edits to `page_policy.js`, `fanout.js`, `ONEOFF.md` and three checks. Row 2's customer send relies on that.
  - Until those edits are committed, DEV and STAGING still enforce the gate, and a `git pull` on prod could conflict with them.
- Build-only runs (no email) are never checked.

### 3.6 Anomaly Report (incident tool)

```bash
node sme_reports/incident/run.js --system SME21284 \
  --from 2026-10-05T17:00Z --to 2026-10-12T17:00Z --tz America/Chicago [--out-dir DIR]
```

- Writes two HTML files: `…-Anomaly-Report-Internal-<date>.html` and `…-Anomaly-Report-External-<date>.html`.
- **It sends no email.** It only reads the database.
- The internal copy adds "expected, not detected" and the queries behind the page.
- Only the system customer's recipients are shown.
- `--tz` should be the site's time zone.
- **Limits:**
  - GE MM3 + EDU v3 only.
  - It assumes the incident is a compressor stop and throws otherwise.
  - The hypothesis and "steps for improvement" prose comes from [incident/content.js](../sme_reports/incident/content.js), written per incident.

See [sme_reports/incident/README.md](../sme_reports/incident/README.md).

### 3.7 GE CT Insights viewer

```bash
npm run report:ct [-- --as-of YYYY-MM-DD] [--out DIR]
```

- Writes `Avante-GE-CT-Insights-Internal-<as-of>.html` to `sme_reports/out/`.
- **It is neither emailed nor scheduled.** Share the file by hand.
- It reads one read-only database snapshot. `--as-of` may only equal the snapshot's UTC day, because findings and tube state are current.
- The console prints counts for reporting systems, not-reporting systems, and systems without log data.
- If the file passes 10 MB, the run exits 1.

### 3.8 Legacy alert.reports jobs

The original report system ([index.js](../index.js), [jobs/](../jobs/)). Cron runs `npm start <job>` at :00 and :30.

1. Each run picks the `alert.reports` rows whose schedule matches the current slot and whose field is that job.
2. Each user's data is filtered by the row's operator and threshold.
3. An HTML-table email titled **`Report: <report name>`** goes to the row's author plus its CC list.
4. A row with no matching data sends nothing; it is logged as a warning.

| Job name | Report |
|---|---|
| `he_level_value`, `he_pressure_value` | Helium level / pressure against the user's threshold, for the user's systems |
| `all_he_level`, `all_he_psi` | Helium level / pressure, all of the user's systems |
| `he_pressure_72_hr` | 72-hour helium pressure |
| `scan_seconds`, `shield_temp` | Scan seconds; shield temperature |
| `conn_offline` | Connection offline (internal, not filtered to a user's systems) |
| `default_alerts`, `disabled_alerts` | Default / disabled alert models (internal) |
| `issue_tracker`, `reportable_issue` | Issue tracker; reportable issues (matched to the row's issue system) |
| `mmb_all_issue_tracker`, `hhm_all_issue_tracker`, `mmb_issue_older_30`, `mmb_issue_newer_30`, `hhm_issue_older_30`, `hhm_issue_newer_30` | MMB / HHM issue tracker, all or split at 30 days |
| `missed_stack_run_mmb`, `unsuccessful_acqu_hhm`, `new_online_systems` | Missed MMB stack runs; unsuccessful HHM acquisitions; newly online systems |

The SQL that picks the rows lives in gitignored `utils/` and can differ per host. Check it on each server.
[cronjobs.txt](../cronjobs.txt) calls `npm start missed_stack_run`, but the job is named `missed_stack_run_mmb`, so that line matches nothing.

---

## 4. What gets emailed

| Run | Emails | Subject | Attachments |
|---|---|---|---|
| Brief(s), one-off with `--email`, or a request with `batch_email` | **One** email (more parts if large) | `Magnet Health Briefs — N systems[ — part n/N] — <date>` | The PDFs, attached individually. **Zipped** when there are more than 4 or `zip: true`. Split into parts over 12 MB of PDFs. HTML is not attached |
| …plus `summary_pdf: true` | A **second** email: the summary | `Magnet Health Summary — …` | Summary PDF |
| Single brief, request file with `output.email` and no batch block | One email per system | `Magnet Health Brief — <SME> — <site>` | That PDF |
| Customer Summary (one-off `--email`, or a scheduled row) | One email to To + CC | `Magnet Health Summary — <scope> — N systems[ — 7-day / window] — <date>` | Summary PDF, plus activity zip part 1 if pages were requested (the HTML itself when ≤ 5 MB and every address is `@avantehs.com`) |
| …activity pages larger than one zip | Follow-up emails for parts 2..N, sent only if the main email reached someone | `Magnet Health Summary — <scope> — System Activity[ (Internal)] part n/N — <date>` | One zip each |
| Fleet Summary (cron 07:00, one-off `--email`, or a scheduled row) | Same as the Customer Summary, with no scope in the subject | `Magnet Health Summary — N systems — … — <date>` | Fleet PDF (+ activity zip) |
| Per-user digest | One per user (more parts if large) | `Magnet Health Summaries — N customers[ — period][ — part n/N] — <date>` | One PDF attached directly. Several are **zipped** (`Magnet-Health-Summaries-<date>.zip`). Split over 12 MB |
| Scheduled row with `dry_run` | **None.** `dry_run` rows record the would-be document | — | — |
| Anomaly Report, CT viewer | **None, ever** | — | — |

**Summary email body, in order. Each part appears only when it applies:**

1. A note about the System Activity attachment (only with pages). It says whether it is a zip or the HTML file itself, how many systems, whether the copy is internal, how many zip parts there are, and any system whose page failed.
2. A line about the attached summary document. It mentions limited-coverage systems if any. If the document was requested but **failed**, a failure note replaces this line; a missing attachment is never left unexplained.
3. The headline: N analyzed, needing attention, urgent, data issues, limited coverage.
4. **FLAGGED** cards: needs attention or data issue, then any unclassified system, then any "no report" failure.
5. **STABLE / HEALTHY** list (if any).
6. **LIMITED COVERAGE** list (if any).

---

## 5. Options reference

### 5a. One-off CLI flags

| Flag | Applies to | Effect |
|---|---|---|
| `--period 7d\|30d\|90d\|6mo\|<days>` | all | Rolling period ending today. Drops any window the job sets |
| `--from <when>` / `--to <when>` | all | Explicit window. A date means the whole day; a date-time means that exact instant. `--to` with `--period` gives the N days ending then |
| `--tz <zone>` | with `--from`/`--to` | Zone for bounds without `Z` or an offset. Default `America/New_York` |
| `--customer <id>` | `customer_summary`, `sme_brief` | Override the customer scope |
| `--system SME#####` | `sme_brief`, `customer_summary` | Repeatable, and commas are allowed. Narrows or replaces the system list. Not valid on `fleet` |
| `--email` / `--no-email` | all | Send, or build only (the default) |
| `--system-pages`, `--pages-audience`, `--pages-format` | `customer_summary`, `fleet_summary` | Activity pages (§3.5) |
| `--out-dir <path>` | all | Where the files go. Default `sme_reports/out/` |
| `--config <path>` | all | A different job config, such as a scratch one with only your address |
| `--list` | — | List the jobs and exit |

Refused before any work starts:

- an unknown or repeated flag;
- `--from` together with `--period`;
- `--tz` without a window;
- a bound in the future, `from` not before `to`, or a window under 1 hour.

### 5b. Job config keys (`jobs.config.json`)

Common to every kind: `period`, `from`, `to`, `tz`, `recipients` (**required even when not emailing**), `cc_list`, `email`, `out_dir`, `archive`, `archive_records` (default **off** for one-offs), `summary_pdf`, `description`.

| Kind | Extra keys |
|---|---|
| `customer_summary` | Exactly one of `customer_id` / `site_ids` / `system_ids`; `exclude`, `exclude_note`, `system_pages`, `system_pages_format` |
| `sme_brief` | Exactly one of `customer_id` / `system_ids`; `zip` |
| `fleet_summary` | `exclude`, `exclude_note`, `system_pages`, `system_pages_format` |

Keys starting with `_` are comments. **Any other unknown key is an error**, so a misspelling fails loudly. `from` and `to` aren't allowed in `defaults`.

### 5c. Request file keys

| Level | Keys |
|---|---|
| Per report | `report_type: "magnet_health"`, `system_id`, `recipients`, `cc_list`, `window {start, end, tz, period \| lookback_days}`, `event_window`, `narrative_overrides`, `output {html, pdf, email, archive, out_dir}` (all default on) |
| Batch | `reports: [...]` **or** `scope {customer_id \| site_ids \| system_ids}` + `report_defaults`; `period` or `lookback_days` (never both); `exclude` (≤100 ids), `exclude_note` (≤240 chars); `summary_only` |
| `batch_email` | `recipients`, `cc_list`, `summary` (send the summary email), `summary_pdf` (build the summary document), `attachments` (send the brief PDFs, default on), `zip`, `archive_records` (default **on** here), `system_pages`, `system_pages_format` |

- `summary_only: true` computes every system but renders no briefs. It requires `batch_email.summary_pdf`.
- A summary batch must share **one** window.
- In a request file, `window.tz` defaults to **UTC**. On the one-off CLI it defaults to Eastern.

### 5d. Scheduled row columns (`alert.sme_reports`)

| Column | Meaning |
|---|---|
| `report_kind` | `customer_summary`, `fleet_summary` or `user_summary`. (`briefs` is rejected: not built yet) |
| `scope` | customer_summary: required. fleet_summary: must be null. user_summary: see §3.4 |
| `lookback_days` | Positive integer. Scheduled runs are always rolling periods |
| `email_schedule` | `{"fri-10:00": true, …}`. The slots are in Eastern time |
| `recipient_mode` | `explicit` for customer and fleet, `derived` for user_summary |
| `recipients`, `cc_list` | Deduplicated case-insensitively. CC is not allowed on user_summary |
| `options` | `exclude`, `system_pages`, `system_pages_format`. (`include_briefs` and `exception_only` are rejected: not built yet.) Any other key is an error |
| `enabled`, `dry_run` | `dry_run` is **on unless set to false**. A dry run sends nothing and records `dry_run` rows |

A scheduled send also archives the delivered PDF under a unique name, `…-cfg<id>-<8 hex>.pdf`, and writes a history-records sidecar unless the row is a dry run.

---

## 6. The conditions a system can be in

All three views use the same vocabulary ([sme_reports/conditions.js](../sme_reports/conditions.js)): the brief, the summary document and the emails.

| Condition | Label | Needs attention | Urgent |
|---|---|---|---|
| Compressor stop, ongoing | COMPRESSOR STOP — ONGOING | yes | yes, unless the stop began before the window (left-censored) |
| Compressor stop, recovered | compressor stop, recovered | yes | no |
| Threshold exceeded (the period's **peak**) | PEAK OVER LIMIT | yes | only if the *current* reading breaches or is high severity |
| Pressure rising | pressure rising | yes | no |
| Stable / healthy | stable / healthy | no | no |

These overlay the conditions above:

- A **quench** is always attention and urgent.
- A **data issue** (sensor suspect, or no signal) is pulled out of attention into its own tier.
- **Limited coverage** is stated and never judged.
- **Warm / offline** (off since before the window, magnet warm) is listed but never urgent.

**Compressor source.** The EDU vibration sensor is primary and matches what the alert engine watches. The vendor channel fills in only where the EDU is silent and the vendor reading is fresh. An EDU-reported stop is always reported as off. It is then typed *confirmed*, *doubtful* ("may not be off") or *unconfirmed* from the secondary channel and the thermal data. Details: MAGNET-HEALTH-DATA-AND-RULES.md §5.1.

---

## 7. Periods, windows and file names

| Spec | Days | File tag | Wording in subject and cover |
|---|---|---|---|
| `7d` (`1w`, `weekly`) | 7 | `-7d` | 7-day |
| `30d` (`1mo`, `monthly`) | 30 | *(none, the default)* | *(none)* |
| `90d` (`3mo`, `quarter`) | 90 | `-90d` | 90-day |
| `6mo` (`180d`) | 180 | `-6mo` | 6-month |
| other N | N | `-Nd` | N-day |
| explicit window | — | `-20261009T1400-to-20261011T1800` | `Oct 9 14:00 – Oct 11 18:00 ET` |

An explicit window **never writes history records**, because it isn't part of the period series. The console says so.

## 8. Where files land

| Path | Contents |
|---|---|
| `sme_reports/out/` | Scratch output, overwritten by the next run: brief PDF and HTML, summary PDF and HTML, activity HTML, Anomaly and CT pages |
| `sme_reports/archive/` | Dated brief copies (`archive: true`), scheduled deliveries (`-cfg<id>-<hash>`), and `summary-records-…json` history sidecars |
| A private temp path | Emailed zips. Removed after the send, whether it succeeded or not |

## 9. Checks

```bash
npm run check:oneoff && npm run check:config && npm run check:scope && npm run check:compute \
  && npm run check:fleet && npm run check:chart && npm run check:system-pages && node sme_reports/dev/check_ct.js
```

None of these touch the database. The fleet, chart and system-pages checks launch Chromium.

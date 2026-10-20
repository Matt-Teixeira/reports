# Anomaly Report — one system, one fixed window

Built for SME21284 (Oct 2026); generic over system and window but not yet
over vendor. Each run writes two HTML files:

- **Internal** (`…-Anomaly-Report-Internal-<date>.html`) — content and
  behavior match the hand-built `sme21284.html` seed (swimlanes, model and
  recipient filters, day-grouped slot table, detail pane, "expected, not
  detected", steps for improvement, re-create queries) in the Avante report
  design, with system and period tiles up top and the hypothesis under them.
- **External** (`…-Anomaly-Report-External-<date>.html`) — the same page for
  the customer, without "expected, not detected" or the queries.

Both show only recipients associated with the system's customer; Avante
staff and other addresses are counted in the internal query notes.

Terms: the **HHM** pulls log data from the MRI host; the **MMB** is the
Magnet Monitoring Box Avante places on site to pull GE and Siemens magnet
data. A detection (`alert.detections`) is not a notification
(`alert.notifications`): notify frequency and suppression decide what is
sent. Every detection and notification references the system's `default`
alert models; the per-user copies in `alert.models` are not referenced.

```bash
node sme_reports/incident/run.js --system SME21284 \
  --from 2026-10-05T17:00Z --to 2026-10-12T17:00Z --tz America/Chicago
```

Both land in `sme_reports/out/` (`--out-dir` to override). Read-only
against the database; nothing is emailed. `--tz` should be the site's zone —
every time on the page is shown in it.

| File | Role |
|---|---|
| `data.js` + `sql/` | the reads: identity, system extras (serial, feeds, address), alert models, detections, notifications, recipients, readings |
| `analyze.js` | pure facts: slot spine, delivery status per slot, stop/outage, per-alert timing, contact reach |
| `timeline.js` | the report page: payload from the analysis, tiles, hypothesis, static sections, Avante CSS |
| `timeline.client.js` | the timeline's browser script, ported from the seed page and inlined |
| `content.js` | per-incident prose the data cannot produce (hypothesis, steps for improvement); the hypothesis's supporting facts are generated |

**Delivery status** is the core idea. Each 30-minute slot compares what the
alert run logged at the time with what is in the database now: run saw a
reading → *on time*; run logged "Absent/Null Mag Data" but a reading exists
today → *late*; no reading today → *never received*. The readings tables
have no arrival timestamp (`server_capture_datetime` and
`box_reported_datetime` are null for GE MM3; `host_datetime` is the host's
clock), so the alert engine's own log is the only record of what was
available when.

Limits before this becomes a pipeline: GE MM3 + EDU v3 only (the readings
SQL and `MAG_FIELDS`); assumes the incident is a compressor stop (throws
otherwise); the prose and the "What we are changing" step are written for
this event; customer contacts are identified from `users.system_list_config`
naming exactly this customer.

**System Activity pages** (`activity.js`, `system_page.js`,
`system_pages.js`, `scrub.js`, `page_policy.js`) reuse this page's client
and styling for a no-interpretation, any-vendor page per flagged system on
fleet and customer summaries — in an internal and an external (customer)
copy, one-off and scheduled — see `../PLAN-FLEET-SYSTEM-PAGES.md`.

# Plan — the Anomaly Report as a deterministic job

Drafted 2026-10-14. The Anomaly Report was built by hand for one event
(SME21284, Oct 9–11 2026) from a hand-built seed page (`sme21284.html` at
the repo root). This plan turns it into a job that produces the same
kind of report for any system and event, deterministically. Decisions
below were made with the user and the review meeting, 2026-10-12 to
2026-10-14; open items are at the end.

## Where it stands

```bash
node sme_reports/incident/run.js --system SME21284 \
  --from 2026-10-05T17:00Z --to 2026-10-12T17:00Z --tz America/Chicago
```

Writes `Avante-<system>-Anomaly-Report-{Internal,External}-<date>.html`
to `sme_reports/out/`. Read-only against the database; sends nothing.
Code lives in `sme_reports/incident/` (see its README):

| File | Role |
|---|---|
| `data.js` + `sql/` | the reads: identity (shared `sql/get-system-identity.sql`), system extras, alert models, detections, notifications, recipients, GE MM3 + EDU v3 readings |
| `analyze.js` | pure facts: 30-minute slot spine, runs, delivery status per slot, stop/outage, per-model timing, batches |
| `timeline.js` | the page: payload, tiles, hypothesis + generated evidence, static sections, Avante CSS |
| `timeline.client.js` | the seed page's browser script, driven by the payload |
| `content.js` | human-written prose per system (hypothesis; steps — to be removed, see Phase 1) |

What the page contains, top to bottom: Avante header; system tiles
(system, equipment + serial, site + address, customer + site group,
monitoring feeds); period/alert tiles (period, readings, detections,
notifications, reached); hypothesis with "What the data shows";
swimlanes (Data, Detections, Notifications) with y-axis min/max; alert
model and recipient filters; day-grouped slot table with detail pane
(readings, raw `alert.detections` columns, expected-not-detected,
notifications by recipient); time-zone (Eastern / Site / UTC) and clock
toggles; internal only: re-create queries; method note; navy footer.

## Decided

- **Name**: "Anomaly Report". **No PDF** — the HTML is the deliverable.
- **Two audiences from one build.** Internal: everything. External:
  no "expected, not detected" (markers, legend, detail section, tile
  line) and no re-create queries.
- **Recipients are scoped to the system's customer in both versions**:
  users whose `users.system_list_config` names exactly that customer and
  whose address does not name Avante. Avante staff and other addresses
  are dropped (internal query notes count them).
- **Raw detection table stays** in the detail pane, both versions, for
  now.
- **Steps for improvement are out of scope** for the job — too tricky to
  make reliable. The section is removed, not templated.
- **The hypothesis is the only human-written content.** Its title and
  body are an input, reviewed before sending; the "What the data shows"
  lines under it are generated from the data. No LLM text at run time.
- **Detection ≠ notification.** `alert.detections` holds what the engine
  found; `alert.notifications` what was sent — notify frequency and
  suppression sit between. There is no `alert.notify` table.
- **Alert models**: every detection and notification references the
  system's `user_id = 'default'` models. Each user also has a copy of the
  11 models, uncustomized and unreferenced — ignore them unless that
  changes.
- **Terms**: HHM = Hospital Host Machine (log data from the MRI host).
  MMB = Magnet Monitor Box, Avante's on-site box pulling GE and Siemens
  magnet data. GE Magmon = the GE magnet monitor. HHM Unreachable
  triggers after 12 h offline.
- **Copy wording**: alarms "trigger", never "fire".
- **The HHM timing question** (last check-in 8.5 h before the compressor
  stop) is accepted as unconfirmable — no on-site status exists.

## What "deterministic" means here

Same (system, window, data snapshot, hypothesis input) → byte-identical
HTML. Every sentence on the page is either produced by a rule from the
data or is the reviewed hypothesis. A rule that cannot decide says
nothing rather than guessing.

## Phase 1 — lock down what exists

1. **Remove Steps for improvement**: drop the `steps` entries from
   `content.js` and the section from `timeline.js`.
2. **Snapshot the data.** Write the fetched rows to a JSON sidecar next
   to the HTML, and add `--from-snapshot <file>` to rebuild from it with
   no database. Rows keep arriving after the fact (608 → 613 detections
   for the SME21284 window between the seed pull and ours), so the
   snapshot is what makes a report reproducible and auditable.
3. **Fixture + check script** (`dev/check_anomaly.js`, matching the other
   `dev/check_*.js`): rebuild SME21284 from its snapshot and assert —
   336 slots, 292/259 readings, 613 detections, 17 recipients, no Avante
   address anywhere, 98 missed slots internal and none external, no
   queries external, no steps — then load both pages in puppeteer and
   fail on any page error.
4. **No clock in the output.** The date comes from the window end; keep
   it that way (no `Date.now()` in analysis or rendering).

## Phase 2 — generalize the data

1. **Vendor adapter.** Map GE MM3/MM4, Philips, Siemens and Siemens
   non-TIM into the one slot shape (`level`, `pressure`, `comp`, extras),
   reusing the existing `sql/*-series.sql`, `units-*.sql` and
   `vendors.js` instead of `incident/sql/ge-mm3-readings.sql`.
   Thresholds and field names keep coming from `alert.models`.
2. **EDU versions** v1/v2/v3 via the existing `edu_series` queries.
3. **Time zone** from the site's state, overridable by `--tz`.
4. **Customer org labels** from the customer, or a small config map,
   instead of the hard-coded Crothall/Intelas domain map.

## Phase 3 — find the event and the window

1. **Event classifier**, replacing `analyze.js`'s "throws unless the
   compressor stopped". Candidate types: compressor stop; pressure
   excursion with compressor running; helium drop; HHM offline; MMB
   offline; missing/frozen data. Reuse `compute/events.js`,
   `archetype.js`, `conditions.js`. An unrecognized pattern renders the
   data sections with no event framing and is flagged for review.
2. **Window**: anchor on the event onset; default from onset − 4 days to
   recovery + 1 day (or now). `--from/--to` override.
3. **Per-type rules** for what is event-specific today: the shaded span
   (now: stop → first check seeing readings), the "jump to" button, and
   the generated evidence lines.

## Phase 4 — delivery timing

The late/backfill finding is inferred: a slot is "late" when its alert
check logged Absent/Null Mag Data but the reading exists now. That only
works where every check leaves a detection — SME21284's level sits under
its 60% line, so every check did. A healthy system logs nothing on a
normal check, and most slots would read "unknown".

- **Upstream fix (preferred):** populate an arrival timestamp on the
  readings tables (`server_capture_datetime` exists but is null for GE
  MM3), then compare arrival to run time directly.
- **Until then:** compute how many pre-event runs left a trace; below a
  threshold (say 80%), omit the backfill evidence line rather than
  overstate it.

## Phase 5 — run it as a job

1. **`kind: "anomaly_report"`** in `oneoff/jobs.config.json` and the
   one-off CLI: `npm run report:anomaly -- --system <id> [--from --to]
   [--audience internal|external|both] [--email]`.
2. **Hypothesis input keyed by system and event date** (e.g.
   `incident/content/SME21284-2026-10-09.json`), since a system can have
   more than one event. No input → no hypothesis section; the evidence
   lines can still render under a neutral heading.
3. **Sending**: email only with `--email`, to explicit recipients
   (default the user's work address). Never auto-send to customer
   contacts; the external version goes out by hand after review.
4. **Archive** the HTML with its data snapshot.

## Open items

- Should the external version keep the raw detection table long term?
- Who owns the upstream arrival-timestamp change (Phase 4)?
- Multi-event windows: one report per event, or one report listing
  several?
- Does the shaded-span rule need a per-type definition, or is
  "condition began → first check that saw it" general enough?

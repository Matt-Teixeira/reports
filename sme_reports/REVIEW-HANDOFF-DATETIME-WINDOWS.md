# Review Request — explicit date-time report windows

You are reviewing **uncommitted changes** in the working tree of branch `DEV`
of this repo (`/home/matt-teixeira/hep3/reports`), against HEAD `2e060cb`.
See them with:

```
git diff 2e060cb -- sme_reports/ ':!sme_reports/oneoff/jobs.config.json'
```

Leave these out of the review; they are not part of this change:
- `sme_reports/oneoff/jobs.config.json` (an operator's recipients edit);
- the untracked `AvanteConnected-NewMarketing.*` and `sme21284.html` at the
  repo root.

This is a **correctness review** of a new feature: a report can now cover
any two instants (a date-time window) instead of only a period ending
today. The feature request is not under review. What is under review:
- did the implementation keep every existing window **exactly** as it was;
- is every new window parsed, validated, worded and named correctly;
- is anything now wrong, silent, or mislabeled?

Prior review rounds for this codebase are in
`sme_reports/REVIEW-HANDOFF-*.md`. `sme_reports/ONEOFF.md` documents the
feature (new "Windows" section) and is part of the change.

## What the codebase does (one paragraph)

`sme_reports/` generates "Magnet Health" documents for MRI systems from
Postgres telemetry:
- a one-page per-system **brief** (PDF + HTML);
- a multi-page **summary** document;
- interactive **System Activity** HTML pages/app;
- the **emails** that deliver them.

Every run is described by a **request object**. Request objects come from
request files (`npm start sme_report <file>`), the scheduled DB config
(`run_scheduled.js` → `fanout.js`), or the **one-off CLI**
(`oneoff/cli.js`, an operator's hand-run jobs). All three go through one
loader (`request_loader.js`), whose normalized `request.window`
(`{ start, end }` luxon DateTimes) is the single input to the data reads,
the analysis, and every place the period is stated. `periods.js` is the
shared vocabulary that names a span (filename tag, subject label).

## Before this change

- **Request files** accepted `window.start` / `window.end`, but every
  value was moved to a day boundary (`startOf("day")` / `endOf("day")`,
  in UTC). A time of day was **silently discarded**.
- **The one-off CLI** had only `--period`.
- **Explicit-date windows** got no filename tag (`period_tag(null) === ""`),
  so they collided with the default 30-day artifacts from the same run
  date.
- **Every span display** was UTC days (`fmt.day`).

## What changed

### 1. Loader — `request_loader.js` `window_of`

**Bounds** must match `BOUND_RE`:
- `YYYY-MM-DD`, or
- `YYYY-MM-DD[T| ]HH:mm[:ss[.SSS]]` with an optional `Z` or `±HH[:]MM`.

This is deliberately narrower than luxon's `fromISO`.

| Bound | Becomes |
|---|---|
| A **date** | a whole day: start of the start day, end of the end day (unchanged) |
| A **date-time** | that exact instant, no day snapping (**behavior change**) |

**`window.tz`** (new, optional):
- It is the zone that zone-less bounds are read in. A `Z` or offset in the
  bound always wins.
- It defaults to **`"utc"`**, so existing request files are unchanged.
- It is refused when neither bound is given (see "Fixed before handoff").

**Shapes:**

| Given | Window |
|---|---|
| both bounds | the window between them |
| `end` only | the lookback period counts back from `end`. From a date end, the start snaps to a day boundary (the historical rolling shape); from a date-time end it is exactly N days earlier |
| `start` only | from `start` through the end of today (in the window's zone) |
| neither | the rolling period, as before |

**Validation**, all loud:
- unrecognized bound format;
- invalid date;
- unknown tz;
- `start >= end`;
- span under 1 hour (`MIN_WINDOW_MS`);
- a date end after today (in the window's zone);
- a date-time end later than now + 1 min;
- a start in the future.

**Return value:**
`{ start, end, lookback_days, tz, explicit }`.
- `start` and `end` are converted to UTC.
- `explicit` is true when either bound was given.
- `lookback_days` is null when a start was given (as before).

`window_of` is now exported, because the one-off config validates job
windows with it.

**`assemble`** now also:
- returns `window`: the batch's one shared window (same start ms, end ms
  and tz on every effective window), else null;
- forces `batch_email.archive_records = false` and returns
  `history_skipped: true` when any effective window is explicit.

### 2. Wording and tags — `periods.js`

Three new helpers, plus `is_utc`.

**`span_text(win, { year, caps, days })`:**

| Window | Text |
|---|---|
| whole UTC days (every rolling window) | `Oct 1 – Oct 31` — identical to the old `fmt.day` span |
| whole days in another zone | `Oct 1 – Oct 31 ET` |
| times, UTC | `Oct 9 18:00Z – Oct 11 22:00Z` |
| times, other zone | `Oct 9 14:00 – Oct 11 18:00 ET` |
| same day | `Oct 9 14:00 – 18:00 ET` |

- An end exactly at midnight is exclusive: 00:00→00:00 is one day.
- US zones abbreviate to `ET`/`CT`/… across DST.
- `days: true` returns only the days (no times or zone); the chart
  headings use it.

**`window_tag(win)`:**
- for a rolling window, the period tag as before;
- for an explicit window, `-YYYYMMDD-to-YYYYMMDD` (whole days) or
  `-YYYYMMDDTHHmm-to-YYYYMMDDTHHmm`, in the window's zone.

**`window_label(win)`:**
- for an explicit window, `span_text(win, { year: true })`;
- otherwise the period label.

### 3. Surfaces

| Surface | File | Explicit window | Rolling |
|---|---|---|---|
| Brief sub-line | `render/model.js` | `span_text` | legacy `fmt.day` (unchanged) |
| Brief chart headings | `render/model.js` | `span_text({caps, days})`, days only, to keep the pressure heading on one line | legacy |
| Brief chart x-axis | `render/chart.js` | end labels `MM-dd HH:mmZ` when the domain is not on whole UTC days; an interior tick whose label box would overlap a wider end label is dropped | `timed` false, unchanged |
| Brief archive filename | `index.js` `run_one` | `window_tag` | `window_tag` → period tag (same string) |
| Brief email "Data period" | `output/send_report_email.js` | `span_text({year})` | legacy `yyyy-MM-dd to yyyy-MM-dd` |
| Summary cover + footers | `render/fleet_model.js` via `index.js` `opts.window_span` | `span_text` | records-derived `fmt.day` span (unchanged) |
| Summary / sidecar / activity filenames | `index.js` `run_batch` (`batch_period_tag`) | `window_tag(loaded.window)` | `period_tag_of(lookback_days)` |
| Summary email subject | `output/send_summary_email.js` | `window_label` | `period_label` |
| Activity pages / app sub-line | `incident/system_page.js`, `system_pages.js` | `span` override, `span_text({year})`; header period label null | legacy ET-day span |
| History skipped notice | `index.js` `run_batch` | console line + run-log event when `loaded.history_skipped` | — |

### 4. One-off CLI — `oneoff/args.js`, `oneoff/config.js`, `oneoff/cli.js`

**Flags:** `--from`, `--to`, `--tz`. The CLI parser refuses:
- `--from` with `--period`;
- `--tz` with neither `--from` nor `--to`;
- a repeated flag.

**Job config keys:** `from`, `to`, `tz`.
- `tz` defaults to `America/New_York` for jobs.
- `from` and `to` are **not** allowed in `defaults`.
- `from` + `period` in one job is an error.
- `tz` without `from`/`to` is an error.

**Layering** (`apply_overrides`):
- CLI `--from`/`--to` replace the job's whole window **as a unit**.
- `--period` alone drops any configured window (rolling period).

**Validation timing:** each job's window is resolved at config load
through the loader's `window_of`. Errors are re-worded to the operator's
names (`from`/`to`/`tz`). `describe_job` prints the window in its zone
**and** as UTC instants before the run.

**Composed request:** `build_request` puts
`window: { start?, end?, tz }` on:
- each report (`sme_brief`, `fleet_summary`), or
- `report_defaults` (`customer_summary`).

The batch-level `period` still supplies `lookback_days` for an end-only
window.

### 5. Not changed

- The scheduled path: `fanout.js` rows are `lookback_days` only. It goes
  through `materialize_scoped_requests` → `assemble`, so windows are never
  explicit there.
- `event_window` parsing (UTC `parse_date`).
- The Anomaly Report (`incident/run.js`).

## Fixed before handoff (self-review)

1. A request file could set `window.tz` with **no** bounds. That moved a
   rolling window onto that zone's days while every rolling surface still
   stated UTC days, so the stated span was wrong. It is now refused. Test:
   `check_oneoff` "rejects {tz…}".
2. The history-record skip was announced only by the one-off CLI. A
   request-file run skipped silently. `run_batch` now logs it to the
   console and the run log.

## Invariants that must hold

- **Rolling windows are byte-identical.** A request with no `start`/`end`
  (every scheduled run, every one-off `--period` run) must produce the
  same window instants, filenames, subjects, cover/footer/sub-line text,
  chart labels and email text as at `2e060cb`.
- **Existing request files** with date-only bounds analyze the same
  instants as before. Only their artifact tag changes (now the window's
  ends, where it was empty).
- **Never silent.** A bound is the instant written, or the request fails.
  No input silently falls back to a default span, a different zone, or a
  different day.
- **One wording per window.** Every surface that states an explicit window
  derives it from `span_text`, so a document and its email cannot disagree.
- **No collision.** An explicit-window artifact never has the same name as
  a rolling artifact from the same run date. Two different windows never
  share a name.
- **History series integrity.** No explicit-window run writes a records
  sidecar. No scheduled run loses its sidecar.
- **Summary batch** still requires one shared analysis window.

## Where to look hardest

1. **Rolling-window parity.** Trace `window_of(null)` and
   `window_of({ lookback_days: N })` against the old code:
   - `now.setZone("utc").endOf("day")` vs `DateTime.utc().endOf("day")`;
   - `.toUTC()` on values already in UTC;
   - `chart.js` `timed` for `[startOf day, endOf day]` (relies on
     `on_day(end + 1)`);
   - `window_tag` on rolling windows = `period_tag(lookback_days)`.

   Is there any rolling input where the new path differs?
2. **Zones and DST.**
   - `window_parts` whole-day detection on 23h/25h days.
   - Ambiguous fall-back times (`2026-11-01T01:30` ET) and nonexistent
     spring-forward times (`2026-03-08T02:30` ET). luxon resolves both
     without error. Is that an acceptable silent choice, or should it fail?
   - `zone_abbr` for non-US zones (`GMT+1` etc.).
   - Cross-year windows with `year: true`.
3. **Future/now checks.** `now` is captured once at config load (CLI) and
   again in the loader. A date end of "today" in ET vs UTC near midnight.
   A one-minute slack for date-time ends. A `start`-only window whose
   start is later today.
4. **Shared batch window.** `assemble` compares start, end **and** tz.
   Two reports with the same instants but different `tz` → `window` null →
   `batch_period_tag` falls back to `period_tag_of(null) === ""`. Is that
   reachable from a request file, and does it reintroduce a collision?
   Also: an all-excluded batch, where `effective_windows` comes from
   candidates.
5. **Layering semantics** in `apply_overrides`. Walk every combination of
   job `from`/`to`/`period` × CLI `--from`/`--to`/`--period`/`--tz`. Does
   any combination run a window other than the one the console line
   states?
6. **Chart labels.** Windows where only one end is off a UTC day boundary.
   Very long timed windows (e.g. 90 days starting 14:00), where interior
   ticks are dense and end labels are wide. Collisions with movable labels
   (`layout.block`). The `end_labels` day-repeat rule now compares against
   timed end labels.
7. **Error message rewriting** in `resolve_job_window`. The regexes
   replace `window.start`/`window.end`/`window.tz` anywhere in the
   message. Can that produce a misleading message?
8. **Mutation.** `assemble` mutates `batch_email.archive_records` on the
   object `normalize_batch_email` just built. Confirm nothing upstream
   holds that object (e.g. the scheduled runner's deferred-sidecar path in
   `run_scheduled.js`).

## How to run (all DB-free; all pass at handoff)

```
cd /home/matt-teixeira/hep3/reports
npm run -s check:oneoff         # the window, wording, tag and CLI-layering assertions live here
npm run -s check:compute
npm run -s check:chart          # Chromium
npm run -s check:fleet          # Chromium
npm run -s check:system-pages   # Chromium
npm run -s check:scope
npm run -s check:config
```

New assertions (`dev/check_oneoff.js`, two new blocks):
- "explicit windows: bounds, zones, wording, tags" covers:
  - legacy request-file windows;
  - rolling parity of tag, label and span;
  - exact instants;
  - tz reading and Z/offset precedence;
  - whole days in ET;
  - the midnight-exclusive end;
  - a window across DST;
  - end-only shapes;
  - every rejection;
  - the shared batch window and the history skip.
- "windows in the job layer" covers:
  - config keys;
  - `describe_job` output;
  - composed requests through the real loader (brief, scoped summary,
    fleet);
  - config errors in the operator's words;
  - CLI conflicts and window layering;
  - `--tz America/Chicago`.

**Live verification already done on the dev VM** (read-only against prod,
no email, scratch output, `archive: false`):
- **SME21284 brief, `--from "2026-10-09 14:00" --to "2026-10-11 18:00"`**
  (ET):
  - the window ran as 18:00Z→22:00Z;
  - the sub-line reads `Oct 9 14:00 – Oct 11 18:00 ET`;
  - the headings read `OCT 9 → OCT 11` on one line;
  - the axis reads `10-09 18:00Z` / `10-11 22:00Z`;
  - the page did not clip.
- **C0137 customer summary + activity app, `--from 2026-10-01 --to
  2026-10-07`:**
  - the cover/footer read `Oct 1 – Oct 7 ET`;
  - the files are tagged `-20261001-to-20261007-`;
  - 12 failures are identical on the code at HEAD (systems with no data).
- **The same run with `archive_records: true`:** the skip is announced
  and no sidecar is written.

**Do not send email.** One-off jobs send nothing unless `--email` is
passed; never pass it, and never run request files carrying real
recipients. Live DB access is likely unavailable to you. Static review
plus the check suites is the expected scope.

## Deliberate tradeoffs — not findings unless you can show concrete harm

- **Two time zones on one brief.** An explicit window is stated in its
  own zone (default ET for one-off jobs), but everything else in the
  brief stays UTC with a `Z` suffix (timeline, tiles, axis). Both are
  labeled. Converting the whole brief to the window's zone is out of
  scope.
- **The chart headings name days only.** The exact span is on the
  sub-line and the axis ends.
- **Request files default to UTC; one-off jobs default to
  America/New_York.** Request files keep their behavior; operators think
  in Eastern.
- **"NOW" / "CURRENT" wording for a historical window.** The brief's
  "Pressure now" tile and "CURRENT — <date>" card describe the window's
  last readings. This was already true of explicit request-file windows
  before this change.
- **`event_window`** still parses UTC-only with no zone support. It is a
  dev override, not part of this feature.
- **Filename dates.**
  - The activity app's trailing filename date is the window end (ET);
    the summary's is the run date. Both were already true at HEAD.
  - The window tag is written in the window's zone, with no zone in the
    name.
- **No maximum span.** 6-month windows already run.
- **The 1-hour minimum span** is a judgment call. Anything shorter is far
  more likely a typo (AM/PM, a missing day) than a request.

## Required output — give this back verbatim

1. **Verdict**: `SHIP` / `SHIP WITH FIXES` / `DO NOT SHIP`, with one
   sentence on why.
2. **Findings** `F1..Fn`, ordered by severity
   (`blocker`/`major`/`minor`/`nit`). Each one needs:
   - the file:line;
   - a concrete failure scenario (input → wrong instants, wrong or
     inconsistent wording, filename collision, silent fallback, lost or
     stray history sidecar, clipped chart label);
   - a suggested fix;
   - your confidence. A claim you could not trace end to end gets
     `confidence: low` and says why.
3. **Rolling-parity audit**: for each surface in the §3 table, `IDENTICAL`
   or `CHANGED` for a rolling window, with the reasoning.
4. **Layering table**: job window × CLI flags → the window that runs, and
   whether `describe_job` states it correctly.
5. **Ran**: the exact commands you executed and their results.
6. **Test gaps**: behaviors you judged correct but found unasserted.

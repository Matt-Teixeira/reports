# Plan — System Activity as one HTML app per summary

Drafted 2026-11-02. Builds on `PLAN-FLEET-SYSTEM-PAGES.md`. Today
`--system-pages` writes one HTML file per flagged system and zips them;
the reader unzips a folder of 23 (Piedmont) or 108 (fleet) files and
opens each one separately. Replace that with **one HTML file** for the
batch: a dashboard listing every flagged system, each row linking to that
system's activity view (the same timeline, filters, slot table and detail
pane the per-system page has today), with a way back to the list.

Nothing about *what* a system's view shows changes: same data, same
external scrub, same internal marking, same selection rule
(`select_page_systems`: attention ∪ data issue ∪ failed).

## Proposed decisions (confirm before building)

1. **The app replaces the per-system files on both summary kinds.**
   Customer and fleet jobs both deliver the app. The per-system builder
   stays, behind `--pages-format pages`, for one release, so a reader
   who has trouble with the app can still be sent the old form.
2. **One app per email part.** Parts are still split at the 12 MB
   compressed budget (`CHUNK_BYTES`). Each part is a complete app whose
   dashboard lists *every* flagged system in the batch. Systems in
   another part are listed but not linked ("in part 2 of 2"). Piedmont
   is one part. Fleet is two today.
3. **Offline, single file, no server.** Hash routing (`#SME15807`,
   empty hash = dashboard), so it opens from a zip or an attachment, and
   back/forward and bookmarks work.
4. **The zip stays.** A 26 MB HTML attachment is over O365's limit
   uncompressed. The zip now holds one file per part, not one per system.

## Size (measured, 6-month window, current logo)

| Batch | Systems | One HTML, uncompressed | Zipped | Parts at 12 MB |
|---|---|---|---|---|
| Piedmont (C0137), external | 23 | ~26 MB | ~2.3 MB | 1 |
| Fleet, internal | 108 | ~135 MB | ~12.6 MB | 2 (~65 MB each) |

The shared shell (CSS, client JS, logo) is under 100 KB, so sharing it
saves almost nothing. The size is the per-system data. In the largest page
(SME15807, 5.1 MB of JSON), `runs` (detections) is 4.2 MB, `slots`
0.9 MB and `notes` 0.6 MB. Step 6 is the size lever if load time is a
problem.

## How the file is put together

```
<!doctype html> … <style>CSS + app CSS</style>
<header class="brandbar"> … shared header, Internal tag if internal … </header>
<main id="app"></main>                       ← the dashboard or one system, swapped in
<template id="view-dashboard"> … </template>
<template id="view-SME15807"> … system tiles, notice, lanes, filters, table … </template>
<script type="application/json" id="data-SME15807">{ … payload … }</script>
… one template + data block per system in this part …
<script type="application/json" id="app-index">{ systems: [ … ], part, parts }</script>
<script>CLIENT_JS (mountTimeline)</script>
<script>APP_JS (router)</script>
```

`<template>` content and `application/json` scripts are inert: the
browser stores them as text and does not lay out or parse them. A
system's JSON is only `JSON.parse`d when that system is opened.

## Build

### 1. Make the timeline client mountable (`incident/timeline.client.js`)

The client is an IIFE that reads `#timeline-data` once (line 7) and binds
listeners to elements by id. Change it to

```js
window.mountTimeline = function(DATA){ … the current body … };
```

and have the two existing callers mount it explicitly:
`mountTimeline(JSON.parse(document.getElementById('timeline-data').textContent))`.

Every listener in the client binds to an element *inside* the system's
markup (`#filters`, `#rgrid`, `#rows`, `.seg button[…]`, `#toggleDays`,
`.copy`). Nothing binds to `document` or `window`. So swapping the
markup out drops the old listeners with it, and a fresh mount needs no
teardown. Keep it that way. Add a comment at the top saying so, because a
future `window.addEventListener` here would leak across views.

**Regression:** the Anomaly Report (`incident/timeline.js`) uses the same
client. Re-run the SME21284 build and confirm the embedded data is
identical and the page loads with zero errors, as was done for the
per-system pages.

### 2. Split the per-system page into section + shell (`incident/system_page.js`)

- `system_section(a, ctx)` returns `{ body_html, payload, summary }`: the
  markup between the brand header and the footer, the payload object, and
  the row the dashboard needs (below).
- `build_system_page(a, ctx)` = shell + one section + `mountTimeline`,
  byte-identical to today's output (the check asserts this). It is kept
  for `--pages-format pages`.

### 3. The app builder (`incident/system_app.js`, new)

`build_system_app(sections, { scope_label, period_label, audience, part,
parts, all_systems })` returns the HTML string.

**Dashboard view:**

- Title: `<Scope> System Activity` (+ "(Internal)"), period, date from
  the window end (deterministic, as now).
- Tiles: flagged systems; detections; notifications; recipients reached,
  summed over the batch.
- Table, one row per flagged system: system ID (link), customer system
  ID, site, equipment, **status**, detections, notifications, last
  detection date. Status uses the summary's own wording and colour
  (`effective_status` / `condition_short`, `STATUS_COLOR` /
  `CONDITION_COLOR` from `conditions.js`), so it matches the summary
  document. "Could not be analyzed" for failed systems. Order:
  `attention_sort`, then data issues, then failed.
- A text filter over system / site / equipment. It helps on fleet,
  costs nothing on Piedmont.
- Systems whose page failed to build are listed with "activity not
  available" (the email already names them).
- In a multi-part batch, rows for systems in other parts show "in part
  n of N" instead of a link.

**System view:** the section markup plus a "← All systems" link and
previous/next links in dashboard order, so a reader can walk the list
without going back each time.

**Router (`incident/system_app.client.js`, ~60 lines):** on
`hashchange` and on load, clone the matching `<template>` into `#app`,
parse that system's data block, call `mountTimeline`, set
`document.title`, and scroll to the top. Back to the dashboard restores
its scroll position. An unknown hash shows the dashboard.

**Keep across views:** the time-zone and clock choices. Today they are
module state inside the client. Read the initial values from a small
shared object the router owns, so switching systems does not reset them.
Filters are per-system and reset, which is correct.

### 4. Chunking by app part (`incident/system_pages.js`)

`build_system_pages` keeps its loop and its per-system isolation. A
failed system is logged, named and never fatal. Instead of writing a file
per system, it collects sections, then:

1. measures each section's deflated size (template + JSON), as
   `chunk_pages` does for files now;
2. `chunk_pages` (unchanged) groups them into parts under `CHUNK_BYTES`,
   in dashboard order;
3. writes one app per part:
   `Avante-<scope>-System-Activity[-Internal]<period>-<date>[-part-n-of-N].html`,
   and zips each into the same-named `.zip` (`build_fresh_zip`, per-run
   unique path, as now).

The return shape (`{ audience, selected, pages, page_failures, zips }`)
keeps its fields. `pages` still lists systems (counts and logging use it).
Each zip gains `app: <filename>`.

### 5. Wiring and wording

- `--pages-format app|pages` in `oneoff/args.js`, default `app`, carried
  as `system_pages_format` beside `system_pages`. Scheduled rows: an
  optional `options.system_pages_format` validated in `fanout.js` /
  `request_loader.js` (`KNOWN_OPTIONS`), default `app`. `page_policy.js`
  is unaffected: audience and pilot gating work as before.
- `send_summary_email.js` note: "System Activity: open
  *<file>.html* in a web browser. It lists the N flagged systems; click a
  system to see its activity." Multi-part: "This is part 1 of N. Each
  part opens on the full list."
- `send_activity_parts.js`: the same wording per part.
- `oneoff/config.js` run summary line: show the format.
- `docs/jobs_run_list.sh`: update the System Activity section.

### 6. Optional: smaller payload (only if load time needs it)

Measure first (see Checks). If a fleet part is slow to open, shrink
`runs`. Each detection repeats per-model constants (`field`, `rfu`, `op`,
`th`, `thu`) that are already in `models`. Send them once per model and
send only `code`, `ins`, `cap`, `rfc`, `rtc` per detection, with the
client rebuilding the same objects in `mk()`. The expected cut is half or
more of the largest pages. The data and the detail-pane output must be
identical. Separate commit, separate check.

## Checks (`dev/check_system_pages.js`, extended)

- `build_system_page` output is byte-identical to before the split.
- App: renders from synthetic GE / Philips / Siemens / failed sections.
  It is deterministic. Its dashboard lists every selected system with
  the right status and counts.
- **External app: no Avante address, name or count anywhere in the file**
  (same regex as the per-system check, over the whole app, including
  every template and data block).
- Internal app: marked Internal in the title, header and file name.
- Chunking: two parts when forced over budget. Each dashboard lists all
  systems and links only its own.
- **Chromium:** load the app; open each system by hash; go A → B → A and
  confirm A's DOM matches a fresh load of A. Check that the back button
  returns to the dashboard, the time-zone choice survives a switch, and
  the whole run has zero page errors.
- Anomaly Report regression (step 1).

**Measure on real data (DEV host, production DB), build-only:**

- Piedmont 6-month external: file size, zip size, time to first paint of
  the dashboard, time to open the largest system.
- Fleet 6-month internal: the same per part, plus memory after opening
  ten systems in turn (it should stay flat, since old views are dropped).

Ship to the pilot list (`page_policy.js`) only after both are acceptable.

## Rollout

1. Steps 1–2, plus checks. No behaviour change.
2. Steps 3–5 behind the default `app`. Build-only run for C0137 and open
   it beside the old per-system pages.
3. Email Piedmont to the pilot list. Then fleet.
4. After a release with no complaints, remove `--pages-format pages` and
   `build_system_page`'s standalone path.

## Not in scope

- What a system's view shows. It is unchanged.
- Linking the summary PDF to the app. A PDF cannot link into a file
  inside a zip reliably.
- Hosting the app anywhere. It stays an email attachment.

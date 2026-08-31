# SME Magnet Health Brief — Roadmap

Status checklist for the single-SME report paradigm. Update as items land.

## Done

- [x] Phase 1 — engine: request loader, per-vendor data layer, compute
      (events/metrics/archetypes), SVG charts, tiles, rules-based narrative,
      HTML render (`sme_reports/`, exemplar-faithful layout)
- [x] Phase 2 — PDF via Puppeteer 21 (Node 16 pin) + email with attachment
- [x] Batch mode — multiple reports per request file, one combined email
      (`batch_email`), optional zip bundling
- [x] Dated PDF archive (`sme_reports/archive/`, version-controlled)
- [x] EDU environmental data (config.edu → edu.v1/v2/v3, all vendors)
- [x] Thresholds from `alert.models` defaults (user_id='default', severity
      tiers, band support) with OEM constants as fallback
- [x] Per-system units from `mag.*_units` (incl. Siemens LTRS helium)
- [x] `config.mag` table routing (GE mm3/mm4, Siemens TIM vs non-TIM)
- [x] Siemens support (mag.siemens, compressor_status, band chart, coldhead)
- [x] Live batch tests: 3 Philips + 3 GE (one email), 3 Siemens (one email)
- [x] Summary email option (`batch_email.summary`) — condition per system,
      attention items first, failures listed, no attachments;
      `attachments: false` makes it summary-only
- [x] Size-chunked split sends — batches over ~12 MB of PDFs go out as
      multiple "part n/N" emails (throttled), each auto-zipped
- [x] `output.archive` flag (default true) to skip repo-tracked PDF copies
      on bulk sweeps

- [x] Themed email bodies (email_theme.js) — Avante header/band/footer,
      brand palette, condition tables; email-safe HTML (table layout, inline
      styles, CID logo) across summary, part, and single-report emails

## Next up

- [ ] **Deploy-readiness on the prod VM**: `npm install` pulls ~170 MB
      Chromium (or set `PUPPETEER_EXECUTABLE_PATH` to system Chrome);
      smoke-run `npm start sme_report -- ./requests/test-send.json` on the box
- [ ] **Phase 4 — `alert.sme_reports` config table**: columns mirror the
      request-file schema + `email_schedule` JSONB (slot keys like
      alert.reports); cron `npm start sme_report` with no file queries configs
      for the current slot; frontend writes rows
- [ ] **DB send-status recording**: write SENT/ERROR rows to a table (like
      alert.notifications) instead of log files only, so the frontend can
      show delivery status

- [x] Generation efficiency: shared Chromium instance across a batch
      (was one launch per PDF) + parallel per-system DB pulls — roughly
      halves large-batch runtime

- [x] Compressor flicker detection — single-reading dropouts with no thermal
      response (< 2% of alert line within 2 h) are reported as "likely sensor
      flickers", excluded from events/archetypes; trailing dropouts stay real

- [x] **6-month period** (`6mo` = 180 days) across the fleet summary, scoped
      customer summaries and per-system briefs, on a shared period vocabulary
      (`periods.js`: day count, artifact tag, subject wording in one entry);
      `period` is accepted as the named spelling of `lookback_days` in request
      files. Verified live: a 157-system 6-month fleet sweep, Piedmont's
      43-system 6-month summary, and 6-month briefs for SME21824 / SME19034
- [x] **One-off (operator-run) reports** — `npm run report -- <job>` over a
      hand-edited job config (`sme_reports/oneoff/`, see [ONEOFF.md](ONEOFF.md)):
      customer summary by customer id, briefs for named SMEs, internal fleet
      document, any period. Compositional only — the same loader, batch runner
      and senders; nothing scheduled calls it
- [x] Cover-lead pagination fix: a wrapped lead sentence was clipping the
      fleet cover's last attention row (found on the first 6-month document,
      reachable on any period — the live 30-day fleet lead measures 713px
      against a 720px line, 7px from the same clip). The cover now RESERVES
      a second lead line unconditionally (24 → 23 rows) instead of
      predicting each document's width; check_fleet asserts two lines is the
      ceiling and measures a real wrapped-lead cover — see RULES.md §5
      "Cover lead"

## Validation backlog (opportunistic)

- [ ] Eyeball the first report from a **real Siemens warm event**
      (compressor-stop path so far only exercised synthetically)
- [x] One-off render of **SME18359** proved LTRS helium units end-to-end
      (tile/chart in LTRS; % model thresholds correctly skipped via unit guard)
- [ ] Resolve the **Philips compressor-cycle divergence**: our
      `cryo_comp_malf_value` proxy found 2 cycles where the analyst's raw-CSV
      status column showed 14 — accept the proxy or add the raw column to the
      agg pipeline

## Later polish

- [x] Send throttle between chunked batch emails (O365 limits) + one retry
      with backoff on transient SMTP failures (all senders)
- [x] Auto-zip batches larger than 4 PDFs (`zip: true` still forces it for
      smaller batches)
- [x] Siemens non-TIM support — shield temp as the primary metric (alert
      >100 K / >90 K from alert.models), compressor from the EDU vibration
      sensor (comp_vib_status), CABINET tile vs system-reported warn/alarm
- [ ] Third chart or temp-series overlay from EDU probe data (page-space
      decision)
- [ ] Monday.com tie-in (exemplar referenced the Monday item; API PoC exists
      in `jobs/monday_report_post.js`)

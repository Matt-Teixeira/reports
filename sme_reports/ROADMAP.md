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

## Validation backlog (opportunistic)

- [ ] Eyeball the first report from a **real Siemens warm event**
      (compressor-stop path so far only exercised synthetically)
- [ ] One-off render of **SME18359** to prove LTRS helium units end-to-end
- [ ] Resolve the **Philips compressor-cycle divergence**: our
      `cryo_comp_malf_value` proxy found 2 cycles where the analyst's raw-CSV
      status column showed 14 — accept the proxy or add the raw column to the
      agg pipeline

## Later polish

- [ ] Send throttle for batches beyond ~10 systems (O365 limits)
- [ ] Default `zip: true` for large batches
- [ ] Siemens non-TIM support (different schema: no pressure/compressor;
      shield & cabinet temps — treat as its own vendor entry)
- [ ] Third chart or temp-series overlay from EDU probe data (page-space
      decision)
- [ ] Monday.com tie-in (exemplar referenced the Monday item; API PoC exists
      in `jobs/monday_report_post.js`)

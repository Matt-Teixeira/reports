# Handoff — visual refinement of the PDF documents (summary report first)

You are picking up work in `/home/matt-teixeira/hep3/reports` (branch
`DEV`, all prior series committed and review-complete). Read
`sme_reports/RULES.md` first — it is the rule-of-record — and skim
`sme_reports/PLAN-SCOPED-WEEKLY.md` for what the documents ARE. This
document scopes a VISUAL refinement: layout, typography, spacing, color
application, and general polish. **Semantics, wording, and data rules are
frozen** — this is a restyle, not a redesign of meaning.

## The system in one paragraph

`npm start sme_report -- ./requests/<file>.json` renders customer-facing
"Magnet Health" PDFs from Postgres telemetry: a one-page per-system
**brief**, and a multi-page **summary document** that renders in two
variants from one codebase — the internal all-fleet document
("Fleet Magnet Health Summary") and the scoped customer-facing variant
("Magnet Health Summary — <Customer>"), which is now the FLAGSHIP
deliverable: weekly subscription runs email each subscribed user one
digest carrying a per-customer summary PDF per customer they can access.
The **summary document is the priority of this work**; polish the scoped
variant's reading experience first, keep the internal variant coherent,
and touch the brief only if time allows.

## Where the visuals live

| File | What it owns |
|---|---|
| `sme_reports/render/fleet_page.js` | ALL summary-document CSS and markup: fixed 8.5×11in `.page` sheets, cover masthead + brand band, headline, condition rollup tiles (`.roll`), NEEDS ATTENTION table, per-vendor tables, DATA ISSUES / NO REPORT / EXCLUDED sections, the pinned cover legend, footers |
| `sme_reports/render/fleet_model.js` | Pagination constants (`ROWS_PER_PAGE = 25`, `ROWS_FIRST_PAGE = 23`, `ATTENTION_FIRST_PAGE = 15`, …) — **coupled to the row-height CSS**; pagination is computed in JS so Chromium never chooses a page break |
| `sme_reports/render/page.js` | Brief CSS: `BASE_CSS` (exemplar-derived), `DENSITY_CSS`, and the `COMPACT_CSS` tier |
| `sme_reports/render/chart.js` + `scales.js` | The brief's SVG charts (parameterized height: 152 default, 128/100/92 tiers) |
| `sme_reports/output/email_theme.js` | The brand palette (`COLORS`: navy #002B43, blue #004E79, light #97C6E9, fill #EBF0F5, red #E50B14, amber #C25E00, teal #00695C, grey #57585A) shared by the emails; the PDF CSS hardcodes matching hex — keep them in sync if you touch either |
| `sme_reports/render/assets/logo.js` | The base64 logo lockup |

## Hard constraints — each one is load-bearing

1. **Geometry is MEASURED, never assumed.** `.page` is fixed-height with
   `overflow: hidden`: overflow clips silently, and that class of bug
   once dropped 40 of 150 systems off page bottoms with every assertion
   green. `dev/check_fleet.js` lays BOTH summary variants out in headless
   Chromium and asserts: no table row clips past the footer, no content
   overruns it, pages stay reasonably full (internal doc only), and the
   protected columns (**SYSTEM, CONDITION, COMPRESSOR, SYSTEMS, REASON,
   and every header**) never truncate — measured with DOM Ranges, not
   scrollWidth. Any CSS change must keep this green. If you change row
   height, padding, or font size in a table, you MUST re-derive the
   pagination constants in `fleet_model.js` and re-measure.
2. **The brief is ONE page, hard**, with content-driven density tiers
   (`COMPACT_AT` in `render/model.js`); `dev/check_chart.js` measures it
   in Chromium against maximal natural fixtures. Same discipline.
3. **Color carries meaning.** Red = urgent/live breach, amber =
   attention/recovered, teal = healthy, grey = data issues and concluded
   states — graded by `conditions.js` and documented in RULES.md. You may
   restyle how these read (weight, chips, backgrounds); you may not
   reassign what they mean or make two states share a color they don't
   share today.
4. **Wording and marks are frozen.** The ᶜ / ‡ / ✕ conventions, the
   legend definitions, "period" (never "window"), "event span",
   "triggered" (never "fired"), condition labels from `conditions.js` —
   all unchanged. If a visual change genuinely requires a wording change,
   RULES.md must be updated in the same commit.
5. **One document, two audiences.** `vm.scope` switches the summary
   between the internal fleet variant and the customer-facing scoped
   variant (title, "% of these systems", resolution counts on the cover,
   customer-safe failure wording). Every restyle must look right in
   BOTH — check_fleet renders and measures both.
6. **Size budget.** The logo embeds ONCE (cover only — Chromium re-embeds
   per sheet it appears on, ~520 KB each); check_fleet asserts the fleet
   PDF stays under ~200 KB/page. These documents ride in emails.
7. **Every cell is one line** in the dense vendor tables (row height
   drives pagination); SYSTEM/CONDITION/COMPRESSOR must never ellipsise.

## How to see the documents

- Rendered artifacts already on disk in `sme_reports/out/`:
  `Avante-Fleet-Magnet-Health-<date>.html/.pdf` (internal, live data),
  `Avante-Lee-Health-<hash>-Magnet-Health-Summary-7d-<date>.html/.pdf`
  (scoped customer variant, live), `Avante-dev-fleet-summary-…` and
  `Avante-dev-scoped-summary-…` (check fixtures), plus per-system briefs.
- Fresh live renders, NO email (the probe pattern — output.html lands in
  `sme_reports/out/`):

  ```json
  { "scope": { "customer_id": "C027932" }, "lookback_days": 7,
    "summary_only": true,
    "batch_email": { "recipients": ["dev@example.com"], "summary": false,
      "summary_pdf": true, "attachments": false, "archive_records": false } }
  ```

  Run with `npm start sme_report -- ./path/to/probe.json`. C027932 =
  Lee Health (5 systems). Omit `scope` for the internal fleet document.
- Screenshot loop: headless puppeteer against the out/ HTML (viewport
  816×1056, screenshot each `.page` element) — look at your work, don't
  imagine it.

## NEVER

- Never run `requests/fleet-summary.json` or `requests/batch-*.json` —
  they carry REAL recipients.
- Never run `--config` against `alert.sme_reports` rows without
  `--dry-run`, and never enable/modify those rows — rows 1–2 are live
  configuration.
- Never commit rendered artifacts from `out/` (gitignored scratch).

## Verification gate (all must pass before any commit)

```
node sme_reports/dev/check_scope.js
node sme_reports/dev/check_config.js
node sme_reports/dev/check_compute.js
node sme_reports/dev/check_chart.js     # Chromium: brief geometry
node sme_reports/dev/check_fleet.js     # Chromium: BOTH summary variants
```

Plus a live probe render of the scoped and internal variants, eyeballed
via screenshot. Commit style: short imperative subject, body explains
what changed visually and what was re-measured, end with the assistant
`Co-Authored-By:` line. If the restyle is substantial, write a
`REVIEW-HANDOFF-*.md` for external (Codex) review at the end — the
format convention is in the existing `REVIEW-HANDOFF-*.md` files.

## Suggested working loop

1. Screenshot the current scoped summary (cover + a vendor-table page)
   and the internal fleet cover — establish the baseline.
2. Propose the visual direction to the user with 2–3 concrete options
   (annotated screenshots or ASCII mockups) BEFORE restyling — cover
   masthead, tile treatment, table density, legend styling are the
   high-impact zones. Implement only after they choose.
3. Iterate in small measured steps: CSS change → re-render → screenshot →
   `check_fleet.js` → adjust pagination constants if row metrics moved.
4. Keep the email bodies (`email_theme.js`) visually coherent with any
   palette adjustments — they are the envelope the PDFs arrive in.

# One-off report jobs — crib sheet
#
# Copy a line; do not run this file (it would fire every report below).
# Jobs are defined in sme_reports/oneoff/jobs.config.json — edit that to
# change what a job covers. Full docs: sme_reports/ONEOFF.md
exit 0

# ---------------------------------------------------------------------------
# The basics
# ---------------------------------------------------------------------------

npm run report:list                                      # what jobs exist
npm run report:customer                                  # run a job as configured
npm run report -- customer                               # same thing, generic form

# Nothing is emailed unless you ask. Without --email the documents are still
# built — they land in sme_reports/out/ and the console prints their paths.

# ---------------------------------------------------------------------------
# Customer summary — one customer's Magnet Health Summary PDF
# ---------------------------------------------------------------------------

npm run report:customer -- --customer C0051 --period 6mo
npm run report:customer -- --customer C0051 --period 6mo --email
npm run report:customer -- --customer C0137 --period 30d
npm run report:customer -- --customer C0137 --period 7d --email

# Narrow a customer job to specific magnets (skips the customer scope):
npm run report:customer -- --system SME19034,SME21824 --period 6mo

# Site-scoped runs have no flag — set "site_ids": ["C002684"] on a job in
# jobs.config.json instead of "customer_id" (exactly one of customer_id /
# site_ids / system_ids per job).

# ---------------------------------------------------------------------------
# SME brief — the per-system one-pager (HTML + PDF per magnet)
# ---------------------------------------------------------------------------

npm run report:sme -- --system SME19034 --period 6mo
npm run report:sme -- --system SME19034,SME21824,SME15822 --period 6mo
npm run report:sme -- --system SME19034 --period 6mo --email     # one email, PDFs attached
npm run report:sme -- --system SME19034 --out-dir ~/reports-out

# Want a summary document alongside emailed briefs? Set "summary_pdf": true
# on the job (config only, no flag). That adds a second email carrying it.

# Limited-coverage manufacturers (Hitachi, Canon, Toshiba, Americomp) have no
# brief — they appear in summary documents only, and asking for a brief fails
# loudly by design.

# ---------------------------------------------------------------------------
# Fleet summary — every mag-processed system, internal wording
# ---------------------------------------------------------------------------

npm run report:fleet -- --period 6mo
npm run report:fleet -- --period 30d --email

# The service-station magnets are excluded by the job's "exclude" list; the
# document still names every one it dropped. This one computes ~157 systems,
# so give it several minutes.

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------

#   --period <spec>      7d | 30d | 90d | 6mo, or a plain day count (14, 45d)
#   --customer <id>      customer_summary jobs only
#   --system <SME#####>  repeatable, comma lists fine
#   --out-dir <path>     default sme_reports/out
#   --email              send it (to defaults.recipients in the config)
#   --no-email           build only — the default, useful to override a job
#                        whose config sets "email": true
#   --config <path>      a different job config file
#   --list               list jobs and exit
#
# A typo'd flag or period aborts before any work starts.

# --config points at any file with the same shape as jobs.config.json — handy
# for a set of jobs you don't want in the repo copy. Create it first:
npm run report -- customer --config ./docs/my-jobs.config.json --period 6mo

# ---------------------------------------------------------------------------
# Notes
# ---------------------------------------------------------------------------

# Email goes to "defaults.recipients" in jobs.config.json (or a job's own
# "recipients"). --email only turns sending on; it does not choose an address.
#
# Periods tag the artifacts so same-day runs never overwrite each other:
# 6mo -> "-6mo", 7d -> "-7d", 30d (the default) -> no tag. The email subject
# words it the same way ("— 6-month").
#
# A 6-month window analyzes systems that FAIL at 30 days for want of recent
# data — Piedmont's 30-day run records four "no monitor data" failures the
# 6-month run analyzes normally.
#
# One-off runs deliberately do NOT write a records sidecar; the scheduled
# product owns that history series. Set "archive_records": true on a job if
# you want a one-off run to contribute to it.
#
# Briefs keep a dated copy in sme_reports/archive/ ("archive": false to skip).

# ---------------------------------------------------------------------------
# The older request-file path (still supported, unchanged)
# ---------------------------------------------------------------------------

npm start sme_report -- ./requests/fleet-summary.json
npm start sme_report -- ./requests/scoped-test-piedmont.json
npm start sme_report -- --slot mon-08:00        # scheduled config rows, by slot
npm start sme_report -- --config 3 --dry-run    # one DB config row, no send

# ---------------------------------------------------------------------------
# Checks (run after touching report code)
# ---------------------------------------------------------------------------

npm run check:oneoff     # periods, job config, composed requests — no database
npm run check:scope
npm run check:config
npm run check:compute
npm run check:fleet      # renders and MEASURES real page geometry (Chromium)
npm run check:chart

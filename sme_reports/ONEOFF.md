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
npm run report -- customer                           # any job by name
```

Documents land in `sme_reports/out/` (override with `--out-dir`). **Nothing
is emailed** unless the job says `"email": true` or you pass `--email` —
the summary document is still built either way, so a one-off run is safe
to fire while you are deciding what it should say.

| Flag | Effect |
|---|---|
| `--period <spec>` | `7d`, `30d`, `90d`, `6mo`, or a plain day count |
| `--customer <id>` | customer_summary and sme_brief jobs — overrides the scope (for a brief job it replaces any explicit system list) |
| `--system <SME#####>` | repeatable, comma lists accepted; narrows a brief job's systems (or a customer-scoped job to an explicit set) |
| `--out-dir <path>` | where documents are written |
| `--email` / `--no-email` | send, or don't (default) |
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
| `customer_summary` | one scoped Magnet Health Summary PDF (customer-facing wording, scope stated on the cover) | exactly one of `customer_id`, `site_ids`, `system_ids`; `exclude`, `exclude_note` |
| `sme_brief` | one Magnet Health Brief PDF + HTML per system | exactly one of `customer_id` (every mag system under the customer), `system_ids`; `zip` (bundle an emailed batch into one archive at any size — batches over 4 PDFs zip regardless) |
| `fleet_summary` | the internal fleet document over every mag-processed system | `exclude`, `exclude_note` |

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

## Checks

```bash
npm run check:oneoff     # periods, job config, composed requests (no database)
```

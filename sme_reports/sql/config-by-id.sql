-- One config row for operator --config runs; the runner still validates it.
SELECT * FROM alert.sme_reports WHERE id = $1

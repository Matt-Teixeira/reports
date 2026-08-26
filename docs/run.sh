# SUPERSEDED (2026-08-26): this file described the pre-paradigm flow
# (npm ci into a shared node_modules cache mount, image aux:staging).
# That flow is gone — see CLAUDE.md "Development & release workflow".
#
# Quick reference:
#
#   bash build.sh                                  # deps (in-tree) + image
#   RUN_USER=<you> docker compose run --rm app node index.js <family>   # dev
#   bash build-release.sh                          # release to /opt/apps/reports
#   cd /opt/apps/reports && docker compose run --rm app node index.js <family>
#
# NEVER run a report family at a :00/:30 minute on this host — live dt slots
# email real customers (CLAUDE.md, "Do not run report families at live dt
# slots on this box").

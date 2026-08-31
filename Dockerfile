FROM node:lts

SHELL ["/bin/bash", "-c"]

# gosu for the entrypoint user-drop, plus the sme_reports rendering stack.
#
#   zip              sme_reports/output/fresh_zip.js shells out to the
#                    Info-ZIP binary (execFile "zip"), not an npm archiver.
#                    Batches over AUTO_ZIP_THRESHOLD (4) PDFs are bundled.
#   fonts-liberation NOT optional. sme_reports/render/assets/charw8.js is a
#                    table of per-character pixel widths measured in Chromium
#                    at 8pt bold for the 'Helvetica Neue',Helvetica,Arial
#                    stack. With no metric-compatible face installed Chromium
#                    silently falls back and every computed column width is
#                    wrong -- a layout bug that raises no error.
#   lib*             Chromium's shared-library set (Debian 12 bookworm names;
#                    libasound2 is libasound2t64 from trixie onward).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      gosu \
      zip \
      fonts-liberation \
      libnss3 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 \
      libasound2 libpangocairo-1.0-0 libxkbcommon0 libxdamage1 libxfixes3 \
      libxrandr2 libxcomposite1 libxss1 \
 && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------
# HEADLESS CHROMIUM -- BAKED INTO THE IMAGE, NOT THE TREE.
#
# The image owns the browser and the tree owns the code: node_modules is
# in-tree per copy (build.sh), but a ~170 MB browser per copy is not, and
# build-release.sh would mirror it into /opt/apps on every release. build.sh
# therefore sets PUPPETEER_SKIP_DOWNLOAD=true for the npm install, and this
# layer installs the browser instead.
#
# The version is NOT pinned here as a Chrome build number. `npx
# puppeteer@<ver> browsers install chrome` installs exactly the build that
# puppeteer version pins, so bumping the npm dependency and this arg together
# can never leave the two out of sync. PUPPETEER_VERSION must equal
# package.json's puppeteer version -- unlike the host-identity ARGs above it
# carries a default, because it describes the app, not the host.
# ----------------------------------------------------------
ARG PUPPETEER_VERSION=21.11.0
ENV PUPPETEER_CACHE_DIR=/opt/puppeteer
RUN npx --yes puppeteer@${PUPPETEER_VERSION} browsers install chrome \
 && chrome_bin="$(find /opt/puppeteer -type f -name chrome | head -1)" \
 && [ -n "$chrome_bin" ] \
 && ln -s "$chrome_bin" /usr/local/bin/chrome-headless \
 && chmod -R a+rX /opt/puppeteer \
 && rm -rf /root/.npm

# render_pdf.js already honours this (and already launches with --no-sandbox
# --disable-setuid-sandbox), so no application code depends on the path.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chrome-headless

# Host identity. Deliberately no defaults: these differ per host (dev is
# 990/104, staging is 987/105) and a wrong value silently breaks bind-mount
# permissions, so an unset value must fail the build instead. Supplied from
# .env via docker-compose build args.
ARG USER_ID
ARG DOCKER_GID
ARG UID_0
ARG UID_1
ARG UID_2

# Identity label, matching the image tag (reports:${USER_ID}). Records who
# built it, not a version -- RELEASE_SHA in the deployed .env is the
# code-provenance record.
LABEL version="${USER_ID}"

# Create docker group matching the host GID
RUN groupadd -g ${DOCKER_GID} docker

# Create users with host-matching UIDs in the docker group
RUN useradd -u ${UID_0} -g docker -m -d /home/svc -s /bin/bash svc
RUN useradd -u ${UID_1} -g docker -m -d /home/jonathan-pope -s /bin/bash jonathan-pope
RUN useradd -u ${UID_2} -g docker -m -d /home/matt-teixeira -s /bin/bash matt-teixeira

# ----------------------------------------------------------
# TO ADD ANOTHER USER:
# 1) Add ARG UID_X at the top
# 2) Add: RUN useradd -u ${UID_X} -g docker -m -d /home/newuser -s /bin/bash newuser
# 3) Add UID_X to the build args in docker-compose.yaml and set it in .env
# ----------------------------------------------------------

# Cooperative umask for all shells
RUN printf 'umask ${UMASK:-0002}\n' > /etc/profile.d/umask.sh \
 && chmod 644 /etc/profile.d/umask.sh \
 && printf '\n# cooperative umask\numask ${UMASK:-0002}\n' >> /etc/bash.bashrc

ENV BASH_ENV=/etc/profile.d/umask.sh

# Embed the entrypoint
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]

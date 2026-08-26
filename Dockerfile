FROM node:lts

SHELL ["/bin/bash", "-c"]

# Only gosu -- this app has no lftp/rsync/mdbtools needs
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/*

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

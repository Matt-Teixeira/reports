FROM node:lts

SHELL ["/bin/bash", "-c"]

# Only gosu -- this app has no lftp/rsync/mdbtools needs
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/*

# Create docker group (GID 990 matches host)
RUN groupadd -g 990 docker

# Create svc user (UID 104 matches host)
RUN useradd -u 104 -g docker -m -d /home/svc -s /bin/bash svc

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

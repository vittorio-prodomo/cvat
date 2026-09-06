FROM ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get --no-install-recommends install -y \
        ca-certificates \
        libsasl2-modules \
        postfix \
    && rm -rf /var/lib/apt/lists/*

COPY components/email-relay/main.cf /etc/postfix/main.cf
COPY components/email-relay/entrypoint.sh /usr/local/sbin/cvat-mail-relay-entrypoint
RUN chmod 0644 /etc/postfix/main.cf \
    && chmod 0755 /usr/local/sbin/cvat-mail-relay-entrypoint

VOLUME ["/var/spool/postfix"]
EXPOSE 25

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD postfix status || exit 1

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/sbin/cvat-mail-relay-entrypoint"]

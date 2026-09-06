#!/usr/bin/env bash

set -Eeuo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

printf '%s\n' 'POSTMARK_TEST_ACCESS_KEY' > "$test_root/access"
printf '%s\n' 'POSTMARK_TEST_SECRET_KEY' > "$test_root/secret"
chmod 0600 "$test_root/access" "$test_root/secret"

export CVAT_POSTMARK_SMTP_ACCESS_KEY_FILE="$test_root/access"
export CVAT_POSTMARK_SMTP_SECRET_KEY_FILE="$test_root/secret"

docker compose \
    --file "$repo_root/docker-compose.yml" \
    config --format json > "$test_root/base.json"
docker compose \
    --file "$repo_root/docker-compose.yml" \
    --file "$repo_root/docker-compose.email-relay.yml" \
    config --format json > "$test_root/overlay.json"

jq -e '
    (.services.cvat_mail_relay.ports // [] | length) == 0 and
    (.services.cvat_mail_relay.network_mode == null)
' "$test_root/overlay.json" >/dev/null || fail "relay publishes a port or overrides network mode"

jq -e '
    (.services.cvat_mail_relay.networks | keys) == ["cvat_mail"] and
    (.services.cvat_server.networks | keys | sort) == ["cvat", "cvat_mail"]
' "$test_root/overlay.json" >/dev/null || fail "mail network membership is incorrect"

jq -e '
    [
        .services
        | to_entries[]
        | select((.value.networks // {}) | has("cvat_mail"))
        | .key
    ] | sort == ["cvat_mail_relay", "cvat_server"]
' "$test_root/overlay.json" >/dev/null || fail "unexpected service joined the mail network"

jq -e '
    [
        .services
        | to_entries[]
        | select(
            .value.environment.DJANGO_SETTINGS_MODULE ==
            "cvat.settings.production_email"
        )
        | .key
    ] == ["cvat_server"]
' "$test_root/overlay.json" >/dev/null || fail "production email settings reached another service"

jq -e '
    .services.cvat_server.environment.CVAT_EMAIL_HOST == "cvat_mail_relay" and
    .services.cvat_server.environment.CVAT_EMAIL_PORT == "25" and
    .services.cvat_server.environment.CVAT_EMAIL_TIMEOUT == "10" and
    .services.cvat_server.environment.CVAT_DEFAULT_FROM_EMAIL ==
        "CVAT <no-reply@cvat.the-commander.net>"
' "$test_root/overlay.json" >/dev/null || fail "server email configuration is incorrect"

jq -e '
    (.services.cvat_mail_relay.environment // {}) as $environment
    | ($environment | has("CVAT_DEFAULT_FROM_EMAIL") | not) and
      ($environment | has("POSTMARK_SMTP_ACCESS_KEY") | not) and
      ($environment | has("POSTMARK_SMTP_SECRET_KEY") | not)
' "$test_root/overlay.json" >/dev/null || fail "relay received sender or credential environment variables"

jq -e --arg access "$test_root/access" --arg secret "$test_root/secret" '
    .secrets.postmark_smtp_access_key.file == $access and
    .secrets.postmark_smtp_secret_key.file == $secret and
    ([.services.cvat_mail_relay.secrets[].source] | sort) ==
        ["postmark_smtp_access_key", "postmark_smtp_secret_key"]
' "$test_root/overlay.json" >/dev/null || fail "relay secret mounts are incorrect"

jq -e '
    any(
        .services.cvat_mail_relay.volumes[];
        .type == "volume" and
        .source == "cvat_mail_queue" and
        .target == "/var/spool/postfix"
    )
' "$test_root/overlay.json" >/dev/null || fail "persistent mail queue volume is missing"

if grep -Fq 'POSTMARK_TEST_ACCESS_KEY' "$test_root/overlay.json" || \
    grep -Fq 'POSTMARK_TEST_SECRET_KEY' "$test_root/overlay.json"; then
    fail "fake credential content leaked into the resolved Compose model"
fi

jq -e '
    (.services | has("cvat_mail_relay") | not) and
    (.networks | has("cvat_mail") | not) and
    ([
        .services
        | to_entries[]
        | select(
            .value.environment.DJANGO_SETTINGS_MODULE ==
            "cvat.settings.production_email"
        )
    ] | length == 0)
' "$test_root/base.json" >/dev/null || fail "base Compose model changed without the overlay"

echo "compose tests passed"

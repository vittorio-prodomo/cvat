#!/usr/bin/env bash

set -Eeuo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
image=cvat/mail-relay:test
container="cvat_mail_relay_image_test_$$"
test_root=$(mktemp -d)

cleanup() {
    docker rm -f -v "$container" >/dev/null 2>&1 || true
    rm -rf "$test_root"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

printf '%s\n' 'POSTMARK_TEST_ACCESS_KEY' > "$test_root/access"
printf '%s\n' 'POSTMARK_TEST_SECRET_KEY' > "$test_root/secret"
chmod 0600 "$test_root/access" "$test_root/secret"

docker build \
    --file "$repo_root/components/email-relay/Dockerfile" \
    --tag "$image" \
    "$repo_root"

docker run -d \
    --name "$container" \
    --volume "$test_root/access:/run/secrets/postmark_smtp_access_key:ro" \
    --volume "$test_root/secret:/run/secrets/postmark_smtp_secret_key:ro" \
    "$image" >/dev/null

for attempt in $(seq 1 30); do
    state=$(docker inspect "$container" --format '{{.State.Status}}')
    health=$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}')
    if [[ $state == exited || $state == dead ]]; then
        docker logs "$container" >&2
        fail "relay container exited before becoming healthy"
    fi
    [[ $health == healthy ]] && break
    sleep 1
done

[[ $(docker inspect "$container" --format '{{.State.Health.Status}}') == healthy ]] || \
    fail "relay container did not become healthy"

docker exec "$container" postfix check
[[ $(docker exec "$container" stat -c '%a' /etc/postfix/main.cf) == 644 ]] || \
    fail "Postfix main.cf mode is not 644"
docker exec "$container" cmp -s /etc/resolv.conf /var/spool/postfix/etc/resolv.conf || \
    fail "Postfix chroot resolver does not match the container resolver"
[[ $(docker exec "$container" postconf -h relayhost) == '[smtp.postmarkapp.com]:587' ]] || \
    fail "relayhost is incorrect"
[[ $(docker exec "$container" postconf -h smtp_tls_security_level) == encrypt ]] || \
    fail "outbound TLS is not mandatory"
[[ $(docker exec "$container" postconf -h smtp_sasl_auth_enable) == yes ]] || \
    fail "outbound SASL authentication is disabled"
[[ $(docker exec "$container" stat -c '%a' /etc/postfix/sasl_passwd) == 600 ]] || \
    fail "generated SASL map mode is not 600"

port_bindings=$(docker inspect "$container" --format '{{json .HostConfig.PortBindings}}')
[[ $port_bindings == null || $port_bindings == '{}' ]] || fail "SMTP port was published"

docker inspect "$container" --format '{{json .Config.Env}}' > "$test_root/environment"
docker logs "$container" > "$test_root/logs" 2>&1
for fake_secret in POSTMARK_TEST_ACCESS_KEY POSTMARK_TEST_SECRET_KEY; do
    if grep -Fq -- "$fake_secret" "$test_root/environment" "$test_root/logs"; then
        fail "fake credential leaked through container metadata or logs"
    fi
done

echo "image tests passed"

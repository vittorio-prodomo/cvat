# CVAT Postmark Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give this CVAT deployment a private, durable outbound path for organization invitations through Postmark without exposing the Postmark SMTP token to Django or publishing an SMTP port.

**Architecture:** `cvat_server` uses Django's SMTP backend to submit mail over port 25 on a dedicated Compose bridge to a Postfix relay. Postfix accepts only its trusted bridge subnet, persists its queue in a named volume, and authenticates to `smtp.postmarkapp.com:587` with mandatory STARTTLS. A tracked, opt-in Compose overlay enables the feature; omitting it preserves upstream CVAT behavior.

**Tech Stack:** Django 5.2 settings and tests, Docker Compose, Ubuntu 24.04, Postfix, Cyrus SASL modules, POSIX/Bash test scripts, `jq` for resolved-Compose assertions.

---

## Execution rules and approval boundaries

- Work only in `/data/cvat/.worktrees/cvat-postmark-relay` on `feat/cvat-postmark-relay`.
- Use test-driven development for every behavior change: write the failing test, observe the expected failure, implement the minimum behavior, then rerun the focused test.
- Never print, copy, inspect, or store the real Postmark Access Key or Secret Key in Git, shell history, test fixtures, process arguments, environment variables, logs, screenshots, or this plan.
- Use obvious fake values such as `POSTMARK_TEST_ACCESS_KEY` and `POSTMARK_TEST_SECRET_KEY` in automated tests.
- Do not install Python packages into the host interpreter. Use the version-matched CI test image described below.
- Stop for review at the end of each task. Do not commit, merge, push, restart production containers, send external mail, or delete a queue unless the user separately authorizes that boundary.
- The standard skill header mentions subagents, but current session policy requires explicit user authorization before delegation. Inline execution is valid.

## Known baseline and test harness

The host-side command below is a recorded environment mismatch, not a product regression:

```bash
pytest -c tests/python/pytest.ini cvat/apps/organizations/tests/test_rest_api.py -q
```

It stops before collection because `pytest-cases` and `pytest-timeout` are absent; the host also has Python 3.10/Django 4.2 while this checkout requires Python 3.12/Django 5.2. Build one disposable test image from the already deployed server image and mount the worktree source read-only for all Django tests:

```bash
docker image inspect cvat/server:dev --format '{{.Id}}'
docker tag cvat/server:dev cvat/server:local
docker build --file Dockerfile.ci --tag cvat/postmark-test:dev .
```

The temporary `cvat/server:local` tag does not alter a running container. If `cvat/server:dev` is absent, stop and report the missing prerequisite instead of silently selecting another base image.

CVAT's testing settings replace Django-RQ connections with `fakeredis`, but the Django cache backends still expect Redis/Kvrocks and the existing organization API tests expect OPA at `localhost:8181`. Never point tests at the production services because API test setup clears both cache databases. Create one isolated, unpublished dependency bundle instead:

```bash
if docker network inspect cvat_postmark_test_net >/dev/null 2>&1; then
  echo 'test network already exists; stop rather than replace it'
  exit 1
fi
for name in cvat_postmark_test_redis cvat_postmark_test_kvrocks cvat_postmark_test_opa; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    echo "$name already exists; stop rather than replace it"
    exit 1
  fi
done
docker network create cvat_postmark_test_net
docker run -d \
  --name cvat_postmark_test_redis \
  --network cvat_postmark_test_net \
  redis:7.2.11-alpine
docker run -d \
  --name cvat_postmark_test_kvrocks \
  --network cvat_postmark_test_net \
  apache/kvrocks:2.15.0
docker run -d \
  --name cvat_postmark_test_opa \
  --network cvat_postmark_test_net \
  --volume "$PWD/cvat/apps/iam/rules/utils.rego:/policies/utils.rego:ro" \
  --volume "$PWD/cvat/apps/organizations/rules/organizations.rego:/policies/organizations.rego:ro" \
  openpolicyagent/opa:1.12.2 \
  run --server --addr=:8181 --log-level=error /policies
```

Every Django test command below must add:

```text
--network container:cvat_postmark_test_opa
--env CVAT_REDIS_INMEM_HOST=cvat_postmark_test_redis
--env CVAT_REDIS_ONDISK_HOST=cvat_postmark_test_kvrocks
```

The disposable Django test containers share the isolated OPA container's network namespace because `cvat.settings.testing` intentionally addresses OPA at `localhost:8181`. They still resolve the two cache containers through that namespace's embedded Docker DNS. Assert all four resource names are absent before creating them. Keep them only through Task 6, then remove exactly `cvat_postmark_test_redis`, `cvat_postmark_test_kvrocks`, `cvat_postmark_test_opa`, and `cvat_postmark_test_net`. None of these resources publishes a host port or joins a production network.

### Task 1: Characterize the existing invitation email contract

**Files:**

- Create: `cvat/apps/organizations/tests/test_email.py`
- Read: `cvat/apps/organizations/models.py`
- Read: `cvat/apps/organizations/templates/invitation/invitation_subject.txt`
- Read: `cvat/apps/organizations/templates/invitation/invitation_message.html`

- [x] **Step 1: Add a focused characterization test**

Create a Django `TestCase` that builds the smallest valid organization, owner, invitee, membership, and invitation. Use `RequestFactory` with a secure request and update site ID 1 to `lambda.the-commander.net`. Override the test email backend, sender, and site ID:

```python
from allauth.core.context import request_context
from django.contrib.auth import get_user_model
from django.contrib.sites.models import Site
from django.core import mail
from django.test import RequestFactory, TestCase, override_settings

from cvat.apps.organizations.models import Invitation, Membership, Organization


@override_settings(
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    DEFAULT_FROM_EMAIL="CVAT <no-reply@cvat.the-commander.net>",
    SITE_ID=1,
)
class InvitationEmailTest(TestCase):
    def test_send_uses_configured_sender_and_https_acceptance_link(self):
        user_model = get_user_model()
        owner = user_model.objects.create_user(username="owner", email="owner@example.com")
        invitee = user_model.objects.create_user(
            username="invitee", email="invitee@example.com"
        )
        organization = Organization.objects.create(slug="email-test", owner=owner)
        membership = Membership.objects.create(
            user=invitee,
            organization=organization,
            role=Membership.WORKER,
        )
        invitation = Invitation.objects.create(
            key="test-invitation-key",
            owner=owner,
            membership=membership,
        )
        Site.objects.update_or_create(
            id=1,
            defaults={"domain": "lambda.the-commander.net", "name": "CVAT"},
        )

        request = RequestFactory().get("/", secure=True)
        with request_context(request):
            invitation.send(request)

        self.assertEqual(len(mail.outbox), 1)
        message = mail.outbox[0]
        self.assertEqual(message.from_email, "CVAT <no-reply@cvat.the-commander.net>")
        self.assertEqual(message.to, ["invitee@example.com"])
        self.assertIn("email-test", message.subject)
        self.assertEqual(message.content_subtype, "html")
        self.assertIn(
            "https://lambda.the-commander.net/auth/login?email=invitee@example.com"
            "&invitation=test-invitation-key",
            message.body,
        )
        invitation.refresh_from_db()
        self.assertIsNotNone(invitation.sent_date)
```

- [x] **Step 2: Run the focused test in the CI image**

```bash
docker run --rm \
  --network container:cvat_postmark_test_opa \
  --env CVAT_REDIS_INMEM_HOST=cvat_postmark_test_redis \
  --env CVAT_REDIS_ONDISK_HOST=cvat_postmark_test_kvrocks \
  --volume "$PWD:/mnt/src:ro" \
  --workdir /mnt/src \
  cvat/postmark-test:dev \
  python manage.py test \
  --settings cvat.settings.testing \
  cvat.apps.organizations.tests.test_email -v 2
```

Expected: PASS without production code changes. If the exact HTML escaping differs, inspect the generated alternative and make the assertion express the actual complete URL without weakening the sender, recipient, protocol, domain, key, or `sent_date` checks.

- [x] **Step 3: Review checkpoint**

Confirm this test characterizes existing behavior only. Stop; do not commit without authorization.

### Task 2: Add a fail-closed production email settings module

**Files:**

- Create: `cvat/settings/production_email.py`
- Create: `cvat/apps/organizations/tests/test_production_email_settings.py`
- Preserve: `cvat/settings/base.py`
- Preserve: `cvat/settings/email_settings.py`

- [x] **Step 1: Write subprocess-based settings tests first**

Import the new settings module in a fresh subprocess. The helper must remove `CVAT_EMAIL_HOST`, `CVAT_EMAIL_PORT`, `CVAT_EMAIL_TIMEOUT`, and `CVAT_DEFAULT_FROM_EMAIL` before adding a case-specific environment so workstation configuration cannot make a negative test pass accidentally. Set `DJANGO_SECRET_KEY=test-secret` to prevent filesystem key generation.

Cover these cases:

1. Valid settings yield exactly:
   - SMTP backend
   - host `cvat_mail_relay`
   - integer port `25`
   - float timeout `10.0`
   - sender `CVAT <no-reply@cvat.the-commander.net>`
   - empty host username/password
   - TLS and SSL both false on the private hop
2. Missing or blank `CVAT_EMAIL_HOST` raises `ImproperlyConfigured` naming that variable.
3. `CVAT_EMAIL_PORT` rejects `0`, `65536`, and `abc`.
4. `CVAT_EMAIL_TIMEOUT` rejects `0`, `-1`, and `abc`.
5. Missing, blank, syntactically invalid, CR-containing, or LF-containing `CVAT_DEFAULT_FROM_EMAIL` raises `ImproperlyConfigured` without echoing the supplied value.

The probe executed by the helper should end with one JSON line:

```python
probe = """
import json
from cvat.settings import production_email as settings
print(json.dumps({
    "backend": settings.EMAIL_BACKEND,
    "host": settings.EMAIL_HOST,
    "port": settings.EMAIL_PORT,
    "timeout": settings.EMAIL_TIMEOUT,
    "sender": settings.DEFAULT_FROM_EMAIL,
    "username": settings.EMAIL_HOST_USER,
    "password": settings.EMAIL_HOST_PASSWORD,
    "tls": settings.EMAIL_USE_TLS,
    "ssl": settings.EMAIL_USE_SSL,
}))
"""
```

- [x] **Step 2: Run the tests and observe the intended red result**

```bash
docker run --rm \
  --network container:cvat_postmark_test_opa \
  --env CVAT_REDIS_INMEM_HOST=cvat_postmark_test_redis \
  --env CVAT_REDIS_ONDISK_HOST=cvat_postmark_test_kvrocks \
  --volume "$PWD:/mnt/src:ro" \
  --workdir /mnt/src \
  cvat/postmark-test:dev \
  python manage.py test \
  --settings cvat.settings.testing \
  cvat.apps.organizations.tests.test_production_email_settings -v 2
```

Expected: FAIL because `cvat.settings.production_email` does not exist. A syntax error or unrelated import error is not the intended failure.

- [x] **Step 3: Implement the new module without changing defaults**

`cvat/settings/production_email.py` imports everything from `.production`, then defines small private parsers using `django.core.exceptions.ImproperlyConfigured`, `django.core.validators.validate_email`, `django.core.exceptions.ValidationError`, and `email.utils.parseaddr`.

Required behavior:

```python
EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
EMAIL_HOST = _required_env("CVAT_EMAIL_HOST")
EMAIL_PORT = _bounded_integer_env("CVAT_EMAIL_PORT", default=25, minimum=1, maximum=65535)
EMAIL_TIMEOUT = _positive_float_env("CVAT_EMAIL_TIMEOUT", default=10)
DEFAULT_FROM_EMAIL = _validated_sender_env("CVAT_DEFAULT_FROM_EMAIL")
EMAIL_HOST_USER = ""
EMAIL_HOST_PASSWORD = ""
EMAIL_USE_TLS = False
EMAIL_USE_SSL = False
```

Validation constraints:

- Trim leading/trailing whitespace for host, port, timeout, and sender.
- Reject an empty host.
- Reject any sender containing `\r` or `\n` before parsing.
- Parse the sender with `parseaddr`, validate the extracted address with Django's `validate_email`, and raise `ImproperlyConfigured("CVAT_DEFAULT_FROM_EMAIL must contain a valid email address")` on failure.
- Error messages may name the environment variable and expected type/range, but must never interpolate the rejected value.
- Do not read Postmark credentials here.

- [x] **Step 4: Run the focused settings and invitation tests**

```bash
docker run --rm \
  --network container:cvat_postmark_test_opa \
  --env CVAT_REDIS_INMEM_HOST=cvat_postmark_test_redis \
  --env CVAT_REDIS_ONDISK_HOST=cvat_postmark_test_kvrocks \
  --volume "$PWD:/mnt/src:ro" \
  --workdir /mnt/src \
  cvat/postmark-test:dev \
  python manage.py test \
  --settings cvat.settings.testing \
  cvat.apps.organizations.tests.test_production_email_settings \
  cvat.apps.organizations.tests.test_email -v 2
```

Expected: PASS.

- [x] **Step 5: Prove default behavior remains disabled**

```bash
docker run --rm \
  --network container:cvat_postmark_test_opa \
  --env CVAT_REDIS_INMEM_HOST=cvat_postmark_test_redis \
  --env CVAT_REDIS_ONDISK_HOST=cvat_postmark_test_kvrocks \
  --volume "$PWD:/mnt/src:ro" \
  --workdir /mnt/src \
  cvat/postmark-test:dev \
  python -c 'from cvat.settings import production; assert production.EMAIL_BACKEND is None'
```

Expected: exit 0. Stop for review; do not commit without authorization.

### Task 3: Build and test the secret-safe relay entrypoint

**Files:**

- Create: `components/email-relay/entrypoint.sh`
- Create: `components/email-relay/tests/test-entrypoint.sh`

- [x] **Step 1: Write entrypoint contract tests first**

The Bash test creates a private `mktemp -d`, installs fake `postmap` and `postfix` executables ahead of `/usr/bin:/bin` in `PATH`, and always removes only that temporary directory in a trap. Override the three file paths with test-only environment variables:

```text
POSTMARK_SMTP_ACCESS_KEY_FILE
POSTMARK_SMTP_SECRET_KEY_FILE
POSTFIX_SASL_PASSWORD_MAP
POSTFIX_CONFIGURE_INSTANCE
```

Test these cases in separate temporary subdirectories:

1. Missing access-key file: nonzero exit and message naming only the missing path/role.
2. Missing secret-key file: nonzero exit and message naming only the missing path/role.
3. Empty, whitespace-containing, or multiline file: nonzero exit with no content echoed.
4. Valid one-line fake values:
   - creates the plaintext map with mode `0600`;
   - content is exactly `[smtp.postmarkapp.com]:587 POSTMARK_TEST_ACCESS_KEY:POSTMARK_TEST_SECRET_KEY`;
   - invokes `postmap hash:<map path>`;
   - invokes Ubuntu's Postfix instance-preparation helper with `-` before checking or starting Postfix;
   - invokes `postfix check` before `postfix start-fg`;
   - exits with the fake foreground command's status;
   - stdout/stderr contain neither fake credential.
5. A stale map and `.db` are replaced, not appended.

- [x] **Step 2: Run the new test and observe the intended red result**

```bash
bash components/email-relay/tests/test-entrypoint.sh
```

Expected: FAIL because the entrypoint does not exist.

- [x] **Step 3: Implement the entrypoint**

Use Bash strict mode and defaults compatible with Compose secrets:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

access_key_file=${POSTMARK_SMTP_ACCESS_KEY_FILE:-/run/secrets/postmark_smtp_access_key}
secret_key_file=${POSTMARK_SMTP_SECRET_KEY_FILE:-/run/secrets/postmark_smtp_secret_key}
sasl_map=${POSTFIX_SASL_PASSWORD_MAP:-/etc/postfix/sasl_passwd}
configure_instance=${POSTFIX_CONFIGURE_INSTANCE:-/usr/lib/postfix/configure-instance.sh}
```

Implementation requirements:

- A `read_secret` helper uses `mapfile -t`, requires exactly one nonempty line, and rejects all whitespace.
- Set `umask 077` before generating any credential material.
- Remove only `${sasl_map}` and `${sasl_map}.db`, recreate `${sasl_map}` with mode `0600`, and write one line with `printf`.
- Compile it with `postmap "hash:${sasl_map}"`.
- Run `"${configure_instance}" -` so Ubuntu populates the Postfix chroot with the container's current resolver and NSS files.
- Run `postfix check`.
- `unset` the two shell variables holding secret contents.
- Finish with `exec postfix start-fg`.
- Error messages identify the role or file but never the value.

- [x] **Step 4: Run the entrypoint tests twice**

```bash
bash components/email-relay/tests/test-entrypoint.sh
bash components/email-relay/tests/test-entrypoint.sh
```

Expected: both runs PASS, proving the test is isolated and the implementation handles stale generated files.

- [x] **Step 5: Static secret-leak scan**

```bash
rg -n --hidden \
  'POSTMARK_TEST_(ACCESS|SECRET)_KEY|postmark_smtp_(access|secret)_key' \
  components/email-relay docker-compose.email-relay.yml cvat/settings \
  || true
```

Expected: only variable/file names and deliberate fake test values; no real credentials. Stop for review; do not commit without authorization.

### Task 4: Package a minimal Postfix smarthost image

**Files:**

- Create: `components/email-relay/Dockerfile`
- Create: `components/email-relay/main.cf`
- Create: `components/email-relay/tests/test-image.sh`

- [x] **Step 1: Add the image smoke test before the image exists**

The script must:

- build `cvat/mail-relay:test`;
- create fake secret files in a private temporary directory with mode `0600`;
- run a uniquely named container without `--publish`, mounting both files read-only at `/run/secrets/...`;
- wait up to 30 seconds for health, failing early if the container exits;
- assert `postfix check` exits 0;
- assert `/var/spool/postfix/etc/resolv.conf` matches the container's `/etc/resolv.conf`;
- assert `postconf -h relayhost` is `[smtp.postmarkapp.com]:587`;
- assert `postconf -h smtp_tls_security_level` is `encrypt`;
- assert `postconf -h smtp_sasl_auth_enable` is `yes`;
- assert `docker inspect` reports `HostConfig.PortBindings` as null or an empty object;
- assert container logs contain neither fake credential;
- remove only the uniquely named test container and temporary directory in a trap.

- [x] **Step 2: Run the image test and observe the intended red result**

```bash
bash components/email-relay/tests/test-image.sh
```

Expected: FAIL because the Dockerfile and configuration do not exist.

- [x] **Step 3: Add the pinned relay image**

Use the current Ubuntu 24.04 multi-architecture index digest:

```dockerfile
FROM ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517
```

Install only `postfix`, `libsasl2-modules`, and `ca-certificates` with `DEBIAN_FRONTEND=noninteractive`, then remove `/var/lib/apt/lists/*`. Copy `main.cf` and `entrypoint.sh`, make the entrypoint executable, declare `/var/spool/postfix` as a volume, and run the entrypoint. `EXPOSE 25` is acceptable as image metadata but must never be paired with a Compose `ports` entry.

Add:

```dockerfile
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD postfix status || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/sbin/cvat-mail-relay-entrypoint"]
```

- [x] **Step 4: Add the Postfix configuration**

`components/email-relay/main.cf` must contain:

```ini
compatibility_level = 3.8
biff = no
append_dot_mydomain = no
readme_directory = no

myhostname = cvat-mail-relay.invalid
myorigin = $myhostname
inet_interfaces = all
inet_protocols = ipv4
mydestination =
mynetworks_style = subnet
smtpd_relay_restrictions = permit_mynetworks,reject
disable_vrfy_command = yes

relayhost = [smtp.postmarkapp.com]:587
smtp_sasl_auth_enable = yes
smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd
smtp_sasl_security_options = noanonymous
smtp_sasl_tls_security_options = noanonymous
smtp_tls_security_level = encrypt
smtp_tls_CAfile = /etc/ssl/certs/ca-certificates.crt
smtp_tls_loglevel = 1
smtp_address_preference = ipv4

maillog_file = /dev/stdout
```

Do not configure local mailbox delivery, inbound authentication, or a listener on a host address.

- [x] **Step 5: Run entrypoint and image tests**

```bash
bash components/email-relay/tests/test-entrypoint.sh
bash components/email-relay/tests/test-image.sh
```

Expected: PASS. Stop for review; do not commit without authorization.

### Task 5: Add the opt-in CVAT-only Compose overlay

**Files:**

- Create: `docker-compose.email-relay.yml`
- Create: `components/email-relay/tests/test-compose.sh`
- Preserve: `docker-compose.yml`
- Preserve: ignored machine-local `/data/cvat/docker-compose.override.yml`

- [x] **Step 1: Write resolved-model assertions first**

`test-compose.sh` creates two mode-0600 fake secret files under `mktemp -d`, exports their paths as `CVAT_POSTMARK_SMTP_ACCESS_KEY_FILE` and `CVAT_POSTMARK_SMTP_SECRET_KEY_FILE`, and renders:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.email-relay.yml \
  config --format json
```

Use `jq -e` to assert all of the following:

- `cvat_mail_relay` has no `ports` and no `network_mode`.
- The relay joins exactly `cvat_mail`.
- `cvat_server` joins both `cvat` and `cvat_mail`.
- Exactly `cvat_server` and `cvat_mail_relay` join `cvat_mail`.
- Only `cvat_server` receives `DJANGO_SETTINGS_MODULE=cvat.settings.production_email`.
- The server receives host `cvat_mail_relay`, port `25`, timeout `10`, and the approved sender.
- The relay receives neither `CVAT_DEFAULT_FROM_EMAIL` nor either credential as an environment variable.
- The two top-level secrets resolve to the temporary source files and are mounted by the relay.
- The named volume targets `/var/spool/postfix`.
- The fully rendered JSON contains neither fake secret value.

Also render `docker compose -f docker-compose.yml config --format json` and prove the base model has no `cvat_mail_relay`, no `cvat_mail`, and no production email settings module.

- [x] **Step 2: Run the Compose test and observe the intended red result**

```bash
bash components/email-relay/tests/test-compose.sh
```

Expected: FAIL because the overlay does not exist.

- [x] **Step 3: Add the overlay**

Create `docker-compose.email-relay.yml` with this complete model:

```yaml
services:
  cvat_server:
    depends_on:
      cvat_mail_relay:
        condition: service_healthy
    environment:
      DJANGO_SETTINGS_MODULE: cvat.settings.production_email
      CVAT_EMAIL_HOST: cvat_mail_relay
      CVAT_EMAIL_PORT: "25"
      CVAT_EMAIL_TIMEOUT: "10"
      CVAT_DEFAULT_FROM_EMAIL: "CVAT <no-reply@cvat.the-commander.net>"
    networks:
      cvat_mail:

  cvat_mail_relay:
    container_name: cvat_mail_relay
    image: cvat/mail-relay:${CVAT_VERSION:-dev}
    build:
      context: .
      dockerfile: components/email-relay/Dockerfile
    restart: always
    secrets:
      - postmark_smtp_access_key
      - postmark_smtp_secret_key
    volumes:
      - cvat_mail_queue:/var/spool/postfix
    networks:
      cvat_mail:
    stop_grace_period: 30s

volumes:
  cvat_mail_queue:

networks:
  cvat_mail:
    driver: bridge

secrets:
  postmark_smtp_access_key:
    file: ${CVAT_POSTMARK_SMTP_ACCESS_KEY_FILE:-/etc/cvat/secrets/postmark_smtp_access_key}
  postmark_smtp_secret_key:
    file: ${CVAT_POSTMARK_SMTP_SECRET_KEY_FILE:-/etc/cvat/secrets/postmark_smtp_secret_key}
```

Do not add `ports`, `expose`, external networks, or mail settings to worker services.

- [x] **Step 4: Run Compose, entrypoint, and image checks**

```bash
bash components/email-relay/tests/test-compose.sh
bash components/email-relay/tests/test-entrypoint.sh
bash components/email-relay/tests/test-image.sh
```

Expected: PASS.

- [x] **Step 5: Resolve the actual local production stack without revealing secrets**

The ignored `/data/cvat/docker-compose.override.yml` is part of this machine's existing deployment and is not copied into the isolated worktree. Include it explicitly by absolute path with the new overlay and inspect only non-secret structure. Use temporary empty files here; the real token files remain part of the separately approved Task 7:

```bash
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
install -m 0600 /dev/null "$test_root/access"
install -m 0600 /dev/null "$test_root/secret"
CVAT_POSTMARK_SMTP_ACCESS_KEY_FILE="$test_root/access" \
CVAT_POSTMARK_SMTP_SECRET_KEY_FILE="$test_root/secret" \
docker compose \
  -f docker-compose.yml \
  -f /data/cvat/docker-compose.override.yml \
  -f docker-compose.email-relay.yml \
  config --services
CVAT_POSTMARK_SMTP_ACCESS_KEY_FILE="$test_root/access" \
CVAT_POSTMARK_SMTP_SECRET_KEY_FILE="$test_root/secret" \
docker compose \
  -f docker-compose.yml \
  -f /data/cvat/docker-compose.override.yml \
  -f docker-compose.email-relay.yml \
  config --images
```

Do not substitute credential text on the command line. Stop for review; do not commit or deploy without authorization.

### Task 6: Run the complete offline verification boundary

**Files:**

- Verify all files created in Tasks 1–5
- Verify: `docs/plans/2026-09-02-cvat-postmark-relay-design.html`

- [x] **Step 1: Run focused Django tests**

```bash
docker run --rm \
  --network container:cvat_postmark_test_opa \
  --env CVAT_REDIS_INMEM_HOST=cvat_postmark_test_redis \
  --env CVAT_REDIS_ONDISK_HOST=cvat_postmark_test_kvrocks \
  --volume "$PWD:/mnt/src:ro" \
  --workdir /mnt/src \
  cvat/postmark-test:dev \
  python manage.py test \
  --settings cvat.settings.testing \
  cvat.apps.organizations.tests.test_email \
  cvat.apps.organizations.tests.test_production_email_settings -v 2
```

- [x] **Step 2: Run the broader organizations regression suite**

```bash
docker run --rm \
  --network container:cvat_postmark_test_opa \
  --env CVAT_REDIS_INMEM_HOST=cvat_postmark_test_redis \
  --env CVAT_REDIS_ONDISK_HOST=cvat_postmark_test_kvrocks \
  --volume "$PWD:/mnt/src:ro" \
  --workdir /mnt/src \
  cvat/postmark-test:dev \
  python manage.py test \
  --settings cvat.settings.testing \
  cvat.apps.organizations.tests -v 2
```

- [x] **Step 3: Run relay and Compose tests**

```bash
bash components/email-relay/tests/test-entrypoint.sh
bash components/email-relay/tests/test-image.sh
bash components/email-relay/tests/test-compose.sh
```

- [x] **Step 4: Run static and formatting checks**

```bash
git diff --check
python3 -m html.parser docs/plans/2026-09-02-cvat-postmark-relay-design.html
uvx --from 'black==26.*' black --check --diff \
  cvat/settings/production_email.py \
  cvat/apps/organizations/tests/test_email.py \
  cvat/apps/organizations/tests/test_production_email_settings.py
uvx --from 'isort==7.*' isort --check --diff --resolve-all-configs \
  cvat/settings/production_email.py \
  cvat/apps/organizations/tests/test_email.py \
  cvat/apps/organizations/tests/test_production_email_settings.py
bash -n components/email-relay/entrypoint.sh
bash -n components/email-relay/tests/test-entrypoint.sh
bash -n components/email-relay/tests/test-image.sh
bash -n components/email-relay/tests/test-compose.sh
```

The relay image build in Task 4 is the local Dockerfile syntax check. The repository's CI later runs Hadolint 2.12.0, but downloading that tool and pushing the branch are separate network/publication boundaries.

- [x] **Step 5: Inspect the exact change set**

```bash
git status --short --branch
for path in \
  docs/plans/2026-09-02-cvat-postmark-relay-design.html \
  docs/superpowers/plans/2026-09-02-cvat-postmark-relay.md \
  cvat/settings/production_email.py \
  cvat/apps/organizations/tests/test_email.py \
  cvat/apps/organizations/tests/test_production_email_settings.py \
  components/email-relay/Dockerfile \
  components/email-relay/main.cf \
  components/email-relay/entrypoint.sh \
  components/email-relay/tests/test-entrypoint.sh \
  components/email-relay/tests/test-image.sh \
  components/email-relay/tests/test-compose.sh \
  docker-compose.email-relay.yml
do
  git diff --no-index --check /dev/null "$path" || test $? -eq 1
  git diff --no-index -- /dev/null "$path" || test $? -eq 1
done
```

Expected: only the approved design, plan, settings module, tests, relay component, and overlay. Confirm no secret-like value appears. Present evidence and stop for user review. Do not commit.

- [x] **Step 6: Remove isolated Django test dependencies**

```bash
docker rm -f cvat_postmark_test_redis
docker rm -f cvat_postmark_test_kvrocks
docker rm -f cvat_postmark_test_opa
docker network rm cvat_postmark_test_net
```

Remove only these test resources after all Django tests have finished. Their cleanup does not affect the disposable test image or any production container/network.

### Task 7: Provision host secrets and validate the relay against Postmark

**Approval gate:** Do not begin this task until the user explicitly authorizes host secret provisioning and the live relay stage. This task changes `/etc`, builds a production image, starts a container, and submits a blackhole message.

**Files outside Git:**

- Create: `/etc/cvat/secrets/postmark_smtp_access_key`
- Create: `/etc/cvat/secrets/postmark_smtp_secret_key`

- [x] **Step 1: Provision the secret files without shell-history exposure**

```bash
sudo install -d -o root -g root -m 0700 /etc/cvat/secrets
sudo install -o root -g root -m 0600 /dev/null /etc/cvat/secrets/postmark_smtp_access_key
sudo install -o root -g root -m 0600 /dev/null /etc/cvat/secrets/postmark_smtp_secret_key
sudoedit /etc/cvat/secrets/postmark_smtp_access_key
sudoedit /etc/cvat/secrets/postmark_smtp_secret_key
```

Paste exactly one token component into each editor, with no spaces or blank lines. Never use `echo TOKEN > file`.

- [x] **Step 2: Verify metadata and shape without printing content**

```bash
sudo stat --format='%n owner=%U group=%G mode=%a bytes=%s' \
  /etc/cvat/secrets/postmark_smtp_access_key \
  /etc/cvat/secrets/postmark_smtp_secret_key
sudo awk 'END { exit !(NR == 1 && length($0) > 0 && $0 !~ /[[:space:]]/) }' \
  /etc/cvat/secrets/postmark_smtp_access_key
sudo awk 'END { exit !(NR == 1 && length($0) > 0 && $0 !~ /[[:space:]]/) }' \
  /etc/cvat/secrets/postmark_smtp_secret_key
```

Expected: owner/group `root`, mode `600`, nonzero byte counts, both `awk` checks exit 0. The commands never print values.

- [x] **Step 3: Build and start only the relay**

```bash
docker compose \
  -f docker-compose.yml \
  -f /data/cvat/docker-compose.override.yml \
  -f docker-compose.email-relay.yml \
  build cvat_mail_relay
docker compose \
  -f docker-compose.yml \
  -f /data/cvat/docker-compose.override.yml \
  -f docker-compose.email-relay.yml \
  up -d --no-deps cvat_mail_relay
```

- [x] **Step 4: Verify isolation, health, DNS, TLS, and configuration**

```bash
docker inspect cvat_mail_relay --format '{{json .HostConfig.PortBindings}}'
docker inspect cvat_mail_relay --format '{{json .NetworkSettings.Networks}}'
docker inspect cvat_mail_relay --format '{{.State.Health.Status}}'
docker exec cvat_mail_relay postfix check
docker exec cvat_mail_relay cmp -s /etc/resolv.conf /var/spool/postfix/etc/resolv.conf
docker exec cvat_mail_relay postconf -h relayhost
docker exec cvat_mail_relay postconf -h smtp_tls_security_level
docker exec cvat_mail_relay getent ahostsv4 smtp.postmarkapp.com
openssl s_client -starttls smtp \
  -connect smtp.postmarkapp.com:587 \
  -servername smtp.postmarkapp.com \
  </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

Expected: null/empty port bindings, only the dedicated mail network, healthy state, a chroot resolver matching the live container resolver, relayhost `[smtp.postmarkapp.com]:587`, TLS level `encrypt`, successful IPv4 resolution, and a currently valid certificate chain. The host STARTTLS probe validates Postmark independently; the blackhole submission in the next step proves the relay container's own authenticated TLS path.

- [x] **Step 5: Submit a harmless Postmark blackhole message**

Use `sendmail` inside the relay so no token enters the command:

```bash
docker exec -i cvat_mail_relay /usr/sbin/sendmail \
  -f no-reply@cvat.the-commander.net -t <<'EOF'
From: CVAT <no-reply@cvat.the-commander.net>
To: test@blackhole.postmarkapp.com
Subject: CVAT Postmark relay preflight

This is a delivery preflight to Postmark's blackhole address.
EOF
```

Then inspect only operational data:

```bash
docker exec cvat_mail_relay postqueue -p
docker logs --since 10m cvat_mail_relay
```

Expected: the local queue becomes empty, relay logs show successful authenticated TLS delivery, and Postmark Activity shows the blackhole submission. Confirm the log contains no credential value by comparing visually only to redacted identifiers; do not search by passing the real secrets as command arguments.

- [x] **Step 6: Stop for external evidence review**

Report health, TLS, queue, and Postmark Activity results. Do not rebuild or recreate `cvat_server` yet.

### Task 8: Deploy the CVAT settings slice and perform a controlled invitation

**Approval gate:** Do not begin until the user separately authorizes the CVAT image build/recreate. A real mailbox test and real invitation each require explicit confirmation of the target recipient before sending.

- [x] **Step 1: Capture rollback state before replacing an image tag**

```bash
docker inspect cvat_server --format 'container_image={{.Image}} configured_image={{.Config.Image}}'
docker image inspect cvat/server:dev --format 'image_id={{.Id}} repo_digests={{json .RepoDigests}}'
if docker image inspect cvat/server:rollback-pre-email-20260902 >/dev/null 2>&1; then
  echo 'rollback tag already exists; stop rather than overwrite it'
  exit 1
fi
docker tag cvat/server:dev cvat/server:rollback-pre-email-20260902
```

Record the immutable image ID. If the rollback tag already exists, choose a new date/time-qualified tag only after reporting it; never overwrite a rollback tag.

- [x] **Step 2: Build the server image from the reviewed worktree**

```bash
docker build --tag cvat/server:dev .
```

Run `docker image inspect cvat/server:dev` and record the new image ID. This is a build only; no running service changes yet.

- [x] **Step 3: Recreate only `cvat_server` with the overlay**

```bash
docker compose \
  --project-directory /data/cvat \
  --env-file /data/cvat/.env \
  -f /data/cvat/docker-compose.yml \
  -f /data/cvat/docker-compose.no-traefik.yml \
  -f /data/cvat/docker-compose.override.yml \
  -f /data/cvat/components/serverless/docker-compose.serverless.yml \
  -f /data/cvat/.worktrees/cvat-postmark-relay/docker-compose.email-relay.yml \
  up -d --no-deps --no-build cvat_server
```

Verify:

```bash
docker inspect cvat_server --format '{{.Config.Image}} {{.State.Status}}'
docker exec cvat_server python manage.py check --deploy
curl --fail --silent --show-error --max-time 10 \
  https://lambda.the-commander.net/api/server/about >/dev/null
docker exec cvat_server python -c \
  'from django.conf import settings; assert settings.EMAIL_BACKEND == "django.core.mail.backends.smtp.EmailBackend"; assert settings.EMAIL_HOST == "cvat_mail_relay"; assert settings.EMAIL_PORT == 25; assert settings.EMAIL_HOST_PASSWORD == ""'
```

If the established health endpoint differs, determine it from the running deployment before substituting it. Do not treat a guessed 404 as application failure.

Preserve the full production Compose file list above. Omitting the no-Traefik
and serverless overlays would remove existing localhost port bindings and
serverless settings. Until integration, the email overlay remains in the
feature worktree; rebuilding or recreating from the main checkout without it
does not preserve this deployment.

- [ ] **Step 4: Send one operator-approved mailbox message**

Ask the user for the controlled recipient at execution time. Pass it to Django interactively or through stdin, never hardcode it in the repository. Use `django.core.mail.send_mail` with the configured default sender and a clearly labeled preflight subject. Confirm delivery and inspect the received Authentication-Results headers for `spf=pass`, `dkim=pass`, and `dmarc=pass` with the expected aligned domain.

- [ ] **Step 5: Send one controlled organization invitation**

Ask the user to identify the existing test organization and recipient, or create them through the normal CVAT UI. Use the UI's invitation/resend action so the same application path that originally produced the “no email backend configured” toast is exercised. Confirm:

- no missing-backend toast;
- exactly one message in Postmark Activity;
- delivery to the approved recipient;
- HTTPS acceptance URL on `lambda.the-commander.net`;
- successful invitation acceptance and active organization membership;
- no unexpected queue entries or relay errors.

- [ ] **Step 6: Exercise durable deferral in a disposable relay instance**

Use the production relay image and secret files, but a uniquely named test container and volume. Start it with networking disabled, submit a Postmark blackhole message, and prove the queue survives container replacement:

```bash
if docker container inspect cvat_mail_relay_deferral_test >/dev/null 2>&1; then
  echo 'deferral test container already exists; stop rather than replace it'
  exit 1
fi
if docker volume inspect cvat_mail_queue_deferral_test >/dev/null 2>&1; then
  echo 'deferral test volume already exists; stop rather than replace it'
  exit 1
fi
docker volume create cvat_mail_queue_deferral_test
docker run -d \
  --name cvat_mail_relay_deferral_test \
  --network none \
  --volume cvat_mail_queue_deferral_test:/var/spool/postfix \
  --volume /etc/cvat/secrets/postmark_smtp_access_key:/run/secrets/postmark_smtp_access_key:ro \
  --volume /etc/cvat/secrets/postmark_smtp_secret_key:/run/secrets/postmark_smtp_secret_key:ro \
  cvat/mail-relay:dev
for attempt in $(seq 1 30); do
  test "$(docker inspect cvat_mail_relay_deferral_test --format '{{.State.Health.Status}}')" = healthy && break
  sleep 1
done
test "$(docker inspect cvat_mail_relay_deferral_test --format '{{.State.Health.Status}}')" = healthy
docker exec -i cvat_mail_relay_deferral_test /usr/sbin/sendmail \
  -f no-reply@cvat.the-commander.net -t <<'EOF'
From: CVAT <no-reply@cvat.the-commander.net>
To: test@blackhole.postmarkapp.com
Subject: CVAT Postmark durable queue preflight

This message should defer while the disposable relay has no network.
EOF
docker exec cvat_mail_relay_deferral_test postqueue -p
docker rm -f cvat_mail_relay_deferral_test
docker run -d \
  --name cvat_mail_relay_deferral_test \
  --network cvat_cvat_mail \
  --volume cvat_mail_queue_deferral_test:/var/spool/postfix \
  --volume /etc/cvat/secrets/postmark_smtp_access_key:/run/secrets/postmark_smtp_access_key:ro \
  --volume /etc/cvat/secrets/postmark_smtp_secret_key:/run/secrets/postmark_smtp_secret_key:ro \
  cvat/mail-relay:dev
for attempt in $(seq 1 30); do
  test "$(docker inspect cvat_mail_relay_deferral_test --format '{{.State.Health.Status}}')" = healthy && break
  sleep 1
done
test "$(docker inspect cvat_mail_relay_deferral_test --format '{{.State.Health.Status}}')" = healthy
docker exec cvat_mail_relay_deferral_test postqueue -p
docker exec cvat_mail_relay_deferral_test postqueue -f
```

Poll `postqueue -p` for at most two minutes. Expected: the queued message is visible before replacement, remains visible immediately after replacement, then drains through Postmark once the container joins `cvat_cvat_mail`. Confirm the blackhole event in Postmark Activity. After recording evidence, remove only the test resources created here:

```bash
docker rm -f cvat_mail_relay_deferral_test
docker volume rm cvat_mail_queue_deferral_test
```

Do not revoke the production token or modify the host firewall.

- [ ] **Step 7: Record production evidence and stop**

Capture redacted image IDs, container health, queue state, and delivery/authentication results. Do not commit, merge, push, or delete the queue volume.

### Deployment evidence — 2026-09-02 21:23 UTC

The user explicitly authorized the CVAT email deployment in the current task.
Steps 1–3 are complete. At this checkpoint, real mailbox delivery,
authentication-header inspection, and the real invitation/acceptance flow were
pending an operator-selected recipient and organization. See the later mailbox
test update below; Step 7 remains open.

- Previous server image, preserved as `cvat/server:rollback-pre-email-20260902`:
  `sha256:e6db9f3fcc6fed53d4742c5ea47bf995a9db129c9951f33bb7460f45382b9581`.
- New image, built from this uncommitted feature worktree as `cvat/server:dev`:
  `sha256:0efa41b04f716802c71945636d70b936df9701ef483f43ce9d0f50fd87fe8704`.
- The image's `production_email.py` SHA-256 matches the worktree:
  `59aaebdc9f0ae81a6211f1e569527c4905013ebffff836d62dea1c84d09506e5`.
- Fresh Compose and relay-entrypoint regression checks passed. Resolved server
  changes were restricted to email environment, mail-network membership, and
  the relay dependency; existing ports, mounts, and serverless configuration
  were preserved.
- The running server selects `cvat.settings.production_email`; its SMTP backend
  connects to `cvat_mail_relay:25` and receives SMTP NOOP status 250. Sender is
  `CVAT <no-reply@cvat.the-commander.net>`, timeout 10 seconds, and Django receives
  neither Postmark credentials nor secret mounts.
- Public API `/api/server/about` and public UI returned HTTP 200. Migration check
  passed. Django deployment checks returned the same five pre-existing warnings
  as before deployment: `drf_spectacular.W001` and `security.W004/W008/W012/W016`.
  An initial Python urllib public probe received HTTP 403; subsequent curl checks
  of both public routes succeeded. Local API and UI also returned HTTP 200.
- Aggregate data counts stayed at 6 projects, 92 tasks, 155 jobs, 421 labels,
  and 69,323 labeled shapes. All 18 other recorded containers retained their
  identities and startup times, including the production relay.
- A synthetic invitation rendered into an in-memory mailbox exposed the existing
  Django Site #1 domain/name `example.com`. The single site record was corrected
  to domain `lambda.the-commander.net`, name `CVAT`; `cvat_server` was restarted
  once more to clear process-local site caches. The same rendering check then
  passed for the full HTTPS acceptance URL and configured sender, without sending
  external mail or creating any invitation, membership, or user records.
- Step 6's transport and queue-survival checks passed with disposable container
  `cvat_mail_relay_deferral_test_20260902` and volume
  `cvat_mail_queue_deferral_test_20260902`. Queue ID `3682F3B6A02A` survived an
  offline container replacement, then drained after a further replacement with
  mail-network access. Postmark accepted that one blackhole message with SMTP
  `250 2.0.0`, reference `A50834052A1`, at 21:23:10 UTC. Both disposable resources
  were removed after the queue became empty; the production queue was never used
  by this test and remains empty. Independent Postmark Activity confirmation for
  this new test remains pending, so Step 6's full checklist remains open.
- The running production relay remains healthy with no published host ports.
- No commit, merge, push, SAM3 deployment, or real-recipient message was performed.

Local execution evidence: `/tmp/cvat-email-deploy-before-20260902.json`,
`/tmp/cvat-email-server-build-20260902.log`,
`/tmp/cvat-email-data-counts-before-20260902.json`,
`/tmp/cvat-email-site-change-20260902.json`, and
`/tmp/cvat-email-durable-queue-result-20260902.json`.

### Mailbox test update — 2026-09-02 21:43 UTC

The user explicitly selected and authorized their private Gmail test mailbox.
Its address was supplied through stdin to the running server and is omitted
from this repository document.

- Submitted exactly one message through the live Django `send_mail` path at
  21:43:38 UTC, subject `CVAT email delivery test`, using the configured sender
  `CVAT <no-reply@cvat.the-commander.net>`.
- Django reported one submitted message. Postfix established a trusted TLS
  connection to Postmark and recorded `status=sent`, SMTP `250 2.0.0`, for queue
  ID `33E933B69FD6`; Postmark reference: `14A31405067`.
- The relay removed that queue entry and its queue was confirmed empty after
  submission. The user subsequently confirmed receipt in Gmail's inbox, with
  no spam-folder placement, completing the real mailbox delivery check.
- Step 4 remains open only for inspection of SPF/DKIM/DMARC results in the
  received message headers; inbox placement alone does not establish those results.
  No organization invitation was sent and no additional test was submitted.

### Invitation registration-link follow-up — 2026-09-02

The user confirmed receipt of a real organization invitation, then reported
that its button opened sign-in even though they needed to register. They
explicitly requested a direct registration link for new invitees.

- Implemented in the existing `feat/cvat-postmark-relay` worktree. Reused CVAT's
  `get_dummy_or_regular_user` classification when sending an invitation: a new
  placeholder account receives `/auth/register`; an existing account, including
  a passwordless account with a linked email identity, receives `/auth/login`.
- The URL is constructed in the invitation model and passed to the HTML
  template. `urlencode` preserves the email and invitation key, including email
  addresses containing `+` or `&`. Resending after registration selects sign-in.
- The new-user and resend cases failed against the old implementation as
  expected. All 12 organizations tests passed after the change, including five
  invitation-email tests. Cached Black/isort and whitespace checks passed.
  Tests used disposable SQLite/Redis/Kvrocks/OPA resources, with no production
  database/cache changes or external messages; all named test services and their
  network were removed afterward.
- Deployed as a follow-up to the authorized email rollout. Latest server image:
  `sha256:9835d481de74f7caf96672caffcc26307182ca12e94353274ec3067f0fb98541`.
- Preserved the preceding working email image as
  `cvat/server:rollback-pre-invitation-route-20260902`, image
  `sha256:0efa41b04f716802c71945636d70b936df9701ef483f43ce9d0f50fd87fe8704`.
  To undo only this follow-up, restore that tag to `cvat/server:dev` and reuse
  Step 3's full Compose command, retaining the email overlay.
- Verified the new image contains both modified production files. Rendering the
  actual pending test invitation with an in-memory mail backend produced the
  public HTTPS `/auth/register` URL with both query parameters intact. The check
  mocked only the invitation save and created no account, membership, or message.
- Public API and UI returned HTTP 200; migration checks passed; Django reported
  the same five pre-existing deployment warnings. The other 18 production
  containers retained their identities/start times, server ports/networks were
  preserved, and the production relay remained healthy with an empty queue.
- Previously received messages keep their original URLs. The user can resend
  the invitation through CVAT to obtain the new link. Account registration and
  invitation acceptance remain unconfirmed, as do the mailbox authentication
  headers and independent Activity confirmation for the durable-queue test.
- No invitation was resent by the agent, no email wording/branding editor was
  added, and no commit, merge, or push was performed.

Evidence: `/tmp/cvat-invitation-route-red-20260902.log`,
`/tmp/cvat-invitation-route-green-20260902.log`,
`/tmp/cvat-invitation-route-build-20260902.log`, and
`/tmp/cvat-invitation-route-before-20260902.json`.

## Rollback procedure

Rollback is an operator-approved production action. It restores the pre-email server image and omits the email overlay while retaining the relay queue volume for inspection.

- [ ] Confirm whether `postqueue -p` is empty. If it is not, stop and ask whether queued messages should be allowed to deliver or retained offline; never delete them implicitly.
- [ ] Repoint the active server tag without overwriting the rollback image:

```bash
docker tag cvat/server:rollback-pre-email-20260902 cvat/server:dev
docker compose \
  --project-directory /data/cvat \
  --env-file /data/cvat/.env \
  -f /data/cvat/docker-compose.yml \
  -f /data/cvat/docker-compose.no-traefik.yml \
  -f /data/cvat/docker-compose.override.yml \
  -f /data/cvat/components/serverless/docker-compose.serverless.yml \
  up -d --no-deps --no-build cvat_server
```

The Site #1 hostname correction is independent of the email backend and can
remain in place during an email rollback. Its captured prior values were domain
and name `example.com`; restoring those would restore the known incorrect link
configuration, so do so only if explicitly requested.

- [ ] Verify `cvat_server` health and that its default production settings have `EMAIL_BACKEND is None`.
- [ ] Stop the relay without deleting volumes:

```bash
docker compose \
  -f docker-compose.yml \
  -f /data/cvat/docker-compose.override.yml \
  -f docker-compose.email-relay.yml \
  stop cvat_mail_relay
```

- [ ] Do not run `down -v`, `docker volume rm`, or delete either host secret unless the user gives a separate destructive-action approval.

## Final integration gate

After all offline and approved live checks pass, present the complete diff and verification evidence. The next actions remain individually gated:

1. Commit on `feat/cvat-postmark-relay`.
2. Merge into `develop`.
3. Push `develop` to the personal fork after restating both remote URLs and the exact destination.
4. Retire the worktree only after verifying it is clean and merged.

None of those actions is authorized by approval of this plan.

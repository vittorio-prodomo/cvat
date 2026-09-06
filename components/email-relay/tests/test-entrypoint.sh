#!/usr/bin/env bash

set -Eeuo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
entrypoint="$repo_root/components/email-relay/entrypoint.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

assert_contains() {
    local file=$1
    local expected=$2
    grep -Fq -- "$expected" "$file" || fail "expected '$expected' in $file"
}

assert_not_contains() {
    local file=$1
    local unexpected=$2
    if grep -Fq -- "$unexpected" "$file"; then
        fail "found secret material in $file"
    fi
}

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"

cat > "$fake_bin/postmap" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'postmap %s\n' "$*" >> "$CALL_LOG"
map_path=${1#hash:}
printf 'compiled\n' > "${map_path}.db"
EOF

cat > "$fake_bin/postfix" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'postfix %s\n' "$*" >> "$CALL_LOG"
if [[ $* == start-fg ]]; then
    exit "${FAKE_START_STATUS:-0}"
fi
EOF

cat > "$fake_bin/configure-instance" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'configure-instance %s\n' "$*" >> "$CALL_LOG"
EOF

chmod +x "$fake_bin/postmap" "$fake_bin/postfix" "$fake_bin/configure-instance"

run_entrypoint() {
    local case_dir=$1
    local access_file=$2
    local secret_file=$3
    local map_file=$4
    local start_status=${5:-0}

    : > "$case_dir/calls"
    set +e
    PATH="$fake_bin:/usr/bin:/bin" \
        CALL_LOG="$case_dir/calls" \
        FAKE_START_STATUS="$start_status" \
        POSTMARK_SMTP_ACCESS_KEY_FILE="$access_file" \
        POSTMARK_SMTP_SECRET_KEY_FILE="$secret_file" \
        POSTFIX_SASL_PASSWORD_MAP="$map_file" \
        POSTFIX_CONFIGURE_INSTANCE="$fake_bin/configure-instance" \
        bash "$entrypoint" > "$case_dir/output" 2>&1
    run_status=$?
    set -e
}

case_dir="$test_root/missing-access"
mkdir -p "$case_dir"
printf '%s\n' 'POSTMARK_TEST_SECRET_KEY' > "$case_dir/secret"
run_entrypoint "$case_dir" "$case_dir/access" "$case_dir/secret" "$case_dir/sasl_passwd"
[[ $run_status -ne 0 ]] || fail "missing access key unexpectedly succeeded"
assert_contains "$case_dir/output" "Postmark SMTP access key file is missing or unreadable"
assert_not_contains "$case_dir/output" 'POSTMARK_TEST_SECRET_KEY'

case_dir="$test_root/missing-secret"
mkdir -p "$case_dir"
printf '%s\n' 'POSTMARK_TEST_ACCESS_KEY' > "$case_dir/access"
run_entrypoint "$case_dir" "$case_dir/access" "$case_dir/secret" "$case_dir/sasl_passwd"
[[ $run_status -ne 0 ]] || fail "missing secret key unexpectedly succeeded"
assert_contains "$case_dir/output" "Postmark SMTP secret key file is missing or unreadable"
assert_not_contains "$case_dir/output" 'POSTMARK_TEST_ACCESS_KEY'

for invalid_kind in empty whitespace multiline; do
    case_dir="$test_root/invalid-$invalid_kind"
    mkdir -p "$case_dir"
    case "$invalid_kind" in
        empty)
            : > "$case_dir/access"
            ;;
        whitespace)
            printf '%s\n' 'invalid value' > "$case_dir/access"
            ;;
        multiline)
            printf 'first-line\nsecond-line\n' > "$case_dir/access"
            ;;
    esac
    printf '%s\n' 'POSTMARK_TEST_SECRET_KEY' > "$case_dir/secret"

    run_entrypoint "$case_dir" "$case_dir/access" "$case_dir/secret" "$case_dir/sasl_passwd"

    [[ $run_status -ne 0 ]] || fail "$invalid_kind access key unexpectedly succeeded"
    assert_contains "$case_dir/output" "Postmark SMTP access key file must contain exactly one nonempty line without whitespace"
    assert_not_contains "$case_dir/output" 'POSTMARK_TEST_SECRET_KEY'
    assert_not_contains "$case_dir/output" 'invalid value'
    assert_not_contains "$case_dir/output" 'first-line'
done

case_dir="$test_root/valid"
mkdir -p "$case_dir"
printf '%s\n' 'POSTMARK_TEST_ACCESS_KEY' > "$case_dir/access"
printf '%s\n' 'POSTMARK_TEST_SECRET_KEY' > "$case_dir/secret"
printf '%s\n' 'stale plaintext' > "$case_dir/sasl_passwd"
printf '%s\n' 'stale database' > "$case_dir/sasl_passwd.db"

run_entrypoint \
    "$case_dir" \
    "$case_dir/access" \
    "$case_dir/secret" \
    "$case_dir/sasl_passwd" \
    23

[[ $run_status -eq 23 ]] || fail "foreground Postfix status was not propagated"
[[ $(stat -c '%a' "$case_dir/sasl_passwd") == 600 ]] || fail "SASL map mode is not 600"
[[ $(< "$case_dir/sasl_passwd") == \
    '[smtp.postmarkapp.com]:587 POSTMARK_TEST_ACCESS_KEY:POSTMARK_TEST_SECRET_KEY' \
]] || fail "SASL map content is incorrect"
[[ $(< "$case_dir/sasl_passwd.db") == compiled ]] || fail "stale compiled map was not replaced"

expected_calls=$(cat <<EOF
postmap hash:$case_dir/sasl_passwd
configure-instance -
postfix check
postfix start-fg
EOF
)
[[ $(< "$case_dir/calls") == "$expected_calls" ]] || fail "Postfix commands ran out of order"
assert_not_contains "$case_dir/output" 'POSTMARK_TEST_ACCESS_KEY'
assert_not_contains "$case_dir/output" 'POSTMARK_TEST_SECRET_KEY'

echo "entrypoint tests passed"

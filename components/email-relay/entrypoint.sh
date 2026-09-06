#!/usr/bin/env bash

set -Eeuo pipefail

access_key_file=${POSTMARK_SMTP_ACCESS_KEY_FILE:-/run/secrets/postmark_smtp_access_key}
secret_key_file=${POSTMARK_SMTP_SECRET_KEY_FILE:-/run/secrets/postmark_smtp_secret_key}
sasl_map=${POSTFIX_SASL_PASSWORD_MAP:-/etc/postfix/sasl_passwd}
configure_instance=${POSTFIX_CONFIGURE_INSTANCE:-/usr/lib/postfix/configure-instance.sh}

read_secret() {
    local path=$1
    local label=$2
    local destination=$3
    local -a lines=()

    if [[ ! -r $path ]]; then
        echo "$label file is missing or unreadable: $path" >&2
        return 1
    fi

    mapfile -t lines < "$path"
    if [[ ${#lines[@]} -ne 1 || -z ${lines[0]} || ${lines[0]} =~ [[:space:]] ]]; then
        echo "$label file must contain exactly one nonempty line without whitespace: $path" >&2
        return 1
    fi

    printf -v "$destination" '%s' "${lines[0]}"
}

read_secret "$access_key_file" "Postmark SMTP access key" access_key
read_secret "$secret_key_file" "Postmark SMTP secret key" secret_key

umask 077
rm -f -- "$sasl_map" "${sasl_map}.db"
install -m 0600 /dev/null "$sasl_map"
printf '[smtp.postmarkapp.com]:587 %s:%s\n' "$access_key" "$secret_key" > "$sasl_map"

postmap "hash:$sasl_map"
"$configure_instance" -
postfix check

unset access_key secret_key
exec postfix start-fg

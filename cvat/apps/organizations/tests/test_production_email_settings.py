# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

import json
import os
import subprocess
import sys
from pathlib import Path

from django.test import SimpleTestCase


class ProductionEmailSettingsTest(SimpleTestCase):
    _email_env_names = (
        "CVAT_EMAIL_HOST",
        "CVAT_EMAIL_PORT",
        "CVAT_EMAIL_TIMEOUT",
        "CVAT_DEFAULT_FROM_EMAIL",
    )
    _valid_env = {
        "CVAT_EMAIL_HOST": "cvat_mail_relay",
        "CVAT_DEFAULT_FROM_EMAIL": "CVAT <no-reply@cvat.the-commander.net>",
    }
    _probe = """
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

    def _run_probe(self, overrides=None, *, remove=()):
        env = os.environ.copy()
        for name in self._email_env_names:
            env.pop(name, None)
        env["DJANGO_SECRET_KEY"] = "test-secret"
        env.update(self._valid_env)
        env.update(overrides or {})
        for name in remove:
            env.pop(name, None)

        return subprocess.run(
            [sys.executable, "-c", self._probe],
            cwd=Path(__file__).resolve().parents[4],
            env=env,
            check=False,
            capture_output=True,
            text=True,
        )

    def _assert_invalid(self, variable, value=None, *, remove=False):
        overrides = {} if remove else {variable: value}
        removed_variables = (variable,) if remove else ()

        result = self._run_probe(overrides, remove=removed_variables)

        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(variable, result.stderr)
        if value and value.strip():
            self.assertNotIn(value, result.stderr.splitlines()[-1])

    def test_valid_configuration_uses_private_unauthenticated_smtp_hop(self):
        result = self._run_probe(
            {
                "CVAT_EMAIL_HOST": "  cvat_mail_relay  ",
                "CVAT_DEFAULT_FROM_EMAIL": ("  CVAT <no-reply@cvat.the-commander.net>  "),
            }
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        values = json.loads(result.stdout.splitlines()[-1])
        self.assertEqual(
            values,
            {
                "backend": "django.core.mail.backends.smtp.EmailBackend",
                "host": "cvat_mail_relay",
                "port": 25,
                "timeout": 10.0,
                "sender": "CVAT <no-reply@cvat.the-commander.net>",
                "username": "",
                "password": "",
                "tls": False,
                "ssl": False,
            },
        )

    def test_host_is_required(self):
        self._assert_invalid("CVAT_EMAIL_HOST", remove=True)
        self._assert_invalid("CVAT_EMAIL_HOST", "   ")

    def test_port_must_be_an_integer_in_the_tcp_range(self):
        for value in ("0", "65536", "abc"):
            with self.subTest(value=value):
                self._assert_invalid("CVAT_EMAIL_PORT", value)

    def test_timeout_must_be_positive(self):
        for value in ("0", "-1", "abc", "nan", "inf"):
            with self.subTest(value=value):
                self._assert_invalid("CVAT_EMAIL_TIMEOUT", value)

    def test_sender_is_required_and_must_be_a_single_valid_address(self):
        self._assert_invalid("CVAT_DEFAULT_FROM_EMAIL", remove=True)
        for value in (
            "   ",
            "not-an-email",
            "CVAT <no-reply@cvat.the-commander.net>\rBcc: attacker@example.com",
            "CVAT <no-reply@cvat.the-commander.net>\nBcc: attacker@example.com",
        ):
            with self.subTest(value=value):
                self._assert_invalid("CVAT_DEFAULT_FROM_EMAIL", value)

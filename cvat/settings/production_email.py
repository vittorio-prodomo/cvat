# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

import math
import os
from email.utils import getaddresses, parseaddr

from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.core.validators import validate_email

from .production import *  # pylint: disable=wildcard-import


def _required_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise ImproperlyConfigured(f"{name} is required")

    return value


def _bounded_integer_env(name, *, default, minimum, maximum):
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default

    try:
        value = int(raw_value.strip())
    except ValueError:
        raise ImproperlyConfigured(f"{name} must be an integer") from None

    if not minimum <= value <= maximum:
        raise ImproperlyConfigured(f"{name} must be between {minimum} and {maximum}")

    return value


def _positive_float_env(name, *, default):
    raw_value = os.environ.get(name)
    if raw_value is None:
        return float(default)

    try:
        value = float(raw_value.strip())
    except ValueError:
        raise ImproperlyConfigured(f"{name} must be a number") from None

    if not math.isfinite(value) or value <= 0:
        raise ImproperlyConfigured(f"{name} must be a positive finite number")

    return value


def _validated_sender_env(name):
    value = _required_env(name)
    if "\r" in value or "\n" in value:
        raise ImproperlyConfigured(f"{name} must contain a valid email address")

    _, address = parseaddr(value)
    if len(getaddresses([value])) != 1:
        raise ImproperlyConfigured(f"{name} must contain a valid email address")

    try:
        validate_email(address)
    except ValidationError:
        raise ImproperlyConfigured(f"{name} must contain a valid email address") from None

    return value


EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
EMAIL_HOST = _required_env("CVAT_EMAIL_HOST")
EMAIL_PORT = _bounded_integer_env("CVAT_EMAIL_PORT", default=25, minimum=1, maximum=65535)
EMAIL_TIMEOUT = _positive_float_env("CVAT_EMAIL_TIMEOUT", default=10)
DEFAULT_FROM_EMAIL = _validated_sender_env("CVAT_DEFAULT_FROM_EMAIL")
EMAIL_HOST_USER = ""
EMAIL_HOST_PASSWORD = ""
EMAIL_USE_TLS = False
EMAIL_USE_SSL = False

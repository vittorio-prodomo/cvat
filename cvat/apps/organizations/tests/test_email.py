# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

import re
from html import unescape
from urllib.parse import parse_qs, urlsplit

from allauth.account.models import EmailAddress
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
    def setUp(self):
        user_model = get_user_model()
        owner = user_model.objects.create_user(username="owner", email="owner@example.com")
        self.invitee = user_model.objects.create_user(
            username="invitee", email="invitee@example.com"
        )
        organization = Organization.objects.create(slug="email-test", owner=owner)
        membership = Membership.objects.create(
            user=self.invitee,
            organization=organization,
            role=Membership.WORKER,
        )
        self.invitation = Invitation.objects.create(
            key="test-invitation-key",
            owner=owner,
            membership=membership,
        )
        Site.objects.update_or_create(
            id=1,
            defaults={"domain": "lambda.the-commander.net", "name": "CVAT"},
        )

    def _send_email(self):
        request = RequestFactory().get("/", secure=True)
        with request_context(request):
            self.invitation.send(request)
        return mail.outbox[-1]

    def _assert_invitation_link(self, message, path):
        match = re.search(r'href="([^"]+)"', message.body)
        self.assertIsNotNone(match)
        url = urlsplit(unescape(match.group(1)))
        self.assertEqual(url.scheme, "https")
        self.assertEqual(url.netloc, "lambda.the-commander.net")
        self.assertEqual(url.path, path)
        self.assertEqual(
            parse_qs(url.query),
            {"email": [self.invitee.email], "invitation": [self.invitation.key]},
        )

    def test_new_invitee_gets_registration_link_and_configured_message(self):
        message = self._send_email()
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(message.from_email, "CVAT <no-reply@cvat.the-commander.net>")
        self.assertEqual(message.to, ["invitee@example.com"])
        self.assertIn("email-test", message.subject)
        self.assertEqual(message.content_subtype, "html")
        self._assert_invitation_link(message, "/auth/register")
        self.invitation.refresh_from_db()
        self.assertIsNotNone(self.invitation.sent_date)

    def test_registered_user_gets_login_link(self):
        self.invitee.set_password("Existing-user-password-42")
        self.invitee.save(update_fields=["password"])

        self._assert_invitation_link(self._send_email(), "/auth/login")

    def test_passwordless_registered_user_gets_login_link(self):
        EmailAddress.objects.create(
            user=self.invitee, email=self.invitee.email, primary=True, verified=True
        )

        self._assert_invitation_link(self._send_email(), "/auth/login")

    def test_registration_link_preserves_email_query_characters(self):
        for email in ("invitee+review@example.com", "invitee&team@example.com"):
            with self.subTest(email=email):
                self.invitee.email = email
                self.invitee.save(update_fields=["email"])
                self._assert_invitation_link(self._send_email(), "/auth/register")

    def test_resend_after_registration_switches_to_login(self):
        self._assert_invitation_link(self._send_email(), "/auth/register")

        self.invitee.set_password("Newly-registered-password-42")
        self.invitee.save(update_fields=["password"])

        self._assert_invitation_link(self._send_email(), "/auth/login")
        self.assertEqual(len(mail.outbox), 2)

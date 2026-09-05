"""Exercise password reset completion without contacting a server or changing accounts."""
import json
from pathlib import Path
import sys

from playwright.sync_api import sync_playwright, expect


directory = Path(sys.argv[1]).resolve()
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    url = (directory / "index.html").as_uri()

    def prepare(suffix=""):
        page.goto(url + suffix)
        page.wait_for_load_state("networkidle")
        page.get_by_placeholder("New password", exact=True).fill("FixturePassword123!")
        page.get_by_placeholder("Confirm new password", exact=True).fill("FixturePassword123!")
        return page.get_by_role("button", name="Change password")

    button = prepare()
    button.click()
    expect(button).to_be_disabled()
    assert page.evaluate("window.currentLocation.pathname") == "/auth/password/reset/confirm"
    assert page.evaluate("window.requests") == [{"uid": "test-user", "token": "test-token"}]
    page.evaluate("window.settleReset(false)")
    expect(button).to_be_enabled()
    expect(page.get_by_text("Could not set new password on the server.", exact=True)).to_be_visible()
    assert page.evaluate("window.currentLocation.pathname") == "/auth/password/reset/confirm"

    button.click()
    expect(button).to_be_disabled()
    page.evaluate("window.settleReset(true)")
    expect(page.get_by_role("heading", name="Sign in", exact=True)).to_be_visible(timeout=2000)
    expect(page.get_by_text("Password has been reset with the new password.", exact=True)).to_be_visible()
    assert page.evaluate("window.currentLocation.pathname + window.currentLocation.search") == "/auth/login"
    assert page.evaluate("window.actions") == [
        "RESET_PASSWORD_CONFIRM", "RESET_PASSWORD_CONFIRM_FAILED",
        "RESET_PASSWORD_CONFIRM", "RESET_PASSWORD_CONFIRM_SUCCESS",
    ]
    page.evaluate("window.appHistory.goBack()")
    expect(page.get_by_role("heading", name="Previous page", exact=True)).to_be_visible()

    button = prepare("?missing-token")
    button.click()
    expect(button).to_be_enabled()
    assert page.evaluate("window.requests") == []
    assert page.evaluate("window.currentLocation.pathname") == "/auth/password/reset/confirm"
    assert not errors, errors
    report = {"pending_stays_on_form": True, "failure_stays_on_form": True,
              "retry_success_redirects": True, "success_notification_retained": True,
              "history_replaced_and_token_removed": True, "missing_token_not_submitted": True,
              "browser_errors": errors, "real_accounts_changed": 0}
    (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
    browser.close()

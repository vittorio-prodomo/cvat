"""Check clearing and reassigning using the real shared dropdown in Chromium.

Build the fixture using user-selector-browser.cjs first, then pass its directory.
The fixture stubs only user discovery and persistence; it never connects to CVAT.
"""
import json
from pathlib import Path
import sys

from playwright.sync_api import sync_playwright, expect


directory = Path(sys.argv[1]).resolve()
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    url = (directory / "index.html").as_uri()

    def reset(bulk=False):
        page.goto(url + ("?bulk" if bulk else ""))
        page.wait_for_load_state("networkidle")
        expect(page.get_by_role("combobox")).to_have_value("" if bulk else "baldus")
        return page.get_by_role("combobox")

    def unassigned():
        return page.locator(".ant-select-item-option-content").filter(has_text="Unassigned")

    field = reset()
    field.click()
    expect(unassigned()).to_be_visible(timeout=1500)
    page.screenshot(path=str(directory / "unassigned-choice.png"))
    unassigned().click()
    page.locator("#outside").click()
    expect(field).to_have_value("")
    assert page.evaluate("window.changes") == [None]

    field.click()
    page.locator(".ant-select-item-option-content").filter(has_text="alice").click()
    page.locator("#outside").click()
    expect(field).to_have_value("alice")
    assert page.evaluate("window.changes") == [None, 3]

    field = reset()
    field.fill("no_matching_user")
    expect(page.locator(".ant-select-item-option-content").filter(has_text="baldus")).to_have_count(0)
    expect(unassigned()).to_be_visible()
    unassigned().click()
    page.locator("#outside").click()
    expect(field).to_have_value("")
    assert page.evaluate("window.changes") == [None]

    field = reset()
    field.click()
    # Wait for the debounced username search to finish before navigating.
    # Replacing search results resets Ant Design's active keyboard option.
    expect(page.locator(".ant-select-item-option-content").filter(has_text="alice")).to_have_count(0)
    # Ant Design starts keyboard navigation from the currently selected user;
    # the preceding option in our stable list is the explicit blank choice.
    field.press("ArrowUp")
    expect(page.locator(".ant-select-item-option-active")).to_have_text("Unassigned")
    field.press("Enter")
    expect(field).to_have_value("")
    page.locator("#outside").click()
    assert page.evaluate("window.changes") == [None]

    field = reset(bulk=True)
    field.click()
    unassigned().click()
    page.locator("#outside").click()
    assert page.evaluate("window.changes") == [None]
    assert not errors, errors
    report = {"mouse_clear": True, "reassign": True, "clear_during_unmatched_search": True,
              "keyboard_clear": True, "bulk_clear_from_blank": True, "browser_errors": errors}
    (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
    browser.close()

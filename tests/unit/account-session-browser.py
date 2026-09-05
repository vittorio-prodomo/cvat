"""Exercise logout routing and shortcut reuse without real accounts or a server."""
import json
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright, expect

directory = Path(sys.argv[1]).resolve()
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    report = {}

    def prepare():
        page.goto((directory / 'index.html').as_uri())
        expect(page.get_by_role('heading', name='Job', exact=True)).to_be_visible()

    prepare()
    page.keyboard.press('n')
    assert page.evaluate('window.draws') == 1
    page.evaluate('window.store.dispatch(window.shortcutsActions.switchShortcutsModalVisible(true))')
    page.evaluate("window.appHistory.push('/auth/logout')")
    expect(page.get_by_role('heading', name='Sign in', exact=True)).to_be_visible()
    page.wait_for_timeout(100)
    report['logout_location'] = page.evaluate('window.currentLocation.pathname + window.currentLocation.search')
    report['logout_events'] = page.evaluate('window.events')
    report['job_mounts_after_logout'] = page.evaluate('window.jobMounts')
    report['shortcut_help_closed'] = not page.evaluate('window.store.getState().shortcuts.visibleShortcutsHelp')
    page.evaluate('window.logBackIn()')
    page.evaluate("window.appHistory.push('/tasks/305/jobs/364')")
    expect(page.get_by_role('heading', name='Job', exact=True)).to_be_visible()
    page.keyboard.press('n')
    report['draws_after_account_switch'] = page.evaluate('window.draws')
    report['shortcuts_after_account_switch'] = page.evaluate('Object.keys(window.store.getState().shortcuts.keyMap)')
    prepare()
    page.evaluate("window.store.dispatch(window.shortcutsActions.updateSequence('SWITCH_DRAW_MODE_STANDARD_CONTROLS', ['k']))")
    page.evaluate("window.appHistory.push('/auth/logout')")
    expect(page.get_by_role('heading', name='Sign in', exact=True)).to_be_visible()
    page.evaluate('window.logBackIn(); window.restoreSettings()')
    page.evaluate("window.appHistory.push('/tasks/305/jobs/364')")
    expect(page.get_by_role('heading', name='Job', exact=True)).to_be_visible()
    page.keyboard.press('k')
    report['custom_shortcut_after_switch'] = page.evaluate('window.draws')
    report['original_default'] = page.evaluate("window.store.getState().shortcuts.defaultState.SWITCH_DRAW_MODE_STANDARD_CONTROLS?.sequences")
    prepare()
    page.evaluate('window.failLogs = true')
    page.evaluate('window.saveLogs()')
    report['authenticated_log_failure_visible'] = page.evaluate("window.events.includes('SAVE_LOGS_FAILED')")
    prepare()
    page.evaluate("window.appHistory.push('/tasks')")
    expect(page.get_by_role('heading', name='Tasks', exact=True)).to_be_visible()
    page.evaluate('window.delayLogs = true; void window.saveLogs()')
    page.evaluate('window.finishSession()')
    expect(page.get_by_role('heading', name='Sign in', exact=True)).to_be_visible()
    page.evaluate('window.finishLogs()')
    report['late_log_failure_visible'] = page.evaluate("window.events.includes('SAVE_LOGS_FAILED')")
    page.evaluate('window.delayLogs = false; window.events = []')
    page.evaluate('window.saveLogs()')
    report['logged_out_save_events'] = page.evaluate('window.events')
    prepare()
    page.evaluate("window.failLogout = true; window.appHistory.push('/auth/logout')")
    page.wait_for_function("window.events.includes('LOGOUT_FAILED')")
    report['logout_failure_preserves_user'] = page.evaluate('window.store.getState().auth.user?.id') == 1
    report['logout_failure_does_not_show_login'] = page.get_by_role('heading', name='Sign in', exact=True).count() == 0
    report['logout_failure_retryable'] = not page.evaluate('window.store.getState().auth.fetching')
    prepare()
    page.evaluate("window.store.dispatch({ type: 'RESET_AFTER_ERROR' })")
    expect(page.get_by_role('heading', name='Sign in', exact=True)).to_be_visible()
    page.evaluate('window.logBackIn()')
    expect(page.get_by_role('heading', name='Tasks', exact=True)).to_be_visible()
    page.evaluate("window.appHistory.push('/tasks/305/jobs/364')")
    expect(page.get_by_role('heading', name='Job', exact=True)).to_be_visible()
    page.keyboard.press('n')
    report['shortcuts_after_error_recovery'] = page.evaluate('window.draws') == 1
    prepare()
    page.evaluate("window.appHistory.push('/tasks')")
    expect(page.get_by_role('heading', name='Tasks', exact=True)).to_be_visible()
    page.evaluate('window.delayLogs = true; void window.saveLogs()')
    page.evaluate("window.store.dispatch({ type: 'UPDATE_USER_SUCCESS', payload: { user: { id: 1, firstName: 'Updated' } } })")
    page.evaluate('window.finishLogs()')
    report['profile_update_preserves_log_errors'] = page.evaluate("window.events.includes('SAVE_LOGS_FAILED')")
    page.evaluate('window.events = []; void window.saveLogs()')
    page.evaluate('window.finishSession()')
    expect(page.get_by_role('heading', name='Sign in', exact=True)).to_be_visible()
    page.evaluate('window.logBackIn(1)')
    expect(page.get_by_role('heading', name='Tasks', exact=True)).to_be_visible()
    page.evaluate('window.finishLogs()')
    report['same_account_relogin_ignores_stale_errors'] = not page.evaluate("window.events.includes('SAVE_LOGS_FAILED')")
    page.goto((directory / 'index.html').as_uri() + '?direct-logout')
    page.wait_for_function("window.events.includes('LOGOUT_FAILED')")
    page.wait_for_timeout(100)
    report['direct_logout_failure_recovers'] = page.get_by_role('heading', name='Tasks', exact=True).count() == 1
    report['browser_errors'] = errors
    (directory / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    assert report['logout_location'] == '/auth/login', 'Logout must not go back to the job URL'
    assert report['job_mounts_after_logout'] == 1, 'Logout must not reopen the job'
    assert 'logs:anonymous' not in report['logout_events'], 'No log uploads after authentication ends'
    assert report['draws_after_account_switch'] == 2, 'N must work without a page reload'
    assert report['custom_shortcut_after_switch'] == 1, 'Custom shortcuts must survive account switching'
    assert report['original_default'] == ['n'], 'Restore defaults must retain original bindings'
    assert report['authenticated_log_failure_visible'], 'Do not hide ordinary logging errors'
    assert not report['late_log_failure_visible'], 'Do not show stale logging errors after logout'
    assert not report['logged_out_save_events'], 'Do not start job log requests while logged out'
    assert report['logout_failure_preserves_user'] and report['logout_failure_does_not_show_login']
    assert report['logout_failure_retryable']
    assert report['shortcut_help_closed'] and report['shortcuts_after_error_recovery']
    assert report['profile_update_preserves_log_errors'], 'Profile edits do not end the session'
    assert report['same_account_relogin_ignores_stale_errors']
    assert report['direct_logout_failure_recovers'], 'A direct logout failure must leave the spinner'
    assert not errors, errors
    browser.close()

# Account session fixes implementation checklist

**Goal:** Stage reliable shortcut reuse and explicit logout alongside the existing password-reset redirect. No deployment, commits, or account mutations.

**Approach:** Keep the browser-wide shortcut registry and its original defaults when authentication resets. Successful explicit logout replaces the route with `/auth/login`. Job log saves require a current user and use an authentication session counter to ignore completions from a session that has ended; profile edits preserve the counter and ordinary failures still report errors. Failed logout returns to `/tasks` for retry, including direct logout entry.

- [x] Create `fix/account-session-fixes` from develop and copy the staged UI sources with a hash manifest.
- [x] Reproduce the lost N/custom bindings and job return URL using real React routing, reducers, actions, and hotkey registration.
- [x] Add delayed logging and unsuccessful logout cases to the browser regression fixture.
- [x] Preserve shortcut state while closing its help dialog on logout/error reset in `cvat-ui/src/reducers/shortcuts-reducer.ts`.
- [x] Capture original defaults only once in `cvat-ui/src/actions/settings-actions.ts`.
- [x] Return a success result from `logoutAsync`; replace the logout component's unconditional history traversal with success-only login navigation, retaining failure recovery.
- [x] Guard `saveLogsAsync` against requests/completions after a user session ends.
- [x] Verify same-tab login, real keyboard events, custom/default bindings, logout failure, logging failure, and the earlier password-reset redirect.
- [x] Lint changed production files, check the diff and inherited file hashes, and leave the combined batch staged.

Run browser fixtures with `node tests/unit/account-session-browser.cjs /tmp/cvat-account-session-browser` followed by `/tmp/cvat-sam3-text-browser-venv/bin/python tests/unit/account-session-browser.py /tmp/cvat-account-session-browser`.

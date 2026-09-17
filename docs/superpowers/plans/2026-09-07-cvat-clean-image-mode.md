# CVAT Clean Image Mode Implementation Plan

> Agent-consumable implementation and verification checklist. The human design is in `docs/plans/2026-09-07-cvat-clean-image-mode-design.html`.

**Goal:** A transient, reversible 2D inspection mode with registered/rebindable Shift+H, preserving annotation data, visibility preferences, and unsent review drafts.

**Status:** Implemented in `.worktrees/clean-image-mode` on `feat/clean-image-mode`. Changes remain uncommitted. Local checks are recorded below; Cypress execution requires a local test stack. Commit, merge, push, and deployment require separate authorization.

## Final architecture and invariants

- Redux `annotation.canvas.cleanImageMode` controls presentation. `detectorInferencePending` is derived from transient `detectorOperationIDs` and independently blocks entry during requests, initial processing, and annotation writes. Each operation gets a unique ID so cleanup releases only its own guard.
- The registered top-bar control permits idle inspection, pan, wheel zoom, and ROI drag-to-zoom. It refuses entry during annotation editing, drawing, review-region selection, AI/OpenCV operations, or pending detector inference.
- The mode persists across frames, resets on close/logout/reload, and is not saved in user settings or annotation data.
- Text, mask, bitmap, grid, and attachment roots are visibility-hidden. A WeakMap restores each root's exact prior inline visibility after repeated configuration.
- `#cvat_canvas_content` remains visible as the SVG event plane. Its scoped `cvat_canvas_clean_image` class suppresses current and future direct children with `display: none !important`, except `.cvat_canvas_zoom_selection`.
- The source background and its filters/transforms are unaffected by toggling. Native SVG coordinate mapping and listeners remain usable for ROI dragging. Zoom cancellation removes all three listeners and any unfinished selection rectangle.
- Frame tags and canvas context menus are omitted. Review issue labels and stateful `IssueDialog`/`CreateIssueDialog` portals stay mounted inside the hidden attachment board, preserving unsent input and component identity.
- Issue regions and conflict mapping are cleared while clean; transient conflict highlighting is cleared. Conflict records and visibility preferences remain unchanged, and visible conflict labels are rebuilt on restoration.
- Review thunks share the conditional 2D mutation boundary before creating, commenting, resolving, reopening, or deleting an issue. Focused controls kept inside the hidden board can receive Enter; their submission exits clean before core mutation. Legacy plain create/start/submit-review actions also exit through the annotation reducer.
- Mutation actions synchronously dispatch clean exit before core save/delete/create, bulk removal, propagation, layer changes, merge/group/join/slice/split, group color, and undo/redo. The shared boundary does nothing if clean is disabled or the instance is not the 2D canvas.
- 2D operation starters dispatch the unsafe control/drawing transition before calling the canvas start API. Cancellation remains first; slice snapshots the selected client ID before the transition deactivates it. The shared draw popover preserves the previous 3D ordering.
- Detector start synchronously exits clean and registers an operation ID before the server call. Pre-write cancellation, frame/job/model/tab change, deactivation, and unmount release the current request token. Once `createAnnotations` starts, the component awaits its Promise and retains that token through success or failure, including cancellation or unmount. Core writes are not cancelable; only their finalizers release these tokens. Direct-create, tags-only, and Preview Done share this boundary. Close/logout reset all tokens; stale finalizers cannot release new component/job tokens. Cleanup after unmount never calls `setState`.

## Completed implementation tasks

- [x] Add pure operation guards, shortcut controller, indicator, and transient reducer state.
- [x] Pass clean configuration through the 2D wrapper/model/view.
- [x] Preserve the content SVG event plane and exempt only the ROI selection rectangle from child suppression.
- [x] Restore prior root visibility and clean up zoom listeners/unfinished selection.
- [x] Preserve review dialog mounts/drafts inside the hidden attachment board; suppress issue regions and conflict mapping.
- [x] Add token-scoped detector lifecycle, guarded entry through asynchronous writes, direct-create/Done coverage, and stale-finalizer protection across component/job changes.
- [x] Guard all review mutation thunks and legacy plain submit/create/start actions while preserving mounted drafts.
- [x] Add a shared mutation-action exit boundary for object buttons, shortcuts, and bulk APIs.
- [x] Reorder 2D draw, issue, merge/group/split/join/slice, tracker/interactor, and repeat-interaction starters. Verify OpenCV already dispatches before its start API.
- [x] Preserve selected slice target and existing 3D behavior.

## TDD evidence and regression coverage

`tests/unit/clean-image-mode.cjs` loads real TypeScript implementations through focused dependency adapters. Its checks include:

- Pure entry policy and registered/rebound shortcut behavior.
- Actual reducer toggle/context-menu closure, frame persistence, close/logout reset, every unsafe exit transition, and detector pending guard.
- Root visibility restoration, canvas reconfiguration, ROI coordinate mapping, full listener removal, and unfinished selection cleanup.
- Populated conflict mapping/rendering, hidden-object filtering, highlight clearing, and restoration.
- Actual ReactDOM lifecycle with the real issue and new-issue dialog components, asserting stable input node identity and retained unsent values across toggles. Portals stay inside the hidden attachment board. The harness substitutes optional raster support and UI primitives; it does not need a native canvas binding.
- Actual annotation action/reducer ordering for Delete, the object lock handler, bulk property updates, creation, bulk deletion, layers, merge/group/join/slice/split, propagation, and undo/redo.
- Real draw and issue/join/slice shortcut ordering, selected slice target preservation, and repeated AI interaction ordering.
- Every review write thunk, focused hidden-dialog Enter submission, legacy plain review actions, and actual reducer token isolation after job reset.

`tests/unit/detector-preview-transaction.cjs` verifies pending state before inference, all completion/cancellation paths, no-preview/tags-only/Done writes, old/new request races, and tracker dispatch-before-canvas ordering. Deferred Promise cases prove Clean entry remains refused until writes settle, materialization happens under the guard, rejected writes release tokens, cancellation/unmount cannot release active writes early, and either completion order preserves other operations, including a new job session.

The correction passes added failing regressions before their production fixes. Earlier Boolean-helper-only tests are supplemented by actual reducer and command tests.

`tests/cypress/e2e/features2/clean_image_mode.js` covers:

- Mixed rectangles, polygons, masks, tags, and issue UI; prior hidden state restoration across frames.
- Live content SVG and hidden annotation children/root assertions.
- An actual `realMouseDown`/`realMouseMove`/`realMouseUp` ROI drag, a visible selection rectangle, increased source-image width, and an unchanged active Clean indicator.
- Unsafe draw refusal, exit-before-drawing, shortcut listing, and rebinding.
- This fixture has no ground-truth job. Populated quality-conflict rendering is tested in the unit/controller harness, not claimed as browser fixture coverage.

## Verification commands

Run from `/data/cvat/.worktrees/clean-image-mode`. Dependencies are available from the parent checkout.

```bash
node tests/unit/clean-image-mode.cjs
node tests/unit/detector-preview-transaction.cjs
/data/cvat/node_modules/.bin/tsc --project cvat-ui/tsconfig.json --noEmit
/data/cvat/node_modules/.bin/tsc --project cvat-canvas/tsconfig.json --noEmit
node --check tests/unit/clean-image-mode.cjs
node --check tests/unit/detector-preview-transaction.cjs
node --check tests/cypress/e2e/features2/clean_image_mode.js
git diff --check
```

Run `/data/cvat/node_modules/.bin/eslint --max-warnings 0` on all changed/new `.ts`, `.tsx`, and `.js` files, including the Cypress source. Compile `cvat-canvas/src/scss/canvas.scss` with Sass and confirm the scoped zoom-selection exemption. Parse the human HTML document.

Browser execution is pending; use only a local test stack. Do not run these tests against public production. A production UI build and runtime deployment verification remain separate steps.

## Integration boundary

Keep the worktree and uncommitted changes available for review. After explicit integration authorization, commit/review/merge according to the repository workflow. Deployment needs a rebuilt UI image and separate approval; no server migration, API change, database change, or Nuclio deployment is involved.

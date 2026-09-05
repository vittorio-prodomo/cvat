# Adaptive Frame Tag Contrast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make top-left CVAT frame tags choose readable black or white foreground text and close-icon colors from their label background.

**Architecture:** Keep one shared `computeTextColor()` utility, but make its black/white choice use standard sRGB relative luminance and greater WCAG contrast. At the `FrameTags` rendering boundary, apply the computed value as an inline style to each Ant Design `Tag` and directly to the removable tag's close icon because Ant Design gives that descendant its own light foreground rule.

**Tech Stack:** React 18, TypeScript, Ant Design 5, Node test runner, TypeScript `transpileModule`, Cypress, SCSS.

---

### Task 1: Add adaptive foreground behavior to frame tags

**Files:**
- Create: `tests/unit/frame-tag-contrast.cjs`
- Modify: `cvat-ui/src/components/annotation-page/tag-annotation-workspace/frame-tags.tsx`
- Modify: `cvat-ui/src/utils/compute-text-color.ts`

- [ ] **Step 1: Write the failing component-harness test**

Create a Node test that transpiles the real `frame-tags.tsx`, stubs React/Redux/Ant Design only at external boundaries, supplies ordinary white and purple frame-tag states plus a white ground-truth tag, and inspects the resulting `Tag` element props. Assert that the existing source fails because it does not yet provide these values:

```js
assert.equal(whiteTag.props.style.color, '#000000');
assert.equal(whiteTag.props.closeIcon.props.style.color, '#000000');
assert.equal(purpleTag.props.style.color, '#ffffff');
assert.equal(purpleTag.props.closeIcon.props.style.color, '#ffffff');
assert.equal(whiteGroundTruthTag.props.style.color, '#000000');
```

The harness must load the real `computeTextColor()` implementation instead of reimplementing its threshold. Add utility expectations for `#ffffff`, `#000000`, `#6f42c1`, `#24b353`, `#3df53d`, `#fa3253`, and `#ff007c`, plus malformed input.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test tests/unit/frame-tag-contrast.cjs
```

Expected: the component behavior initially FAILS on missing `style.color` or `closeIcon`. After the first wiring change, the palette regression must FAIL on at least `#24b353` under the old arithmetic-average helper.

- [ ] **Step 3: Correct the shared foreground calculation and implement the rendering fix**

Validate exact `#RRGGBB`, linearize each sRGB component, calculate relative luminance, and choose the greater contrast:

```ts
const blackContrast = (luminance + 0.05) / 0.05;
const whiteContrast = 1.05 / (luminance + 0.05);
return blackContrast >= whiteContrast ? '#000000' : '#ffffff';
```

Invalid input must continue returning `#ffffff`.

In `frame-tags.tsx`, import `CloseOutlined` and `computeTextColor`. For each ordinary frame tag, compute once:

```tsx
const foregroundColor = computeTextColor(tag.label.color);
```

Then preserve all existing props while adding:

```tsx
style={{ color: foregroundColor }}
closeIcon={<CloseOutlined style={{ color: foregroundColor }} />}
```

Apply the same `style={{ color: foregroundColor }}` to ground-truth tags. Do not change background colors, stored labels, highlighting, filtering, removal, or ground-truth behavior.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test tests/unit/frame-tag-contrast.cjs
```

Expected: all frame-tag contrast assertions PASS.

The same test file must also render real React 18 and the installed Ant Design 5.17.1 Tag in JSDOM, using the actual `CloseOutlined`, and verify computed foreground/background colors, SVG `currentColor`, GT non-closability, and the exact removal dispatch. Treat JSDOM/canvas as optional test enhancements: skip only the DOM case if the exact optional package is unavailable, and rethrow transitive or unrelated module errors.

- [ ] **Step 5: Run focused static checks**

Run the candidate's pinned UI builder checks for the modified component and test:

```bash
yarn eslint cvat-ui/src/components/annotation-page/tag-annotation-workspace/frame-tags.tsx
node --test tests/unit/frame-tag-contrast.cjs
git diff --check
```

Expected: zero ESLint diagnostics, all tests PASS, and no whitespace errors.

No commit is part of this task; commit, push, merge, and deployment require separate authorization.

### Task 2: Validate the built UI behavior and refresh the candidate

**Files:**
- Modify if needed: `tests/cypress/e2e/actions_objects/case_22_tag_annotation_mode.js`
- Create/update durable evidence under: `/data/cvat/data/deployments/indoor-v3-label-mapping/`
- Update: `/data/cvat/data/deployments/indoor-v3-label-mapping/candidate-receipt-20260905.json`

- [ ] **Step 1: Add a browser-level computed-style regression if the existing Cypress fixture can safely supply a white tag**

The browser assertion must check both descendants rather than only existence:

```js
cy.get('.cvat-frame-tag').should('have.css', 'color', 'rgb(0, 0, 0)');
cy.get('.cvat-frame-tag .ant-tag-close-icon').should('have.css', 'color', 'rgb(0, 0, 0)');
```

If changing the shared Cypress fixture would create cross-test state, keep the repository test in the isolated Node harness and perform this check in the disposable candidate Chromium harness instead.

- [ ] **Step 2: Run the established UI verification suite**

Use the same pinned clean builder and worktree-local package resolution as the existing candidate. Run the new Node test, all existing custom tests, TypeScript, targeted ESLint, stylelint for touched styles, and production webpack. Expected: all pass with zero diagnostics.

- [ ] **Step 3: Build a replacement UI candidate image**

Build from `/data/cvat/.worktrees/sam3-concept-indoor-mapping` using a new immutable tag derived from `cvat/ui:sam3-concept-indoor-mapping-20260905`. Do not replace the live `cvat_ui` service.

- [ ] **Step 4: Verify computed colors in disposable Chromium**

Render white/light and purple/dark frame tags from the built candidate. Assert black foreground for white/light labels, white foreground for purple/dark labels, matching close-icon foreground, unchanged label backgrounds, and no browser errors.

- [ ] **Step 5: Refresh receipts without changing Project 40 or production**

Update source manifests, UI image identity, browser evidence, artifact hashes, and candidate receipt hashes. Do not run another Project 40 rollback probe. Confirm Project 40 application rows, Job 182 annotations, live service container/image identities, SAM3 candidate identity, and Indoor v3 function identity through read-only checks.

No commit, push, merge, Project 40 `--apply`, or production deployment is part of this plan.

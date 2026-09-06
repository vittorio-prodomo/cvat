# Indoor v3 Postprocessing Compatibility Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Indoor v3 declare that C5 and C6 may participate in cross-class NMS/NMM while formatting mapped detector confidence attributes to exactly two decimal places.

**Architecture:** Nuclio exposes validated model-label compatibility groups through the existing function metadata API. The detector runner resolves those names through its active model-to-task mapping and supplies task-label ID groups to the browser worker, which changes only its partition keys. Full-precision numeric scores remain authoritative; the mapped text attribute is formatted at the end of postprocessing.

**Tech Stack:** Python/Django REST metadata adapter, TypeScript CVAT core and React UI, browser Web Worker, Node test runner, Pytest/Django tests, Nuclio YAML.

**Commit boundary:** The commands listed below document logical commits. Do not execute commits, pushes, merges, or deployments without the user's separate authorization.

---

### Task 1: Recover and pin the deployed Indoor v3 source package

**Files:**
- Create: `serverless/pytorch/rfdetr/indoor-v3/*` from the confidence-enabled deployed source worktree
- Test: `serverless/pytorch/rfdetr/indoor-v3/test_package_contract.py`

- [x] **Step 1: Copy the existing package without modifying its source worktree**

```bash
cp -a /data/cvat/.worktrees/detector-confidence-attribute/serverless/pytorch/rfdetr/indoor-v3 \
  serverless/pytorch/rfdetr/
```

- [x] **Step 2: Verify the confidence-enabled package contract**

```bash
python -m pytest serverless/pytorch/rfdetr/indoor-v3/test_package_contract.py -q
```

Expected: the existing package tests pass and the handler emits `model_confidence`.

- [ ] **Step 3: Record the logical commit**

```bash
git add serverless/pytorch/rfdetr/indoor-v3
git commit -m "feat(serverless): track Indoor v3 detector package"
```

### Task 2: Add and validate compatibility-group function metadata

**Files:**
- Modify: `cvat/apps/lambda_manager/views.py`
- Create: `cvat/apps/lambda_manager/tests/test_function_metadata.py`

- [x] **Step 1: Write failing API metadata tests**

Construct a minimal detector fixture whose annotation includes:

```json
"postprocessing_label_groups": "[[\"bicycle\", \"car\"]]"
```

Assert that the function listing returns:

```python
self.assertEqual(function["postprocessing_label_groups"], [["bicycle", "car"]])
```

Add focused constructor cases asserting `InvalidFunctionMetadataError` for malformed JSON, non-array groups, groups shorter than two distinct names, unknown labels, repeated members, non-string members, and a label appearing in multiple groups.

- [x] **Step 2: Run the focused tests and verify RED**

```bash
python manage.py test cvat.apps.lambda_manager.tests.test_function_metadata
```

Expected: compatibility metadata is absent or invalid declarations are accepted.

- [x] **Step 3: Implement strict parsing in the function adapter**

After labels are parsed, read `postprocessing_label_groups`, default to `[]`, and validate it against `{label["name"] for label in self.labels}`. Store a fresh nested list on `self.postprocessing_label_groups`. In `to_dict`, expose `postprocessing_label_groups` only when non-empty.

- [x] **Step 4: Run the focused tests and verify GREEN**

```bash
python manage.py test cvat.apps.lambda_manager.tests.test_function_metadata
```

Expected: all lambda-manager tests pass.

- [ ] **Step 5: Record the logical commit**

```bash
git add cvat/apps/lambda_manager/views.py cvat/apps/lambda_manager/tests/test_function_metadata.py
git commit -m "feat(lambda): expose detector postprocessing label groups"
```

### Task 3: Carry model metadata through CVAT core

**Files:**
- Modify: `cvat-core/src/core-types.ts`
- Modify: `cvat-core/src/ml-model.ts`
- Test: `tests/unit/ml-model-postprocessing-groups.cjs`

- [x] **Step 1: Write a failing defensive-copy test**

Construct `MLModel` with `postprocessing_label_groups: [["C5", "C6"]]`, assert `postprocessingLabelGroups` returns the group, mutate the returned nested array, and assert a second getter call still returns the original data.

- [x] **Step 2: Run the test and verify RED**

```bash
node --test tests/unit/ml-model-postprocessing-groups.cjs
```

Expected: `postprocessingLabelGroups` is undefined.

- [x] **Step 3: Add the serialized field and immutable getter**

```ts
postprocessing_label_groups?: string[][];

public get postprocessingLabelGroups(): string[][] {
    return Array.isArray(this.serialized.postprocessing_label_groups) ?
        this.serialized.postprocessing_label_groups.map((group) => [...group]) : [];
}
```

- [x] **Step 4: Run the test and verify GREEN**

```bash
node --test tests/unit/ml-model-postprocessing-groups.cjs
```

- [ ] **Step 5: Record the logical commit**

```bash
git add cvat-core/src/core-types.ts cvat-core/src/ml-model.ts tests/unit/ml-model-postprocessing-groups.cjs
git commit -m "feat(core): expose postprocessing label groups"
```

### Task 4: Resolve model-label groups through the active mapping

**Files:**
- Modify: `cvat-ui/src/components/model-runner-modal/label-mapping-utils.ts`
- Modify: `cvat-ui/src/components/model-runner-modal/detector-runner.tsx`
- Modify: `cvat-ui/src/components/model-runner-modal/detector-runner-config.ts`
- Test: `tests/unit/detector-label-groups.cjs`

- [x] **Step 1: Write failing mapping tests**

Test `resolvePostprocessingLabelGroups` with C5 mapped to `C5_infiltrazione` and C6 mapped to `C6_umidita`; expect their numeric task IDs in one group. Also assert groups disappear when fewer than two distinct task labels remain and that unrelated declared groups are resolved independently.

- [x] **Step 2: Run the test and verify RED**

```bash
node --test tests/unit/detector-label-groups.cjs
```

Expected: the resolver export is missing.

- [x] **Step 3: Implement the pure resolver and run option**

Build a model-name to mapped-task-name table from `FullMapping`, resolve task IDs from the runner's `labels`, deduplicate each group, and return only groups with at least two IDs. Add `labelGroups?: number[][]` to `DetectorPostprocessingOptions`, then include the resolver result when constructing `interactiveOptions.postprocessing`.

- [x] **Step 4: Run the test and verify GREEN**

```bash
node --test tests/unit/detector-label-groups.cjs
```

- [ ] **Step 5: Record the logical commit**

```bash
git add cvat-ui/src/components/model-runner-modal tests/unit/detector-label-groups.cjs
git commit -m "feat(ui): resolve detector postprocessing label groups"
```

### Task 5: Use compatibility groups in NMS and NMM partitions

**Files:**
- Modify: `cvat-ui/src/utils/detector-postprocessing.ts`
- Modify: `tests/unit/detector-postprocessing.test.ts`

- [x] **Step 1: Write failing algorithm tests**

Add separate cases for NMS, full NMM, and greedy NMM using label IDs 5 and 6 in one `labelGroups` entry. Assert that higher confidence supplies the class, equal scores preserve source order, a third label remains isolated, Disabled bypasses the group, and invalid group overlap is rejected.

- [x] **Step 2: Run the test and verify RED**

```bash
node --experimental-strip-types --test tests/unit/detector-postprocessing.test.ts
```

Expected: C5 and C6 remain in distinct partitions.

- [x] **Step 3: Implement compatibility partition keys**

Validate that group members are safe integer IDs and that one ID does not appear in multiple groups. Create keys `group:<index>` for members and `label:<id>` otherwise. Keep `mergeGroup` anchored on existing confidence/source ranking so the winner's label and metadata survive.

- [x] **Step 4: Run the test and verify GREEN**

```bash
node --experimental-strip-types --test tests/unit/detector-postprocessing.test.ts
```

- [ ] **Step 5: Record the logical commit**

```bash
git add cvat-ui/src/utils/detector-postprocessing.ts tests/unit/detector-postprocessing.test.ts
git commit -m "feat(ui): support detector compatibility groups"
```

### Task 6: Format mapped confidence text to two decimals

**Files:**
- Modify: `cvat-ui/src/utils/detector-postprocessing.ts`
- Modify: `tests/unit/detector-postprocessing.test.ts`

- [x] **Step 1: Write failing formatting tests**

Assert ordinary NMS, Disabled, full NMM, and greedy NMM results rewrite the mapped confidence attribute to `0.90`, while the numeric `score` remains `0.904321`, non-confidence attributes remain unchanged, and missing or invalid scores retain their original text.

- [x] **Step 2: Run the test and verify RED**

```bash
node --experimental-strip-types --test tests/unit/detector-postprocessing.test.ts
```

Expected: ordinary results retain long handler strings and merged results use four decimals.

- [x] **Step 3: Format only the mapped attribute at final output**

Add a pure finalization helper that clones a shape's attributes and replaces the attribute matching `confidenceAttributeSpecID` with `score.toFixed(2)` only for a finite score in `[0, 1]`. Apply it after filtering/partition processing and before returning sorted shapes.

- [x] **Step 4: Run the test and verify GREEN**

```bash
node --experimental-strip-types --test tests/unit/detector-postprocessing.test.ts
```

- [ ] **Step 5: Record the logical commit**

```bash
git add cvat-ui/src/utils/detector-postprocessing.ts tests/unit/detector-postprocessing.test.ts
git commit -m "fix(ui): format detector confidence to two decimals"
```

### Task 7: Declare Indoor v3's C5/C6 group and verify the boundary

**Files:**
- Modify: `serverless/pytorch/rfdetr/indoor-v3/function-gpu.yaml`
- Modify: `serverless/pytorch/rfdetr/indoor-v3/test_package_contract.py`

- [x] **Step 1: Write the failing manifest contract assertion**

Assert `annotations["postprocessing_label_groups"]` parses as exactly `[["C5", "C6"]]` and every declared member occurs in the function label specification.

- [x] **Step 2: Run the test and verify RED**

```bash
python -m pytest serverless/pytorch/rfdetr/indoor-v3/test_package_contract.py -q
```

Expected: the annotation is missing.

- [x] **Step 3: Add the declaration**

```yaml
postprocessing_label_groups: '[["C5", "C6"]]'
```

- [x] **Step 4: Run package and UI tests**

```bash
python -m pytest serverless/pytorch/rfdetr/indoor-v3 -q
node --experimental-strip-types --test \
  tests/unit/detector-runner-config.test.ts \
  tests/unit/detector-label-groups.cjs \
  tests/unit/detector-postprocessing.test.ts \
  tests/unit/label-mapping-initialization.test.ts \
  tests/unit/ml-model-postprocessing-groups.cjs
```

Expected: all tests pass.

- [x] **Step 5: Run static checks**

```bash
yarn eslint \
  cvat-core/src/core-types.ts \
  cvat-core/src/ml-model.ts \
  cvat-ui/src/components/model-runner-modal/detector-runner-config.ts \
  cvat-ui/src/components/model-runner-modal/detector-runner.tsx \
  cvat-ui/src/components/model-runner-modal/label-mapping-utils.ts \
  cvat-ui/src/utils/detector-postprocessing.ts \
  tests/unit/detector-label-groups.cjs \
  tests/unit/detector-postprocessing.test.ts \
  tests/unit/ml-model-postprocessing-groups.cjs
yarn type-check
python -m compileall -q cvat/apps/lambda_manager serverless/pytorch/rfdetr/indoor-v3
```

- [x] **Step 6: Review scope and leave integration gated**

```bash
git status --short
git diff --check
git diff --stat develop...HEAD
```

Expected: only approved design, Indoor package, metadata plumbing, mapping, postprocessor, and tests are changed. Commit, merge, push, and deployment remain separate user-authorized actions.

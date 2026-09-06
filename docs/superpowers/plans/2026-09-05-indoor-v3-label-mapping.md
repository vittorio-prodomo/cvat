# Indoor v3 Label Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically map Indoor v3 model codes to uniquely prefixed Project 40 labels, add a generic `crack` label to Project 40 without changing annotations, and prepare a verified UI candidate.

**Architecture:** Keep the detector manifest truthful and unchanged. Extract CVAT's label auto-mapping into a pure helper that performs compatible exact matching first and a narrowly scoped `C<digits>_` fallback second; mutate Project 40 through `ProjectWriteSerializer` only after an exact live-schema preflight and record reversible before/after evidence.

**Tech Stack:** React 18, TypeScript 5.8, CVAT UI, Node.js test runner, Django REST Framework serializers, PostgreSQL through CVAT's ORM, Docker Compose.

---

## Scope and delivery boundaries

- Indoor v3 keeps model labels `C1`, `C5` through `C13`, and `crack`.
- The UI should initially map `C1`, `C5` through `C12` to the unique Project 40 labels beginning with the same code and `_`.
- `crack` maps by the existing exact-name rule after the schema addition.
- Model-only `C13` and project-only `C2_effloresc` remain visibly unmapped.
- An ambiguous prefix, an incompatible shape type, or a non-code model label never uses the fallback.
- Manual mappings remain authoritative because this change only computes `defaultMapping` when the mapper opens.
- There is no Indoor v3 image build or Nuclio redeployment.
- Project 40 annotation counts must remain identical across the schema update.
- Build and verification may proceed without deployment. Replacing `cvat_ui`, mutating Project 40, committing, pushing, or merging each require the corresponding explicit authorization.

## File map

- Create: `cvat-ui/src/components/model-runner-modal/labels-auto-mapping.ts` — pure compatibility and default-mapping policy.
- Modify: `cvat-ui/src/components/model-runner-modal/labels-mapper.tsx` — import and use the pure helper.
- Create: `tests/unit/labels-auto-mapping.cjs` — focused Node tests for exact and code-prefix behavior.
- Create at execution time under ignored deployment evidence: `data/deployments/indoor-v3-label-mapping/project40-schema.py` — guarded serializer mutation and receipt generator.
- Create at execution time under ignored deployment evidence: `data/deployments/indoor-v3-label-mapping/*.json` — baseline, candidate, mutation, and verification receipts.

### Task 1: Prepare the shared isolated implementation baseline

**Files:**
- Inspect: `data/deployments/ui-pending-batch-20260904/deployment-receipt.json`
- Inspect: `data/deployments/account-session-fixes/inherited-source-manifest.json`
- Populate: `/data/cvat/.worktrees/sam3-concept-indoor-mapping/`

- [ ] **Step 1: Verify the integration base and both source worktrees are unchanged from their deployment receipts**

Run:

```bash
cd /data/cvat
test "$(git rev-parse develop)" = "1ba5b66b1b5a5d7d7f28a0137c99948ae0e2f94e"
test "$(git -C .worktrees/account-session-fixes rev-parse HEAD)" = "1ba5b66b1b5a5d7d7f28a0137c99948ae0e2f94e"
sha256sum -c <(python3 - <<'PY'
import json
from pathlib import Path
root = Path('/data/cvat/.worktrees/account-session-fixes')
manifest = json.loads(Path('/data/cvat/data/deployments/account-session-fixes/inherited-source-manifest.json').read_text())
for relative, digest in manifest.items():
    print(digest, root / relative)
PY
)
```

Expected: both `test` commands exit zero and every manifest entry prints `OK`. If any entry differs, stop; rebuilding from an unverified aggregate could remove a live fix.

- [ ] **Step 2: Create or validate the shared feature worktree**

Run:

```bash
cd /data/cvat
if [ ! -d .worktrees/sam3-concept-indoor-mapping ]; then
    git worktree add -b feat/sam3-concept-indoor-mapping .worktrees/sam3-concept-indoor-mapping develop
fi
test "$(git -C .worktrees/sam3-concept-indoor-mapping branch --show-current)" = "feat/sam3-concept-indoor-mapping"
test "$(git -C .worktrees/sam3-concept-indoor-mapping rev-parse HEAD)" = "1ba5b66b1b5a5d7d7f28a0137c99948ae0e2f94e"
```

Expected: the worktree exists on `feat/sam3-concept-indoor-mapping` at the recorded integration base.

- [ ] **Step 3: Seed the worktree with the exact deployed aggregate UI source**

Run:

```bash
cd /data/cvat
rsync -a --delete .worktrees/account-session-fixes/cvat-ui/ .worktrees/sam3-concept-indoor-mapping/cvat-ui/
rsync -a --delete .worktrees/account-session-fixes/cvat-canvas/ .worktrees/sam3-concept-indoor-mapping/cvat-canvas/
mkdir -p .worktrees/sam3-concept-indoor-mapping/tests/unit
rsync -a --delete .worktrees/account-session-fixes/tests/unit/ .worktrees/sam3-concept-indoor-mapping/tests/unit/
if [ ! -e .worktrees/sam3-concept-indoor-mapping/node_modules ]; then
    ln -s /data/cvat/node_modules .worktrees/sam3-concept-indoor-mapping/node_modules
fi
test "$(readlink -f .worktrees/sam3-concept-indoor-mapping/node_modules)" = "/data/cvat/node_modules"
```

Expected: `node_modules` resolves to `/data/cvat/node_modules`; `sha256sum` for each file in `inherited-source-manifest.json` matches the account-session source. If the symlink already exists, accept `ln` reporting `File exists` only after `readlink -f` confirms `/data/cvat/node_modules`.

- [ ] **Step 4: Record the baseline rather than treating inherited changes as new work**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping
mkdir -p /data/cvat/data/deployments/indoor-v3-label-mapping
git status --short > /data/cvat/data/deployments/indoor-v3-label-mapping/inherited-status.txt
sha256sum cvat-ui/src/components/model-runner-modal/labels-mapper.tsx \
    > /data/cvat/data/deployments/indoor-v3-label-mapping/baseline-source.sha256
```

Expected: the receipt captures the inherited uncommitted aggregate and the unchanged label mapper. No production state changes.

### Task 2: Extract and test the default-mapping policy

**Files:**
- Create: `cvat-ui/src/components/model-runner-modal/labels-auto-mapping.ts`
- Create: `tests/unit/labels-auto-mapping.cjs`
- Modify: `cvat-ui/src/components/model-runner-modal/labels-mapper.tsx:9-67`

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/labels-auto-mapping.cjs` with:

```javascript
// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const filename = path.join(root, 'cvat-ui/src/components/model-runner-modal/labels-auto-mapping.ts');
const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const mod = { exports: {} };
vm.compileFunction(output, ['require', 'module', 'exports'], { filename })(
    (name) => {
        if (name === 'cvat-core-wrapper') {
            return { LabelType: { ANY: 'any', MASK: 'mask', POLYGON: 'polygon', SKELETON: 'skeleton' } };
        }
        throw new Error(`Unexpected dependency: ${name}`);
    },
    mod,
    mod.exports,
);
const { computeLabelsAutoMapping } = mod.exports;
const label = (name, type = 'mask') => ({ name, type });
const names = (mapping) => mapping.map(([model, task]) => [model.name, task.name]);

test('exact matching has precedence over a compatible prefixed candidate', () => {
    assert.deepEqual(names(computeLabelsAutoMapping(
        [label('C1')], [label('C1_suffix'), label('C1')],
    )), [['C1', 'C1']]);
});

test('unique numeric code prefixes map only at an underscore boundary', () => {
    assert.deepEqual(names(computeLabelsAutoMapping(
        [label('C1'), label('C10')], [label('C10_long'), label('C1_exec')],
    )), [['C1', 'C1_exec'], ['C10', 'C10_long']]);
});

test('ambiguous, incompatible, and arbitrary prefixes remain unmapped', () => {
    assert.deepEqual(names(computeLabelsAutoMapping(
        [label('C5'), label('C6'), label('crack')],
        [label('C5_a'), label('C5_b'), label('C6_surface', 'skeleton'), label('crack_family')],
    )), []);
});

test('Indoor v3 maps the approved Project 40 pairs and leaves C13 and C2 unmatched', () => {
    const model = ['C1', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13', 'crack'].map(label);
    const project = [
        'C1_difet_esec', 'C2_effloresc', 'C5_infiltr_cls', 'C6_superf_bagnata',
        'C7_ammalor_cls', 'C8_venat_ruggine', 'C9_corros_staffe', 'C10_corros_arm_long',
        'C11_sfogl_staffe', 'C12_sfogl_arm_long', 'C16_crack_vert', 'C17_crack_diag',
        'C18_crack_long', 'C19_crack_trasv', 'crack',
    ].map((name) => label(name, 'any'));
    assert.deepEqual(names(computeLabelsAutoMapping(model, project)), [
        ['C1', 'C1_difet_esec'], ['C5', 'C5_infiltr_cls'], ['C6', 'C6_superf_bagnata'],
        ['C7', 'C7_ammalor_cls'], ['C8', 'C8_venat_ruggine'], ['C9', 'C9_corros_staffe'],
        ['C10', 'C10_corros_arm_long'], ['C11', 'C11_sfogl_staffe'],
        ['C12', 'C12_sfogl_arm_long'], ['crack', 'crack'],
    ]);
});
```

- [ ] **Step 2: Run the test to verify it fails because the helper does not exist**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping
node --test tests/unit/labels-auto-mapping.cjs
```

Expected: FAIL with `ENOENT` for `labels-auto-mapping.ts`.

- [ ] **Step 3: Implement the pure helper**

Create `cvat-ui/src/components/model-runner-modal/labels-auto-mapping.ts` with:

```typescript
// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT

import { LabelType } from 'cvat-core-wrapper';
import type { LabelInterface, Md2JobLabelsMapping } from './labels-mapper';

export function labelsCompatible(modelLabel: LabelInterface, jobLabel: LabelInterface): boolean {
    const compatibleTypes = [[LabelType.MASK, LabelType.POLYGON]];
    return modelLabel.type === jobLabel.type ||
        (jobLabel.type === LabelType.ANY && modelLabel.type !== LabelType.SKELETON) ||
        (modelLabel.type === LabelType.ANY && jobLabel.type !== LabelType.SKELETON) ||
        compatibleTypes.some((compatible) => (
            compatible.includes(jobLabel.type) && compatible.includes(modelLabel.type)
        ));
}

export function computeLabelsAutoMapping(
    modelLabels: LabelInterface[],
    taskLabels: LabelInterface[],
): Md2JobLabelsMapping {
    return modelLabels.reduce<Md2JobLabelsMapping>((mapping, modelLabel) => {
        const exact = taskLabels.find((taskLabel) => (
            modelLabel.name === taskLabel.name && labelsCompatible(modelLabel, taskLabel)
        ));
        if (exact) return [...mapping, [modelLabel, exact]];
        if (!/^C\d+$/.test(modelLabel.name)) return mapping;

        const prefix = `${modelLabel.name}_`;
        const candidates = taskLabels.filter((taskLabel) => (
            taskLabel.name.startsWith(prefix) && labelsCompatible(modelLabel, taskLabel)
        ));
        return candidates.length === 1 ? [...mapping, [modelLabel, candidates[0]]] : mapping;
    }, []);
}
```

In `labels-mapper.tsx`, add:

```typescript
import { computeLabelsAutoMapping, labelsCompatible } from './labels-auto-mapping';
```

Then delete the local `labelsCompatible` and `computeLabelsAutoMapping` function bodies at current lines 29–60. Keep the existing calls unchanged.

- [ ] **Step 4: Run the focused test**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping
node --test tests/unit/labels-auto-mapping.cjs
```

Expected: 4 tests pass, 0 fail.

- [ ] **Step 5: Run mapper-adjacent static checks**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping
/data/cvat/node_modules/.bin/eslint cvat-ui/src/components/model-runner-modal/labels-auto-mapping.ts \
    cvat-ui/src/components/model-runner-modal/labels-mapper.tsx \
    tests/unit/labels-auto-mapping.cjs
/data/cvat/node_modules/.bin/tsc -p cvat-ui/tsconfig.json
```

Expected: both commands exit zero.

- [ ] **Step 6: Stop at the commit boundary unless the user explicitly authorizes a commit**

After authorization, run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping
git add cvat-ui/src/components/model-runner-modal/labels-auto-mapping.ts \
    cvat-ui/src/components/model-runner-modal/labels-mapper.tsx \
    tests/unit/labels-auto-mapping.cjs
git commit -m "feat(ui): map unique coded detector labels"
```

Expected: one commit containing only the mapping helper, integration, and focused test. Without authorization, retain the verified worktree changes uncommitted.

### Task 3: Add a guarded Project 40 schema mutation utility

**Files:**
- Create: `data/deployments/indoor-v3-label-mapping/project40-schema.py`
- Create: `data/deployments/indoor-v3-label-mapping/project40-before.json`
- Create: `data/deployments/indoor-v3-label-mapping/project40-after.json`

- [ ] **Step 1: Write the mutation utility with dry-run as its default**

Create the ignored evidence script with the following logic:

```python
import argparse
import json
from pathlib import Path

import django

django.setup()

from django.db import transaction
from cvat.apps.engine.models import LabeledImage, LabeledShape, LabeledTrack, Project
from cvat.apps.engine.serializers import ProjectWriteSerializer

PROJECT_ID = 40
EXPECTED_NAME = 'Indoor DOMUS Re-annotation'
EXPECTED_CODES = {
    'C1_difet_esec', 'C2_effloresc', 'C5_infiltr_cls', 'C6_superf_bagnata',
    'C7_ammalor_cls', 'C8_venat_ruggine', 'C9_corros_staffe', 'C10_corros_arm_long',
    'C11_sfogl_staffe', 'C12_sfogl_arm_long', 'C16_crack_vert', 'C17_crack_diag',
    'C18_crack_long', 'C19_crack_trasv', 'NR_non_rilev', 'nessun_difetto', 'HN_hard_neg',
}
CRACK = {
    'name': 'crack',
    'color': '#e53935',
    'type': 'any',
    'attributes': [
        {
            'name': 'confidence', 'mutable': True, 'input_type': 'select',
            'default_value': 'high', 'values': ['low', 'medium', 'high'],
        },
        {
            'name': 'model_confidence', 'mutable': False, 'input_type': 'text',
            'default_value': '', 'values': [''],
        },
    ],
}

def annotation_counts(project):
    tasks = project.tasks.values_list('id', flat=True)
    return {
        'tags': LabeledImage.objects.filter(job__segment__task_id__in=tasks).count(),
        'shapes': LabeledShape.objects.filter(job__segment__task_id__in=tasks).count(),
        'tracks': LabeledTrack.objects.filter(job__segment__task_id__in=tasks).count(),
    }

def snapshot(project):
    labels = []
    for label in project.get_labels(prefetch=True).filter(parent__isnull=True).order_by('id'):
        labels.append({
            'id': label.id, 'name': label.name, 'type': label.type, 'color': label.color,
            'attributes': [{
                'id': attr.id, 'name': attr.name, 'mutable': attr.mutable,
                'input_type': attr.input_type, 'default_value': attr.default_value,
                'values': attr.values.split('\n'),
            } for attr in label.attributespec_set.all().order_by('id')],
        })
    return {
        'project': {'id': project.id, 'name': project.name, 'task_count': project.tasks.count()},
        'labels': labels,
        'annotation_counts': annotation_counts(project),
    }

def assert_crack_schema(snapshot_data):
    crack = next(label for label in snapshot_data['labels'] if label['name'] == 'crack')
    assert {key: crack[key] for key in ('name', 'color', 'type')} == {
        'name': 'crack', 'color': '#e53935', 'type': 'any',
    }
    attributes = [{
        key: attr[key] for key in ('name', 'mutable', 'input_type', 'default_value', 'values')
    } for attr in crack['attributes']]
    assert attributes == CRACK['attributes']

parser = argparse.ArgumentParser()
mode = parser.add_mutually_exclusive_group()
mode.add_argument('--probe', action='store_true')
mode.add_argument('--apply', action='store_true')
parser.add_argument('--receipt', required=True)
args = parser.parse_args()
receipt = Path(args.receipt)

with transaction.atomic():
    project = Project.objects.select_for_update().get(pk=PROJECT_ID)
    before = snapshot(project)
    names = {label['name'] for label in before['labels']}
    assert project.name == EXPECTED_NAME
    assert project.tasks.count() == 32
    assert names in (EXPECTED_CODES, EXPECTED_CODES | {'crack'})

    mutate = args.probe or args.apply
    if mutate and 'crack' not in names:
        serializer = ProjectWriteSerializer(project, data={'labels': [CRACK]}, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        project.refresh_from_db()

    after = snapshot(project)
    assert before['annotation_counts'] == after['annotation_counts']
    if mutate:
        assert {label['name'] for label in after['labels']} == EXPECTED_CODES | {'crack'}
        assert_crack_schema(after)
    elif 'crack' in names:
        assert_crack_schema(after)
    receipt.write_text(json.dumps({
        'mode': 'apply' if args.apply else ('probe' if args.probe else 'dry-run'),
        'committed': args.apply,
        'before': before,
        'after': after,
    }, indent=2) + '\n')
    if not args.apply:
        transaction.set_rollback(True)
```

- [ ] **Step 2: Run the dry-run inside `cvat_server`**

Run:

```bash
cd /data/cvat
docker cp data/deployments/indoor-v3-label-mapping/project40-schema.py \
    cvat_server:/tmp/project40-schema.py
docker exec -e DJANGO_SETTINGS_MODULE=cvat.settings.production cvat_server \
    python /tmp/project40-schema.py --receipt /tmp/project40-dry-run.json
docker cp cvat_server:/tmp/project40-dry-run.json \
    data/deployments/indoor-v3-label-mapping/project40-before.json
```

Expected: the receipt says `mode: dry-run` and `committed: false`, project id/name/task count match, there is no `crack` label, and annotation counts are present. If `crack` already exists, treat the mutation as idempotently complete only if its complete schema equals `CRACK`.

- [ ] **Step 3: Test the serializer path inside a rolled-back transaction**

Run:

```bash
cd /data/cvat
docker exec -e DJANGO_SETTINGS_MODULE=cvat.settings.production cvat_server \
    python /tmp/project40-schema.py --probe --receipt /tmp/project40-rollback-probe.json
docker cp cvat_server:/tmp/project40-rollback-probe.json \
    data/deployments/indoor-v3-label-mapping/project40-rollback-probe.json
docker exec -e DJANGO_SETTINGS_MODULE=cvat.settings.production cvat_server \
    python /tmp/project40-schema.py --receipt /tmp/project40-after-probe.json
docker cp cvat_server:/tmp/project40-after-probe.json \
    data/deployments/indoor-v3-label-mapping/project40-after-probe.json
```

Expected: the in-transaction `after` snapshot contains exactly one new `crack` label with both attributes; a fresh dry-run after the process exits still reports no `crack`; annotation counts are unchanged.

### Task 4: Verify the combined UI candidate before any production change

**Files:**
- Read: `cvat-ui/src/components/model-runner-modal/labels-auto-mapping.ts`
- Read: `cvat-ui/src/components/model-runner-modal/labels-mapper.tsx`
- Create: `data/deployments/indoor-v3-label-mapping/candidate-receipt.json`

- [ ] **Step 1: Run focused and inherited UI tests**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping
node --test tests/unit/labels-auto-mapping.cjs
node --test tests/unit/interactor-text-prompts.cjs
node --test tests/unit/interactor-text-refinement.cjs
node --test tests/unit/interactor-mask-morphology.cjs
node --test tests/unit/primary-action-enter.cjs
/data/cvat/node_modules/.bin/tsc -p cvat-ui/tsconfig.json
/data/cvat/node_modules/.bin/eslint cvat-ui/src/components/model-runner-modal/labels-auto-mapping.ts \
    cvat-ui/src/components/model-runner-modal/labels-mapper.tsx
(cd cvat-ui && /data/cvat/node_modules/.bin/webpack --config ./webpack.config.js)
```

Expected: all focused and inherited tests pass; type-check, ESLint, and production build exit zero. Existing bundle-size warnings are acceptable; new errors are not.

- [ ] **Step 2: Build an immutable UI candidate without replacing `cvat_ui`**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping
docker build -f Dockerfile.ui -t cvat/ui:sam3-concept-indoor-mapping-20260905 .
docker image inspect cvat/ui:sam3-concept-indoor-mapping-20260905 \
    --format '{{.Id}}' > /data/cvat/data/deployments/indoor-v3-label-mapping/ui-image-id.txt
```

Expected: the image builds successfully and the receipt contains a `sha256:` image ID. The running `cvat_ui` container ID is unchanged.

- [ ] **Step 3: Browser-test mapping using real model/project metadata against the candidate bundle**

Use the existing Playwright/browser harness and read-only API fixtures to open the Indoor v3 mapper for Project 40. Assert these initial rows:

```text
C1  -> C1_difet_esec
C5  -> C5_infiltr_cls
C6  -> C6_superf_bagnata
C7  -> C7_ammalor_cls
C8  -> C8_venat_ruggine
C9  -> C9_corros_staffe
C10 -> C10_corros_arm_long
C11 -> C11_sfogl_staffe
C12 -> C12_sfogl_arm_long
C13 -> unmapped
crack -> unmapped before the schema mutation
```

Expected: all assertions pass; changing one mapping manually leaves it unchanged while the modal remains open; no detector call and no annotation write occurs.

- [ ] **Step 4: Write the candidate receipt**

Record the branch, base SHA, inherited UI receipt, changed-file SHA-256 values, unit/static/build results, candidate image ID, mapping table, browser-console errors, running container IDs, and these explicit facts:

```json
{
  "indoor_v3_function_changed": false,
  "project40_changed": false,
  "annotation_writes": 0,
  "deployment_authorized": false
}
```

Expected: `data/deployments/indoor-v3-label-mapping/candidate-receipt.json` is valid JSON and references only artifacts that exist.

### Task 5: Apply the Project 40 schema addition after explicit mutation authorization

**Files:**
- Use: `data/deployments/indoor-v3-label-mapping/project40-schema.py`
- Create: `data/deployments/indoor-v3-label-mapping/project40-after.json`

- [ ] **Step 1: Stop and request explicit authorization for the Project 40 mutation**

Present the dry-run receipt, exact label payload, and unchanged annotation counts. Explain that this step writes one label and two attribute specs to production Project 40 and touches child task/job timestamps through the normal serializer.

- [ ] **Step 2: Apply the idempotent serializer mutation after authorization**

Run:

```bash
cd /data/cvat
docker cp data/deployments/indoor-v3-label-mapping/project40-schema.py \
    cvat_server:/tmp/project40-schema.py
docker exec -e DJANGO_SETTINGS_MODULE=cvat.settings.production cvat_server \
    python /tmp/project40-schema.py --apply --receipt /tmp/project40-after.json
docker cp cvat_server:/tmp/project40-after.json \
    data/deployments/indoor-v3-label-mapping/project40-after.json
```

Expected: Project 40 contains exactly one `crack` label with type `any`, color `#e53935`, mutable `confidence`, and immutable `model_confidence`; all before/after annotation counts match.

- [ ] **Step 3: Verify the schema through the public API and browser**

Expected browser mapping after a hard reload:

```text
C1, C5-C12 -> their unique prefixed labels
crack -> crack
C13 -> unmapped
C2_effloresc -> unused project label
```

Expected: all 32 project tasks expose the project label; existing shape/tag/track counts are unchanged; no Indoor v3 function/container ID changes.

- [ ] **Step 4: Record rollback information**

The rollback is a guarded label deletion through CVAT's label API/serializer using the newly recorded label ID. Do not execute it unless requested. Record that deleting the label is safe only while its annotation reference count remains zero; if annotators have used it, migration or relabeling is required before deletion.

### Task 6: Deploy the shared UI candidate after explicit deployment authorization

**Files:**
- Use: `data/deployments/indoor-v3-label-mapping/candidate-receipt.json`
- Create: `data/deployments/indoor-v3-label-mapping/deployment-receipt.json`

- [ ] **Step 1: Stop and request explicit authorization to replace `cvat_ui`**

Present the candidate and rollback image IDs. State that only `cvat_ui` will be replaced and Indoor v3 will not be rebuilt or restarted.

- [ ] **Step 2: Preserve rollback and replace only the UI after authorization**

Use all four CVAT Compose files plus the active email-relay Compose file:

```bash
cd /data/cvat
docker tag cvat/ui:dev cvat/ui:rollback-before-sam3-concept-indoor-mapping-20260905
docker tag cvat/ui:sam3-concept-indoor-mapping-20260905 cvat/ui:dev
docker compose --project-directory /data/cvat --env-file /data/cvat/.env \
    -f /data/cvat/docker-compose.yml \
    -f /data/cvat/docker-compose.no-traefik.yml \
    -f /data/cvat/docker-compose.override.yml \
    -f /data/cvat/components/serverless/docker-compose.serverless.yml \
    -f /data/cvat/.worktrees/cvat-postmark-relay/docker-compose.email-relay.yml \
    up -d --no-deps cvat_ui
```

Expected: only the `cvat_ui` container ID changes.

- [ ] **Step 3: Probe the deployed static assets and behavior**

Verify local and public login pages return HTTP 200, their referenced main JS bundle has the candidate SHA-256, `favicon.ico` is HTTP 200, `/api/server/about` is HTTP 200, and the Indoor v3 mapper has the exact expected default rows after a hard reload.

Expected: no browser console errors, no annotation writes, and all non-UI service/container IDs match the preflight receipt.

- [ ] **Step 4: Write the deployment receipt**

Record authorization text, timestamps, candidate and rollback image IDs, old/new `cvat_ui` IDs, unchanged container IDs, local/public bundle hashes, Project 40 before/after label IDs and annotation counts, and the explicit fact that Indoor v3 was not deployed.

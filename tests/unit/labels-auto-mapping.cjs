// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

// Run with: node tests/unit/labels-auto-mapping.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const LabelType = {
    ANY: 'any',
    MASK: 'mask',
    POLYGON: 'polygon',
    RECTANGLE: 'rectangle',
    SKELETON: 'skeleton',
    TAG: 'tag',
};

function loadAutoMapping() {
    const filename = path.join(
        root,
        'cvat-ui/src/components/model-runner-modal/labels-auto-mapping.ts',
    );
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        fileName: filename,
        compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
        },
    });
    const mod = { exports: {} };
    vm.compileFunction(outputText, ['require', 'module', 'exports'], { filename })(
        (name) => {
            if (name === 'cvat-core-wrapper') return { LabelType };
            throw new Error(`Unexpected dependency: ${name}`);
        },
        mod,
        mod.exports,
    );
    return mod.exports;
}

const { computeLabelsAutoMapping, labelsCompatible } = loadAutoMapping();
const label = (id, name, type = LabelType.RECTANGLE) => ({ id, name, type });
const ids = (mapping) => mapping.map(([modelLabel, taskLabel]) => [modelLabel.id, taskLabel.id]);

test('exact compatible names take precedence over code-prefix fallback candidates', () => {
    const model = label('model-C1', 'C1');
    const exact = label('task-C1', 'C1');
    const fallback = label('task-C1-long', 'C1_difet_esec');

    const mapping = computeLabelsAutoMapping([model], [fallback, exact]);

    assert.deepEqual(ids(mapping), [['model-C1', 'task-C1']]);
    assert.equal(mapping[0][0], model);
    assert.equal(mapping[0][1], exact);
});

test('a C<number> label maps to its one compatible underscored task label', () => {
    const model = label('model-C5', 'C5', LabelType.MASK);
    const task = label('task-C5', 'C5_infiltr_cls', LabelType.POLYGON);

    assert.equal(labelsCompatible(model, task), true);
    assert.deepEqual(ids(computeLabelsAutoMapping([model], [task])), [['model-C5', 'task-C5']]);
});

test('code-prefix fallback is boundary safe for C1 versus C10', () => {
    const model = label('model-C1', 'C1');
    const c10 = label('task-C10', 'C10_corros_arm_long');
    const c1 = label('task-C1', 'C1_difet_esec');

    assert.deepEqual(ids(computeLabelsAutoMapping([model], [c10, c1])), [['model-C1', 'task-C1']]);
    assert.deepEqual(computeLabelsAutoMapping([model], [c10]), []);
});

test('multiple compatible fallback candidates are ambiguous and remain unmapped', () => {
    const model = label('model-C8', 'C8');
    const first = label('task-C8-a', 'C8_first');
    const second = label('task-C8-b', 'C8_second');

    assert.deepEqual(computeLabelsAutoMapping([model], [first, second]), []);
});

test('incompatible candidates neither map nor make a unique compatible fallback ambiguous', () => {
    const model = label('model-C9', 'C9', LabelType.RECTANGLE);
    const compatible = label('task-C9-shape', 'C9_corros_staffe', LabelType.ANY);
    const incompatible = label('task-C9-tag', 'C9_review_tag', LabelType.TAG);

    assert.equal(labelsCompatible(model, incompatible), false);
    assert.deepEqual(
        ids(computeLabelsAutoMapping([model], [incompatible, compatible])),
        [['model-C9', 'task-C9-shape']],
    );
});

test('non-code model labels remain exact-only', () => {
    const crack = label('model-crack', 'crack');
    const prefixed = label('task-crack', 'crack_vertical');
    const exact = label('task-crack-exact', 'crack');

    assert.deepEqual(computeLabelsAutoMapping([crack], [prefixed]), []);
    assert.deepEqual(
        ids(computeLabelsAutoMapping([crack], [prefixed, exact])),
        [['model-crack', 'task-crack-exact']],
    );
});

test('codes with no exact or unique compatible candidate remain unmapped', () => {
    const models = [label('model-C2', 'C2'), label('model-C13', 'C13')];
    const tasks = [label('task-C20', 'C20_other'), label('task-C13-tag', 'C13_note', LabelType.TAG)];

    assert.deepEqual(computeLabelsAutoMapping(models, tasks), []);
});

test('mapping retains source order, tuple shape, and original objects with their IDs', () => {
    const models = [label(101, 'C5'), label(102, 'crack'), label(103, 'C1')];
    const tasks = [
        label(201, 'C1_difet_esec'),
        label(202, 'crack'),
        label(203, 'C5_infiltr_cls'),
    ];

    const mapping = computeLabelsAutoMapping(models, tasks);

    assert.deepEqual(ids(mapping), [[101, 203], [102, 202], [103, 201]]);
    assert.ok(mapping.every((pair) => Array.isArray(pair) && pair.length === 2));
    assert.equal(mapping[0][0], models[0]);
    assert.equal(mapping[0][1], tasks[2]);
});

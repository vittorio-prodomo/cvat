// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
// Run with: node --test tests/unit/detector-result-adapter.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const sourceFile = path.resolve(
    __dirname,
    '../../cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/detector-result-adapter.ts',
);

class FakeObjectState {
    constructor(data) {
        Object.assign(this, data);
    }
}

function loadAdapter() {
    assert.ok(fs.existsSync(sourceFile), 'detector result adapter source must exist');
    const output = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
        fileName: sourceFile,
        compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
        },
    }).outputText;
    const mod = { exports: {} };
    const dependencies = {
        'cvat-core-wrapper': {
            getCore: () => ({ classes: { ObjectState: FakeObjectState } }),
            ObjectType: { TAG: 'tag', SHAPE: 'shape' },
        },
    };
    vm.compileFunction(output, ['require', 'module', 'exports'], { filename: sourceFile })(
        (name) => {
            if (dependencies[name]) return dependencies[name];
            throw new Error(`Unexpected module: ${name}`);
        },
        mod,
        mod.exports,
    );
    return mod.exports;
}

function labels() {
    return [{
        id: 7,
        name: 'damage',
        type: 'mask',
        attributes: [
            { id: 70, name: 'model_confidence' },
            { id: 71, name: 'severity' },
        ],
        structure: {
            sublabels: [{ id: 8, name: 'part', type: 'points', attributes: [{ id: 80, name: 'kind' }] }],
        },
    }];
}

function serializedShape(overrides = {}) {
    return {
        label_id: 7,
        frame: 2,
        group: 0,
        source: 'auto',
        type: 'mask',
        points: [0, 4, 10, 10, 11, 11],
        rotation: 12,
        score: 0.9,
        occluded: false,
        outside: false,
        z_order: 3,
        attributes: [{ spec_id: 70, value: '0.9000' }],
        elements: [],
        ...overrides,
    };
}

test('normalizes mapped shapes without inventing missing scores', () => {
    const { normalizeDetectorShapes } = loadAdapter();
    const input = [serializedShape(), serializedShape({ score: undefined, type: 'polygon', points: [1, 1, 2, 1, 2, 2] })];

    const normalized = normalizeDetectorShapes(input, labels());

    assert.equal(normalized[0].sourceIndex, 0);
    assert.equal(normalized[0].targetLabelType, 'mask');
    assert.equal(normalized[0].confidenceAttributeSpecID, 70);
    assert.equal(normalized[0].score, 0.9);
    assert.equal(Object.hasOwn(normalized[1], 'score'), false);
    assert.notEqual(normalized[0], input[0]);
    assert.deepEqual(input[0].attributes, [{ spec_id: 70, value: '0.9000' }]);
});

test('fails clearly when a detector result references an unmapped label', () => {
    const { normalizeDetectorShapes } = loadAdapter();

    assert.throws(
        () => normalizeDetectorShapes([serializedShape({ label_id: 999 })], labels()),
        /mapped label 999.*not found/i,
    );
});

test('maps every temporary shape through the canvas put-shapes payload', () => {
    const { normalizeDetectorShapes, toTemporaryCanvasShapes } = loadAdapter();
    const normalized = normalizeDetectorShapes([
        serializedShape({ type: 'rectangle', points: [1, 2, 3, 4], rotation: 17 }),
        serializedShape({ type: 'points', points: [5, 6], rotation: undefined }),
    ], labels());

    assert.deepEqual(toTemporaryCanvasShapes(normalized), [
        { shapeType: 'rectangle', points: [1, 2, 3, 4], rotation: 17 },
        { shapeType: 'points', points: [5, 6], rotation: undefined },
    ]);
});

test('constructs shapes and pass-through tags with mapped data and native scores', () => {
    const { normalizeDetectorShapes, toObjectStates } = loadAdapter();
    const [shape] = normalizeDetectorShapes([serializedShape({
        elements: [{
            label_id: 8,
            frame: 2,
            group: 0,
            source: 'semi-auto',
            type: 'points',
            points: [4, 5],
            rotation: 0,
            occluded: true,
            outside: false,
            z_order: 0,
            attributes: [{ spec_id: 80, value: 'tip' }],
        }],
    })], labels());
    const tags = [{
        label_id: 7,
        frame: 2,
        group: 0,
        source: 'auto',
        attributes: [{ spec_id: 71, value: 'high' }],
    }];

    const states = toObjectStates({ tags, shapes: [shape] }, { labels: labels(), frame: 5, zOrder: 9 });

    assert.equal(states.length, 2);
    assert.deepEqual({ ...states[0] }, {
        attributes: { 71: 'high' },
        frame: 5,
        label: labels()[0],
        objectType: 'tag',
        source: 'auto',
    });
    assert.equal(states[1].objectType, 'shape');
    assert.equal(states[1].shapeType, 'mask');
    assert.equal(states[1].score, 0.9);
    assert.equal(states[1].rotation, 12);
    assert.equal(states[1].zOrder, 9);
    assert.equal(states[1].source, 'auto');
    assert.deepEqual(states[1].attributes, { 70: '0.9000' });
    assert.deepEqual({ ...states[1].elements[0] }, {
        attributes: { 80: 'tip' },
        frame: 5,
        label: labels()[0].structure.sublabels[0],
        objectType: 'shape',
        occluded: true,
        outside: false,
        points: [4, 5],
        rotation: 0,
        shapeType: 'points',
        source: 'semi-auto',
    });
});

test('fails clearly when a detector skeleton element references an unknown sublabel', () => {
    const { normalizeDetectorShapes, toObjectStates } = loadAdapter();
    const [shape] = normalizeDetectorShapes([
        serializedShape({ elements: [serializedShape({ label_id: 999, type: 'points', points: [1, 2] })] }),
    ], labels());

    assert.throws(
        () => toObjectStates({ tags: [], shapes: [shape] }, { labels: labels(), frame: 5, zOrder: 0 }),
        /mapped sublabel 999.*not found/i,
    );
});

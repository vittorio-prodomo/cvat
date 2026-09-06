// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
// Run with: node tests/unit/annotations-collection-score.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');

// Load the real cvat-core TypeScript modules through CommonJS so this regression
// exercises ObjectState -> Collection.put -> Shape -> Collection.export directly.
require.extensions['.ts'] = (module, filename) => {
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        fileName: filename,
        compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
        },
    }).outputText;
    module._compile(output, filename);
};

const Collection = require(path.join(root, 'cvat-core/src/annotations-collection.ts')).default;
const AnnotationHistory = require(path.join(root, 'cvat-core/src/annotations-history.ts')).default;
const ObjectState = require(path.join(root, 'cvat-core/src/object-state.ts')).default;
const { Label } = require(path.join(root, 'cvat-core/src/labels.ts'));
const {
    DimensionType, JobType, LabelType, ObjectType, ShapeType, Source,
} = require(path.join(root, 'cvat-core/src/enums.ts'));

function makeCollectionAndLabel() {
    const label = new Label({
        id: 7,
        name: 'damage',
        color: '#ff0000',
        type: LabelType.RECTANGLE,
        attributes: [],
    });
    const framesInfo = {
        0: { width: 20, height: 20 },
        isFrameDeleted: () => false,
    };
    const collection = new Collection({
        labels: [label],
        history: new AnnotationHistory(),
        stopFrame: 0,
        dimension: DimensionType.DIMENSION_2D,
        framesInfo,
        jobType: JobType.ANNOTATION,
    });

    return { collection, label };
}

function makeShapeState(label, score) {
    const serialized = {
        objectType: ObjectType.SHAPE,
        shapeType: ShapeType.RECTANGLE,
        label,
        frame: 0,
        points: [0, 0, 4, 4],
        rotation: 0,
        zOrder: 0,
        occluded: false,
        outside: false,
        source: Source.AUTO,
        attributes: {},
        descriptions: [],
        elements: [],
    };
    if (score !== undefined) serialized.score = score;
    return new ObjectState(serialized);
}

test('Collection.put preserves a detector shape score through the real core model', () => {
    const { collection, label } = makeCollectionAndLabel();
    collection.put([makeShapeState(label, 0.9)]);

    assert.equal(collection.get(0, false, [])[0].score, 0.9);
    assert.equal(collection.export().shapes[0].score, 0.9);
});

test('ObjectState and Collection.put retain the native default score when omitted', () => {
    const { collection, label } = makeCollectionAndLabel();
    const state = makeShapeState(label);

    assert.equal(state.score, 1);
    collection.put([state]);
    assert.equal(collection.get(0, false, [])[0].score, 1);
    assert.equal(collection.export().shapes[0].score, 1);
});

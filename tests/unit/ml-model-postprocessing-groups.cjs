// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../../cvat-core/src/ml-model.ts');
const source = fs.readFileSync(filename, 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: filename,
}).outputText;
const loadedModule = new Module(filename, module);
loadedModule.filename = filename;
loadedModule.paths = Module._nodeModulePaths(path.dirname(filename));

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (request === './plugins') {
        return { __esModule: true, default: { apiWrapper: { call: () => undefined } } };
    }
    if (request === './enums') {
        return {
            LabelType: { ANY: 'any', MASK: 'mask', TAG: 'tag' },
            ModelKind: { DETECTOR: 'detector', REID: 'reid' },
            ModelProviders: { CVAT: 'cvat' },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
try {
    loadedModule._compile(output, filename);
} finally {
    Module._load = originalLoad;
}
const MLModel = loadedModule.exports.default;

test('returns defensive copies of postprocessing label groups', () => {
    const model = new MLModel({
        id: 'indoor-v3',
        postprocessing_label_groups: [['C5', 'C6']],
    });

    const groups = model.postprocessingLabelGroups;
    assert.deepEqual(groups, [['C5', 'C6']]);

    groups[0].push('C7');
    groups.push(['C8', 'C9']);

    assert.deepEqual(model.postprocessingLabelGroups, [['C5', 'C6']]);
});

test('defaults missing or malformed postprocessing label groups to an empty list', () => {
    assert.deepEqual(new MLModel({}).postprocessingLabelGroups, []);
    assert.deepEqual(new MLModel({ postprocessing_label_groups: null }).postprocessingLabelGroups, []);
});

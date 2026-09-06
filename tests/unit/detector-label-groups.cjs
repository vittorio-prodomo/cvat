// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const filename = path.resolve(
    __dirname,
    '../../cvat-ui/src/components/model-runner-modal/label-mapping-utils.ts',
);
const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
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
    if (request === 'cvat-core-wrapper') return {};
    return originalLoad.call(this, request, parent, isMain);
};
try {
    loadedModule._compile(output, filename);
} finally {
    Module._load = originalLoad;
}

const { resolvePostprocessingLabelGroups } = loadedModule.exports;

const modelLabel = (name) => ({ name, type: 'mask', attributes: [] });
const taskLabel = (name) => ({ name, type: 'mask', attributes: [] });
const mappingEntry = (modelName, taskName) => [
    modelLabel(modelName),
    taskLabel(taskName),
    [],
    [],
];

test('resolves model compatibility groups through renamed task labels', () => {
    assert.equal(typeof resolvePostprocessingLabelGroups, 'function');
    const groups = resolvePostprocessingLabelGroups(
        [['C5', 'C6'], ['C8', 'C9']],
        [
            mappingEntry('C5', 'C5_infiltrazione'),
            mappingEntry('C6', 'C6_umidita'),
            mappingEntry('C8', 'C8_ruggine'),
            mappingEntry('C9', 'C9_staffe'),
        ],
        [
            { id: 51, name: 'C5_infiltrazione' },
            { id: 61, name: 'C6_umidita' },
            { id: 81, name: 'C8_ruggine' },
            { id: 91, name: 'C9_staffe' },
        ],
    );

    assert.deepEqual(groups, [[51, 61], [81, 91]]);
});

test('omits groups with fewer than two distinct mapped task labels', () => {
    assert.equal(typeof resolvePostprocessingLabelGroups, 'function');
    const groups = resolvePostprocessingLabelGroups(
        [['C5', 'C6'], ['C8', 'C9']],
        [
            mappingEntry('C5', 'shared'),
            mappingEntry('C6', 'shared'),
            mappingEntry('C8', 'C8_ruggine'),
        ],
        [
            { id: 5, name: 'shared' },
            { id: 8, name: 'C8_ruggine' },
        ],
    );

    assert.deepEqual(groups, []);
    assert.deepEqual(resolvePostprocessingLabelGroups([], [], []), []);
});

test('coalesces declared families that overlap after task-label mapping', () => {
    assert.equal(typeof resolvePostprocessingLabelGroups, 'function');
    const groups = resolvePostprocessingLabelGroups(
        [['C5', 'C6'], ['C8', 'C9']],
        [
            mappingEntry('C5', 'C5_infiltrazione'),
            mappingEntry('C6', 'shared'),
            mappingEntry('C8', 'shared'),
            mappingEntry('C9', 'C9_staffe'),
        ],
        [
            { id: 51, name: 'C5_infiltrazione' },
            { id: 60, name: 'shared' },
            { id: 91, name: 'C9_staffe' },
        ],
    );

    assert.deepEqual(groups, [[51, 60, 91]]);
});

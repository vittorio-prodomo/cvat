// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function fixture() {
    const responses = [];
    const scope = { postMessage(message, transfer = []) {
        responses.push(structuredClone(message, { transfer }));
    } };
    const load = (name, dependencies = {}) => {
        const filename = path.resolve(__dirname, `../../cvat-ui/src/utils/${name}.ts`);
        const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
        }).outputText;
        const mod = { exports: {} };
        vm.runInNewContext(output, { exports: mod.exports, module: mod, require: (key) => dependencies[key],
            self: scope, Int32Array, Uint16Array, Float64Array });
        return mod.exports;
    };
    load('mask-morphology.worker', { './mask-morphology': load('mask-morphology') });
    return { scope, responses };
}

test('worker runs the real engine, transfers output, and preserves its reusable source', () => {
    const { scope, responses } = fixture();
    const source = new Int32Array([0, 1, 2, 2, 2, 2]);
    const bounds = [0, 0, 5, 5];
    scope.onmessage({ data: { id: 1, rle: source, radius: 1, bounds } });
    assert.equal(responses[0].id, 1);
    assert.deepEqual(Array.from(responses[0].rle), [1, 1, 1, 3, 1, 1, 1, 1, 1, 3, 3]);
    assert.deepEqual(source, new Int32Array([0, 1, 2, 2, 2, 2]));
    scope.onmessage({ data: { id: 2, rle: source, radius: -1, bounds } });
    assert.equal(responses[1].rle.length, 0);
    scope.onmessage({ data: { id: 3, rle: source, radius: 0, bounds } });
    assert.deepEqual(responses[2].rle, source);
});

test('worker returns a request error and remains usable for the next valid request', () => {
    const { scope, responses } = fixture();
    const source = new Int32Array([0, 1, 2, 2, 2, 2]); const bounds = [0, 0, 5, 5];
    scope.onmessage({ data: { id: 4, rle: source, radius: 21, bounds } });
    assert.equal(responses[0].id, 4);
    assert.match(responses[0].error, /integer between -20 and 20/);
    scope.onmessage({ data: { id: 5, rle: source, radius: 0, bounds } });
    assert.deepEqual(responses[1].rle, source);
});

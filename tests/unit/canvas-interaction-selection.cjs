// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const file = path.resolve(__dirname, '../../cvat-canvas/src/typescript/interactionHandler.ts');
const mod = { exports: {} };
const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
vm.compileFunction(output, ['require', 'module', 'exports'], { filename: file })(
    (name) => name === 'lodash' ? require('lodash') : name === './shared' ? {
        translateToSVG: (_, point) => point,
    } : name === './crosshair' ? class {} : {}, mod, mod.exports,
);
function canvas(shapes) {
    const selected = [];
    const handler = new mod.exports.InteractionHandlerImpl((...args) => selected.push(args), () => {},
        { on() {}, node: {} }, { offset: 10, scale: 1 }, {});
    Object.assign(handler, { enabled: true, command: 'select_shape',
        geometry: { offset: 10 }, container: { node: {} }, selectionShapes: shapes,
        onInteraction: (...args) => selected.push(args) });
    return { handler, selected };
}
// 3x3 foreground ring with one transparent center pixel.
const ring = { id: 5, shapeType: 'mask', points: [0, 4, 1, 4, 20, 30, 22, 32] };
test('selection tests mask foreground, not its bounding box, and applies canvas offset', () => {
    const { handler, selected } = canvas([ring]);
    handler.onMouseDown({ button: 0, clientX: 31.5, clientY: 41.5 });
    assert.equal(selected.length, 0, 'transparent center is not selectable');
    handler.onMouseDown({ button: 0, clientX: 30.5, clientY: 40.5 });
    assert.deepEqual(selected, [[[], false, 5]]);
});
test('a selection click does not create a prompt and right/middle clicks do not select', () => {
    const { handler, selected } = canvas([ring]);
    handler.onMouseDown({ button: 2, clientX: 30, clientY: 40 });
    handler.onMouseDown({ button: 1, clientX: 30, clientY: 40 });
    assert.equal(selected.length, 0);
});
test('overlap selects the first rendered shape; non-mask previews do not interfere', () => {
    const { handler, selected } = canvas([ring, { ...ring, id: 9 }]);
    handler.onMouseDown({ button: 0, clientX: 30, clientY: 40 });
    assert.equal(selected[0][2], 5);
});

test('point bounds use half-open ROI edges matching cropped image dimensions', () => {
    const { handler } = canvas([]);
    handler.geometry = { offset: 10, image: { width: 100, height: 100 } };
    handler.regionOfInterest = [10, 20, 30, 50];
    assert.equal(handler.isWithinInteractionBounds(20, 30), true);
    assert.equal(handler.isWithinInteractionBounds(39.9, 59.9), true);
    assert.equal(handler.isWithinInteractionBounds(40, 45), false);
    assert.equal(handler.isWithinInteractionBounds(30, 60), false);
});

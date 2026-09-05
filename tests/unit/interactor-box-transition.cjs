// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

// Run with: node tests/unit/interactor-box-transition.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');

function loadControllerModule(relativePath, dependencies) {
    const filename = path.join(root, relativePath);
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        fileName: filename,
        compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.CommonJS,
            jsx: ts.JsxEmit.React,
            esModuleInterop: true,
        },
    });
    const module = { exports: {} };
    // Rendering dependencies are inert; the real controller and prompt conversion run below.
    vm.compileFunction(outputText, ['require', 'module', 'exports', 'localStorage'], { filename })(
        (name) => dependencies[name] || {}, module, module.exports, { getItem: () => null },
    );
    return module.exports;
}

const canvasWrapper = loadControllerModule('cvat-ui/src/cvat-canvas-wrapper.ts', {});
const { ToolsControlComponent } = loadControllerModule(
    'cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx',
    {
        react: require('react'),
        lodash: require('lodash'),
        'react-redux': { connect: () => (component) => component },
        'cvat-core-wrapper': {
            getCore: () => ({ plugins: { register() {} } }),
            DimensionType: { DIMENSION_2D: '2d' },
        },
        'cvat-canvas-wrapper': canvasWrapper,
        './handle-popover-visibility': (component) => component,
    },
);

const box = { shapeType: 'rectangle', type: 'positive', points: [100, 100, 300, 300] };
const positive = { shapeType: 'points', type: 'positive', points: [150, 150] };
const negative = { shapeType: 'points', type: 'negative', points: [280, 280] };
const roi = [50, 50, 350, 350];

function createController(canvasParams, { blocked = false, regionOfInterest = null } = {}) {
    const commands = [];
    const requests = [];
    const interactor = { params: { canvas: canvasParams } };
    const component = new ToolsControlComponent({
        canvasInstance: { interact: (command) => commands.push(command) },
        isActivated: true,
        interactors: [interactor],
        trackers: [],
        labels: [{ id: 1 }],
        jobInstance: { dimension: '2d' },
        toolsBlockerState: { algorithmsLocked: blocked },
        frame: 0,
    });
    component.state.interactorRegionOfInterest = regionOfInterest;
    component.runInteractionRequest = () => requests.push(component.interaction.latestRequest);
    return { component, commands, requests };
}

function interact(component, shapes) {
    return component.interactionListener({ detail: { shapes, finished: false } });
}

test('SAM3 switches from its optional box to points and preserves the box and ROI during refinement', async () => {
    const { component, commands, requests } = createController({
        minPosVertices: 0, minNegVertices: 0, startWithBoxOptional: true,
    }, { regionOfInterest: roi });

    await interact(component, [box]);
    assert.deepEqual(commands, [{
        enabled: true, command: 'draw_points', settings: { crosshair: false, regionOfInterest: roi },
    }]);
    assert.deepEqual(requests[0].data, {
        frame: 0, obj_bbox: [[100, 100], [300, 300]], pos_points: [], neg_points: [], roi,
    });

    await interact(component, [box, positive, negative]);
    assert.deepEqual(requests[1].data, {
        frame: 0, obj_bbox: [[100, 100], [300, 300]],
        pos_points: [[150, 150]], neg_points: [[280, 280]], roi,
    });
});

test('box-only crop interactors keep accepting boxes without switching to points', async () => {
    const { component, commands, requests } = createController({
        minPosVertices: 0, minNegVertices: 0, startWithBox: true, startWithBoxOptional: false,
    });
    await interact(component, [box]);
    assert.deepEqual(commands, []);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].data.obj_bbox, [[100, 100], [300, 300]]);
});

test('required-point interactors still wait for their point after switching out of box mode', async () => {
    const { component, commands, requests } = createController({
        minPosVertices: 1, minNegVertices: 0, startWithBox: true,
    });
    await interact(component, [box]);
    assert.equal(commands[0].command, 'draw_points');
    assert.equal(requests.length, 0);
    await interact(component, [box, positive]);
    assert.equal(requests.length, 1);
});

test('point-first SAM3 interaction needs no box and does not change drawing mode', async () => {
    const { component, commands, requests } = createController({
        minPosVertices: 0, minNegVertices: 0, startWithBoxOptional: true,
    });
    await interact(component, [positive]);
    assert.deepEqual(commands, []);
    assert.deepEqual(requests[0].data.pos_points, [[150, 150]]);
});

test('blocking inference still allows the box-to-point transition and retains all postponed prompts', async () => {
    const { component, commands, requests } = createController({
        minPosVertices: 0, minNegVertices: 0, startWithBoxOptional: true,
    }, { blocked: true });
    await interact(component, [box]);
    assert.equal(commands[0]?.command, 'draw_points');
    await interact(component, [box, positive, negative]);
    assert.equal(requests.length, 0);
    assert.deepEqual(component.interaction.latestPostponedRequest.data, {
        frame: 0, obj_bbox: [[100, 100], [300, 300]],
        pos_points: [[150, 150]], neg_points: [[280, 280]],
    });
});

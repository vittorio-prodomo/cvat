// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const test = require('node:test');
const { create, core, event, textSchema } = require('./interactor-harness.cjs');

const base = [0, 25, 30, 40, 34, 44];
const grown = [0, 49, 29, 39, 35, 45];
function setup() {
    const h = create({ activated: true, schema: [{ ...textSchema, supports_mask_refinement: true }] });
    const c = h.component;
    c.interaction.id = 'morphology-session';
    c.interaction.latestResponse = [0, 1].map((index) => ({
        rle: Int32Array.from(base.map((v, i) => i >= 2 && i % 2 === 0 ? v + index * 30 : v)),
        points: [[30, 40], [34, 40], [34, 44]], contours: [[[30, 40], [34, 40], [34, 44]]],
        approximatedPoints: [[30, 40], [34, 40], [34, 44]], confidence: 0.8, labelName: null,
    }));
    c.state.interactorResponseReceived = true;
    c.initializeOpenCV = async () => {};
    c.receiveContoursFromMask = () => [[[29, 39], [35, 39], [35, 45]]];
    c.receivePointsFromMask = (contours) => contours[0];
    c.approximateResponsePoints = (points) => points;
    const calls = [];
    c.maskAdjustmentClient = { apply: async (...args) => { calls.push(args); return Int32Array.from(grown); }, dispose() {} };
    c.selectRefinementMask(0);
    return { ...h, c, calls };
}
function displayed(h, index = 0) {
    return h.commands.filter((command) => command.command === 'put_shapes').at(-1).payload.shapes.find((shape) => shape.id === index);
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('adjustment changes only preview; original SAM3 seed and point payload stay intact', async () => {
    const h = setup(); const original = h.c.interaction.latestResponse[0];
    await h.c.applyMaskAdjustment(0, 1);
    assert.equal(h.c.interaction.latestResponse[0], original);
    assert.deepEqual(Array.from(displayed(h).points), grown);
    assert.equal(h.requests.length, 0);
    await h.c.interactionListener(event([{ shapeType: 'points', type: 'positive', points: [31, 41] }]));
    assert.deepEqual(h.requests.at(-1).extraParams.refinement_mask, base);
    assert.deepEqual(h.calls[0][2], [0, 0, 300, 300]);
    assert.deepEqual(Array.from(displayed(h, 1).points), Array.from(h.c.interaction.latestResponse[1].rle));
});

test('zero restores exact current raw mask; changing radius never compounds the previous adjustment', async () => {
    const h = setup(); await h.c.applyMaskAdjustment(0, 1); await h.c.applyMaskAdjustment(0, -2);
    assert.deepEqual(Array.from(h.calls[1][0]), base);
    await h.c.applyMaskAdjustment(0, 0);
    assert.deepEqual(Array.from(displayed(h).points), base);
    assert.equal(h.calls.length, 2);
});

test('mask values survive selection changes and ROI bounds reach morphology', async () => {
    const h = setup(); h.c.state.interactorRegionOfInterest = [10, 20, 200, 220];
    await h.c.applyMaskAdjustment(0, 2); h.c.selectRefinementMask(1);
    await h.c.applyMaskAdjustment(1, -3); h.c.selectRefinementMask(0);
    assert.equal(h.c.maskAdjustments.get(0).value, 2); assert.equal(h.c.maskAdjustments.get(1).value, -3);
    assert.deepEqual(h.calls[0][2], [10, 20, 200, 220]);
});

test('new SAM3 result and removing all points both reapply the same adjustment to their raw output', async () => {
    const h = setup(); await h.c.applyMaskAdjustment(0, 2);
    await h.c.interactionListener(event([{ shapeType: 'points', type: 'positive', points: [31, 41] }]));
    const replacement = [0, 9, 31, 41, 33, 43];
    core.lambda.call = async () => ({ shapes: [{ type: 'mask', points: replacement, attributes: [] }] });
    await h.realRun(h.c.interaction.id);
    assert.deepEqual(Array.from(h.calls.at(-1)[0]), replacement); assert.equal(h.calls.at(-1)[1], 2);
    await h.c.interactionListener(event([])); await settle();
    assert.deepEqual(Array.from(h.calls.at(-1)[0]), base); assert.equal(h.calls.at(-1)[1], 2);
});

test('empty erosion remains selected and resettable; Done creates the displayed adjusted mask', async () => {
    const h = setup(); h.c.maskAdjustmentClient.apply = async () => new Int32Array();
    await h.c.applyMaskAdjustment(0, -20);
    assert.equal(displayed(h), undefined); assert.equal(h.c.state.refiningMask, 0);
    assert.equal(h.c.visibleInteractionResults().length, 2);
    await h.c.applyMaskAdjustment(0, 0); assert.deepEqual(Array.from(displayed(h).points), base);
    h.c.maskAdjustmentClient.apply = async () => Int32Array.from(grown);
    await h.c.applyMaskAdjustment(0, 1);
    await h.c.interactionListener(event([], true));
    assert.deepEqual(h.annotations[0].points, grown);
});

test('late adjustment cannot overwrite reset, a newer radius, or a canceled session', async () => {
    const h = setup(); const resolves = [];
    h.c.maskAdjustmentClient.apply = () => new Promise((resolve) => resolves.push(resolve));
    const first = h.c.applyMaskAdjustment(0, 1);
    await h.c.applyMaskAdjustment(0, 0); resolves.shift()(Int32Array.from(grown)); await first;
    assert.deepEqual(Array.from(displayed(h).points), base);
    const second = h.c.applyMaskAdjustment(0, 1); const third = h.c.applyMaskAdjustment(0, 2);
    resolves[1](Int32Array.from(grown)); await third; resolves[0](Int32Array.from(base)); await second;
    assert.deepEqual(Array.from(displayed(h).points), grown);
    const pending = h.c.applyMaskAdjustment(0, 3); await h.c.cancelListener();
    resolves.at(-1)(Int32Array.from(grown)); await pending;
    assert.equal(h.c.maskAdjustments.size, 0); assert.equal(h.c.interaction.latestResponse.length, 0);
});

test('Done during pending local work takes the previously displayed preview, never an unseen result', async () => {
    const h = setup(); await h.c.applyMaskAdjustment(0, 1); let resolve;
    h.c.maskAdjustmentClient.apply = () => new Promise((r) => { resolve = r; });
    const pending = h.c.applyMaskAdjustment(0, -1);
    await h.c.interactionListener(event([], true)); resolve(Int32Array.from(base)); await pending;
    assert.deepEqual(h.annotations[0].points, grown);
});

test('processing failure restores raw mask and clears pending state', async () => {
    const h = setup(); h.c.maskAdjustmentClient.apply = async () => { throw new Error('worker failed'); };
    await h.c.applyMaskAdjustment(0, 1);
    assert.equal(h.c.maskAdjustments.size, 0); assert.deepEqual(Array.from(displayed(h).points), base);
});

test('Done button is disabled only for pending local adjustment, not ordinary SAM3 inference', () => {
    const { load, find } = require('./interactor-harness.cjs');
    const Overlay = load('cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/text-mask-refinement.tsx').default.type;
    const done = find(Overlay({ masks: [0], selected: 0, fetching: false, adjusting: true }), (item) => item.props?.children === 'Done');
    assert.equal(done.props.disabled, true);
});

test('polygon drawing and Done both use adjusted geometry even when the raw approximation collapses', async () => {
    const h = setup(); await h.c.applyMaskAdjustment(0, 1);
    h.c.state.convertMasksToPolygons = true;
    h.c.interaction.latestResponse[0].approximatedPoints = [];
    h.c.drawIntermediateShapesOnCanvas();
    const preview = displayed(h);
    assert.ok(preview, 'the valid adjusted polygon must be visible');
    await h.c.interactionListener(event([], true));
    assert.deepEqual(h.annotations[0].points, preview.points);
});

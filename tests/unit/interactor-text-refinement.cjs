// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const test = require('node:test');
const { create, core, event, find, load, textSchema } = require('./interactor-harness.cjs');

function setup(options = {}) {
    const harness = create({ activated: true, schema: [{ ...textSchema, supports_mask_refinement: true }], ...options });
    const { component } = harness;
    component.interaction.id = 'concept-session';
    component.interaction.latestResponse = [0.8, 0.7, 0.3].map((confidence, i) => ({
        rle: Int32Array.from([0, 100, 30 + i * 20, 40, 39 + i * 20, 49]), confidence,
        points: [[30, 40], [39, 40], [39, 49]], contours: [[[30, 40], [39, 40], [39, 49]]],
        approximatedPoints: [[30, 40], [39, 40], [39, 49]], labelName: null,
    }));
    component.state.interactorResponseReceived = true;
    component.initializeOpenCV = async () => {};
    component.receiveContoursFromMask = () => [[[30, 40], [39, 40], [39, 49]]];
    component.receivePointsFromMask = (contours) => contours[0];
    component.approximateResponsePoints = (points) => points;
    return harness;
}
const points = (positive = [35, 45], negative = [38, 48]) => event([
    { shapeType: 'points', type: 'positive', points: positive },
    { shapeType: 'points', type: 'negative', points: negative },
]);
const refined = { shapes: [{ type: 'mask', points: [0, 25, 30, 40, 34, 44], attributes: [{ spec_id: 0, value: '0.99' }] }] };

test('refinement capability enables visible-mask selection with stable IDs', () => {
    const { component, commands } = setup();
    component.drawIntermediateShapesOnCanvas();
    assert.equal(commands.at(-1).command, 'select_shape');
    const shapes = commands.find((c) => c.command === 'put_shapes').payload.shapes;
    assert.deepEqual(shapes.map((s) => s.id), [0, 1]);
    const old = setup({ schema: [{ ...textSchema, supports_mask_refinement: false }] });
    old.component.drawIntermediateShapesOnCanvas();
    assert.ok(old.commands.every((c) => c.command !== 'select_shape'));
});

test('selecting a mask starts points without submitting a click; hidden masks are rejected', async () => {
    const { component, commands, requests } = setup();
    await component.interactionListener({ detail: { shapes: [], finished: false, selectedShape: 0 } });
    assert.equal(component.state.refiningMask, 0);
    assert.equal(requests.length, 0);
    assert.equal(commands.at(-1).command, 'draw_points');
    assert.equal(commands.at(-1).payload.clearPrompts, true);
    component.selectRefinementMask(2);
    assert.equal(component.state.refiningMask, 0);
});

test('refinement sends the fixed seed and accumulated points with ROI-relative bbox and no text', async () => {
    const { component, requests } = setup();
    component.state.interactorRegionOfInterest = [10, 20, 200, 220];
    component.selectRefinementMask(0);
    await component.interactionListener(points());
    assert.deepEqual(requests.at(-1).extraParams, { refinement_mask: [0, 100, 20, 20, 29, 29] });
    assert.deepEqual(requests.at(-1).data.pos_points, [[35, 45]]);
    assert.deepEqual(requests.at(-1).data.neg_points, [[38, 48]]);
    assert.deepEqual(requests.at(-1).data.roi, [10, 20, 200, 220]);
});

test('only the selected result changes and original confidence and label are retained', async () => {
    const { component, realRun } = setup();
    const first = component.interaction.latestResponse[0];
    component.interaction.latestResponse[1].labelName = 'selected-label';
    component.selectRefinementMask(1);
    await component.interactionListener(points());
    core.lambda.call = async () => refined;
    await realRun(component.interaction.id);
    assert.equal(component.interaction.latestResponse.length, 3);
    assert.equal(component.interaction.latestResponse[0], first);
    assert.equal(component.interaction.latestResponse[1].confidence, 0.7);
    assert.equal(component.interaction.latestResponse[1].labelName, 'selected-label');
    assert.deepEqual(Array.from(component.interaction.latestResponse[1].rle), refined.shapes[0].points);
});

test('removing all points restores the seed and invalidates the pending refinement', async () => {
    const { component, realRun, requests } = setup();
    const original = component.interaction.latestResponse[0];
    component.selectRefinementMask(0);
    await component.interactionListener(points());
    let respond;
    core.lambda.call = () => new Promise((resolve) => { respond = resolve; });
    const pending = realRun(component.interaction.id);
    await Promise.resolve();
    await component.interactionListener(event([]));
    const count = requests.length;
    respond(refined);
    await pending;
    assert.equal(component.interaction.latestResponse[0], original);
    assert.equal(requests.length, count);
});

test('a newer point set suppresses older responses while preserving the queued request', async () => {
    const { component, realRun } = setup();
    const original = component.interaction.latestResponse[0];
    component.selectRefinementMask(0);
    await component.interactionListener(points());
    let respond;
    core.lambda.call = () => new Promise((resolve) => { respond = resolve; });
    const pending = realRun(component.interaction.id);
    await Promise.resolve();
    await component.interactionListener(points([34, 44], [37, 47]));
    respond(refined);
    await pending;
    assert.equal(component.interaction.latestResponse[0], original);
    assert.deepEqual(component.interaction.latestRequest.data.pos_points, [[34, 44]]);
});

test('Back to masks rejects late results and permits a different object without leaking points', async () => {
    const { component, realRun, commands } = setup();
    const original = component.interaction.latestResponse[0];
    component.selectRefinementMask(0);
    await component.interactionListener(points());
    let respond;
    core.lambda.call = () => new Promise((resolve) => { respond = resolve; });
    const pending = realRun(component.interaction.id);
    await Promise.resolve();
    component.finishRefinement();
    assert.equal(component.state.refiningMask, null);
    component.selectRefinementMask(1);
    respond(refined);
    await pending;
    assert.equal(component.interaction.latestResponse[0], original);
    assert.equal(component.state.refiningMask, 1);
    assert.equal(commands.filter((c) => c.command === 'draw_points').at(-1).payload.clearPrompts, true);
});

test('hiding the selected mask leaves refinement and invalidates a blocked request', async () => {
    const { component } = setup({ blocked: true });
    component.selectRefinementMask(1);
    await component.interactionListener(points());
    assert.ok(component.interaction.latestPostponedRequest);
    const previous = component.state;
    component.state = { ...previous, thresholdValue: 0.75 };
    component.componentDidUpdate(component.props, previous);
    assert.equal(component.state.refiningMask, null);
    assert.equal(component.interaction.latestPostponedRequest, null);
});

test('Done accepts each confirmed visible mask once and Esc cancels refinement', async () => {
    const { component, annotations } = setup();
    component.selectRefinementMask(0);
    await component.interactionListener(event([], true));
    await component.interactionListener(event([], true));
    assert.equal(annotations.length, 2);
    const canceled = setup();
    canceled.component.selectRefinementMask(0);
    await canceled.component.cancelListener();
    await canceled.component.interactionListener(event([], true));
    assert.equal(canceled.annotations.length, 0);
    assert.equal(canceled.component.state.refiningMask, null);
});

test('Done remains available during inference and accepts only the currently confirmed preview', async () => {
    const Overlay = load('cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/text-mask-refinement.tsx').default.type;
    const { component, annotations, realRun } = setup();
    component.selectRefinementMask(0);
    await component.interactionListener(points());
    let respond;
    core.lambda.call = () => new Promise((resolve) => { respond = resolve; });
    const pending = realRun(component.interaction.id);
    await Promise.resolve();
    const overlay = Overlay({ masks: [0, 1], selected: 0, fetching: true,
        onDone: () => component.interactionListener(event([], true)) });
    const done = find(overlay, (item) => item.props?.children === 'Done');
    assert.ok(!done.props.disabled);
    await done.props.onClick();
    respond(refined);
    await pending;
    assert.equal(annotations.length, 2);
    assert.deepEqual(annotations[0].points, [0, 100, 30, 40, 39, 49]);
});

test('restoring a seed after polygon accuracy changes uses the current approximation', async () => {
    const { component, annotations, realRun } = setup();
    component.state.convertMasksToPolygons = true;
    const seed = component.interaction.latestResponse[0];
    seed.points = [[30, 40], [39, 40], [39, 49], [30, 49]];
    seed.approximatedPoints = seed.points;
    component.approximateResponsePoints = (vertices) => vertices.slice(0,
        component.state.approxPolyAccuracy === 13 ? 3 : 4);
    component.selectRefinementMask(0);
    await component.interactionListener(points());
    core.lambda.call = async () => refined;
    await realRun(component.interaction.id);
    const previous = component.state;
    component.state = { ...previous, approxPolyAccuracy: 13 };
    component.componentDidUpdate(component.props, previous);
    await component.interactionListener(event([]));
    await component.interactionListener(event([], true));
    assert.equal(annotations[0].points.length, 6);
    assert.deepEqual(annotations[0].points, seed.points.slice(0, 3).flat());
});

// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const test = require('node:test');
const { create, core, event, button, changeProps, find, dependencies, textSchema } = require('./interactor-harness.cjs');

test('Find masks starts a concept request after activation and preserves ROI', () => {
    const { component, commands, requests } = create();
    component.state.interactorRegionOfInterest = [10, 20, 200, 220];
    assert.equal(button(component).props.children, 'Find masks');
    button(component).props.onClick();
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].extraParams, { prompt_mode: 'concept', text_prompt: 'red circles' });
    assert.deepEqual(requests[0].data, {
        frame: 3, obj_bbox: [], pos_points: [], neg_points: [], roi: [10, 20, 200, 220],
    });
    assert.equal(commands.find((command) => command.enabled).command, 'put_shapes');
    assert.ok(!commands.some((command) => ['draw_box', 'draw_points'].includes(command.command)));
});

test('concept mode cannot start with blank or overlong text without an exemplar', () => {
    const { component, requests } = create();
    for (const value of ['   ', 'x'.repeat(257)]) {
        component.state.interactorExtraParams.text_prompt = value;
        assert.equal(button(component).props.disabled, true);
        button(component).props.onClick();
    }
    assert.equal(requests.length, 0);
});

test('a blocked concept request replays the original prompt and ROI on unblock', () => {
    const { component, requests } = create({ blocked: true });
    component.state.interactorRegionOfInterest = [10, 20, 200, 220];
    button(component).props.onClick();
    assert.equal(requests.length, 0);
    assert.equal(component.interaction.latestPostponedRequest.extraParams.text_prompt, 'red circles');
    component.state.interactorExtraParams.text_prompt = 'different prompt';
    changeProps(component, { toolsBlockerState: { algorithmsLocked: false } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].extraParams.text_prompt, 'red circles');
    assert.deepEqual(requests[0].data.roi, [10, 20, 200, 220]);
});

test('concept preview ignores initial canvas point prompts', async () => {
    const { component, requests, commands } = create({ activated: true });
    await component.interactionListener(event([{ shapeType: 'points', type: 'positive', points: [30, 40] }]));
    assert.deepEqual(requests, []);
    assert.deepEqual(commands, []);
});

test('single-object mode omits text retained from a previous concept session', async () => {
    const { component, requests } = create({ activated: true });
    component.state.interactorPromptMode = 'single_object';
    await component.interactionListener(event([{ shapeType: 'points', type: 'positive', points: [30, 40] }]));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].extraParams, {});
    assert.deepEqual(requests[0].data.pos_points, [[30, 40]]);
});

test('text parameter form renders an editable field with the declared length limit', () => {
    let change;
    const Form = dependencies['components/common/model-extra-params-form'].default;
    const rendered = Form({ schema: [textSchema], values: { text_prompt: 'person' }, onChange: (...args) => { change = args; } });
    const input = find(rendered, (element) => element.type === dependencies['antd/lib/input']);
    assert.ok(input, 'text field must render');
    assert.equal(input.props.maxLength, 256);
    input.props.onChange({ target: { value: 'yellow bus' } });
    assert.deepEqual(change, ['text_prompt', 'yellow bus']);
});

test('switching interactor resets concept mode so other interactors keep their existing start behavior', () => {
    const { component } = create();
    const other = { ...component.props.interactors[0], id: 'crop', extraParamsSchema: [] };
    component.props.interactors.push(other);
    component.setActiveInteractor('crop');
    assert.equal(component.state.interactorPromptMode, 'single_object');
    assert.equal(button(component).props.children, 'Interact');
});

test('Done creates separate displayed masks with the selected label and respects confidence filtering', async () => {
    const { component, annotations } = create({ activated: true });
    component.interaction.latestResponse = [0.8, 0.7, 0.3].map((confidence, index) => ({
        rle: Int32Array.from([0, 4, index * 3, 0, index * 3 + 1, 1]),
        confidence, labelName: null,
    }));
    assert.equal(annotations.length, 0);
    await component.interactionListener(event([], true));
    assert.equal(annotations.length, 2);
    assert.ok(annotations.every((shape) => shape.label.id === 7 && shape.frame === 3 && shape.shapeType === 'mask'));
    assert.notDeepEqual(annotations[0].points, annotations[1].points);
    await component.interactionListener(event([], true));
    assert.equal(annotations.length, 2, 'duplicate completion must not create more annotations');
});

test('Esc invalidates even a postponed request before inference starts', async () => {
    const { component, requests } = create({ blocked: true });
    button(component).props.onClick();
    assert.ok(component.interaction.latestPostponedRequest);
    await component.cancelListener();
    assert.equal(component.interaction.latestPostponedRequest, null);
    assert.equal(component.interaction.latestResponse.length, 0);
    changeProps(component, { toolsBlockerState: { algorithmsLocked: false } });
    assert.equal(requests.length, 0);
});

test('changing frames discards the concept preview instead of applying it to the new frame', async () => {
    const { component, annotations } = create({ activated: true });
    component.interaction.latestResponse = [{ rle: Int32Array.from([0, 4, 0, 0, 1, 1]), confidence: 1, labelName: null }];
    changeProps(component, { frame: 4 });
    await component.interactionListener(event([], true));
    assert.equal(annotations.length, 0);
});

test('changing jobs cancels the active concept canvas and session', () => {
    const { component, commands } = create({ activated: true });
    component.interaction.id = 'concept-session';
    component.interaction.latestResponse = [{
        rle: Int32Array.from([0, 4, 0, 0, 1, 1]), confidence: 1, labelName: null,
    }];
    changeProps(component, { jobInstance: { ...component.props.jobInstance, id: 337 } });
    assert.deepEqual(commands, [{ cancel: true }]);
    assert.equal(component.interaction.id, null);
    assert.equal(component.interaction.isAborted, true);
    assert.deepEqual(component.interaction.latestResponse, []);
    assert.equal(component.state.interactorResponseReceived, false);
});

test('an inactive concept panel does not cancel another canvas tool when frames change', () => {
    const { component, commands } = create();
    changeProps(component, { frame: 4 });
    assert.deepEqual(commands, []);
});

test('repeat restores the last concept setup after editing the inactive panel to single-object', async () => {
    const { component, requests } = create();
    button(component).props.onClick();
    await component.interactionListener(event([], true));
    changeProps(component, { isActivated: false });
    component.state.interactorPromptMode = 'single_object';
    component.state.interactorExtraParams = { text_prompt: 'another description' };
    // N replays the saved canvas command and reactivates the controller, without clicking Find.
    changeProps(component, { isActivated: true });
    assert.equal(requests.length, 2);
    assert.equal(component.state.interactorPromptMode, 'concept');
    assert.equal(requests[1].extraParams.prompt_mode, 'concept');
    assert.equal(requests[1].extraParams.text_prompt, 'red circles');
});

test('repeat of single-object does not submit a blank prompt edited into the inactive concept panel', async () => {
    const { component, requests } = create();
    component.state.interactorPromptMode = 'single_object';
    button(component).props.onClick();
    await component.interactionListener(event([], true));
    changeProps(component, { isActivated: false });
    component.state.interactorPromptMode = 'concept';
    component.state.interactorExtraParams = { text_prompt: '' };
    changeProps(component, { isActivated: true });
    assert.equal(component.state.interactorPromptMode, 'single_object');
    assert.equal(requests.length, 0);
});

test('the model selector displays the interactor restored by repeat', async () => {
    const { component } = create();
    button(component).props.onClick();
    await component.interactionListener(event([], true));
    changeProps(component, { isActivated: false });
    component.props.interactors.push({ ...component.props.interactors[0], id: 'other', name: 'Other', extraParamsSchema: [] });
    component.setActiveInteractor('other');
    changeProps(component, { isActivated: true });
    const selector = find(component.renderInteractorBlock(), (element) => element.props?.className === 'cvat-interactor-selector');
    assert.equal(selector.props.value, 'sam3');
});

test('a canceled inference response cannot restore its preview', async () => {
    const { component, commands, annotations, realRun } = create();
    let respond;
    core.lambda.call = () => new Promise((resolve) => { respond = resolve; });
    component.initializeOpenCV = async () => {};
    button(component).props.onClick();
    const pending = realRun(component.interaction.id);
    await Promise.resolve();
    assert.equal(component.state.fetching, true);
    await component.cancelListener();
    respond({ shapes: [{ type: 'mask', points: [0, 4, 0, 0, 1, 1], attributes: [] }] });
    await pending;
    assert.equal(component.interaction.latestResponse.length, 0);
    assert.equal(component.state.fetching, false);
    assert.ok(commands.every((command) => !command.payload?.shapes?.length));
    await component.interactionListener(event([], true));
    assert.equal(annotations.length, 0);
});

test('completion of a canceled request does not clear the next session loading state', async () => {
    const { component, realRun } = create();
    let respond;
    core.lambda.call = () => new Promise((resolve) => { respond = resolve; });
    component.initializeOpenCV = async () => {};
    button(component).props.onClick();
    const pending = realRun(component.interaction.id);
    await Promise.resolve();
    await component.cancelListener();
    component.interaction.id = 'new-session';
    component.interaction.isAborted = false;
    component.state.fetching = true;
    respond({ shapes: [] });
    await pending;
    assert.equal(component.state.fetching, true);
});

// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    create, event, button, changeProps, dependencies, find, textSchema,
} = require('./interactor-harness.cjs');

const exemplar = { shapeType: 'rectangle', type: 'positive', points: [40, 50, 140, 160] };
const otherExemplar = { shapeType: 'rectangle', type: 'positive', points: [170, 180, 240, 250] };
const positivePoint = { shapeType: 'points', type: 'positive', points: [80, 90] };
const legacyTextSchema = {
    name: 'text_prompt',
    type: 'text',
    default: '',
    max_length: 256,
    supports_mask_refinement: true,
};

function useExemplar(component, value = true) {
    component.state.conceptUsesBox = value;
}

function seedResult(component) {
    component.interaction.id = 'concept-session';
    component.interaction.latestResponse = [{
        rle: Int32Array.from([0, 100, 30, 40, 39, 49]),
        points: [[30, 40], [39, 40], [39, 49]],
        contours: [[[30, 40], [39, 40], [39, 49]]],
        approximatedPoints: [[30, 40], [39, 40], [39, 49]],
        confidence: 0.8,
        labelName: null,
    }];
    component.state.interactorResponseReceived = true;
}

function renderedText(element) {
    if (typeof element === 'string' || typeof element === 'number') return String(element);
    if (!element || typeof element !== 'object') return '';
    return require('react').Children.toArray(element.props?.children).map(renderedText).join(' ');
}

function promptModeRadio(component) {
    return find(component.renderInteractorBlock(), (element) => element.type === dependencies['antd/lib/radio'].Group);
}

function selectPromptMode(component, value) {
    promptModeRadio(component).props.onChange({ target: { value } });
}

function findButtonByText(element, label) {
    return find(element, (candidate) => (
        candidate.type === dependencies['antd/lib/button'] && renderedText(candidate).trim() === label
    ));
}

function modeControls(component) {
    return find(component.renderInteractorBlock(), (element) => (
        typeof element.props?.className === 'string' &&
        element.props.className.split(' ').includes('cvat-tools-interactor-mode-controls')
    ));
}

test('concept-capable SAM3 renders explicit task modes and defaults to single-object interaction', () => {
    const { component } = create({ promptMode: null });
    const rendered = component.renderInteractorBlock();
    const radio = promptModeRadio(component);

    assert.equal(component.state.interactorPromptMode, 'single_object');
    assert.equal(radio.props['aria-label'], 'SAM3 task mode');
    assert.equal(radio.props.value, 'single_object');
    assert.deepEqual(radio.props.options, [
        { label: 'Single object', value: 'single_object' },
        { label: 'Find similar objects', value: 'concept' },
    ]);
    assert.equal(button(component).props.children, 'Interact');
    assert.equal(button(component).props['data-primary-action'], 'true');
    assert.match(modeControls(component).props.className, /cvat-tools-interactor-mode-controls-concept-capable/);
    assert.ok(find(rendered, (element) => element.props?.['aria-label'] === 'Start with a bounding box'));
});

test('concept mode renders its text, label shortcut, and positive exemplar controls', () => {
    const { component } = create({ promptMode: null });
    selectPromptMode(component, 'concept');
    let rendered = component.renderInteractorBlock();
    const form = find(rendered, (element) => (
        element.type === dependencies['components/common/model-extra-params-form'].default &&
        element.props.title === 'Concept description'
    ));
    const shortcut = findButtonByText(rendered, 'Use label name');
    const exemplarSwitch = find(rendered, (element) => (
        element.type === dependencies['antd/lib/switch'] &&
        element.props['aria-label'] === 'Add positive exemplar box'
    ));

    assert.ok(form);
    assert.equal(form.props.schema[0].label, 'Concept description');
    assert.ok(shortcut);
    assert.equal(shortcut.props.size, 'small');
    assert.equal(shortcut.props.disabled, false);
    assert.ok(exemplarSwitch);
    assert.equal(exemplarSwitch.props.checked, false);
    assert.match(renderedText(rendered), /Add positive exemplar box/);
    assert.equal(button(component).props.children, 'Find masks');

    exemplarSwitch.props.onChange(true);
    assert.equal(component.state.conceptUsesBox, true);
    rendered = component.renderInteractorBlock();
    assert.equal(find(rendered, (element) => (
        element.props?.['aria-label'] === 'Add positive exemplar box'
    )).props.checked, true);
});

test('Use label name marks the prompt touched while keeping later text edits live', () => {
    const { component } = create({ promptMode: null });
    selectPromptMode(component, 'concept');
    component.state.interactorExtraParams.text_prompt = '';
    component.state.interactorExtraParamsTouched.text_prompt = false;
    let rendered = component.renderInteractorBlock();
    findButtonByText(rendered, 'Use label name').props.onClick();

    assert.equal(component.state.interactorExtraParams.text_prompt, 'defect');
    assert.equal(component.state.interactorExtraParamsTouched.text_prompt, true);

    rendered = component.renderInteractorBlock();
    const form = find(rendered, (element) => (
        element.type === dependencies['components/common/model-extra-params-form'].default &&
        element.props.title === 'Concept description'
    ));
    const formTree = form.type(form.props);
    const input = find(formTree, (element) => element.type === dependencies['antd/lib/input']);
    input.props.onChange({ target: { value: 'edited defect' } });
    assert.equal(component.state.interactorExtraParams.text_prompt, 'edited defect');
    assert.equal(component.state.interactorExtraParamsTouched.text_prompt, true);
});

test('Use label name is disabled only when the active label is unavailable', () => {
    const { component } = create({ promptMode: null });
    selectPromptMode(component, 'concept');
    component.state.activeLabelID = null;
    const shortcut = findButtonByText(component.renderInteractorBlock(), 'Use label name');
    assert.equal(shortcut.props.disabled, true);
});

test('concept prompt validity accepts text or an exemplar and retains max-length validation', () => {
    const { component } = create({ promptMode: null });
    selectPromptMode(component, 'concept');
    component.state.interactorExtraParams.text_prompt = '  ';
    assert.equal(button(component).props.disabled, true);

    let exemplarSwitch = find(component.renderInteractorBlock(), (element) => (
        element.props?.['aria-label'] === 'Add positive exemplar box'
    ));
    exemplarSwitch.props.onChange(true);
    assert.equal(button(component).props.disabled, false);

    component.state.interactorExtraParams.text_prompt = 'x'.repeat(257);
    assert.equal(button(component).props.disabled, true);
    component.state.interactorExtraParams.text_prompt = 'bridge pier';
    exemplarSwitch = find(component.renderInteractorBlock(), (element) => (
        element.props?.['aria-label'] === 'Add positive exemplar box'
    ));
    exemplarSwitch.props.onChange(false);
    assert.equal(button(component).props.disabled, false);
});

test('legacy text schema retains Points / box and Text without concept-only controls', () => {
    const { component } = create({ schema: [legacyTextSchema], promptMode: null });
    const radio = promptModeRadio(component);
    assert.equal(radio.props['aria-label'], 'Prompt mode');
    assert.deepEqual(radio.props.options, [
        { label: 'Points / box', value: 'single_object' },
        { label: 'Text', value: 'concept' },
    ]);

    selectPromptMode(component, 'concept');
    const rendered = component.renderInteractorBlock();
    assert.ok(find(rendered, (element) => (
        element.type === dependencies['components/common/model-extra-params-form'].default &&
        element.props.title === 'Prompt'
    )));
    assert.equal(findButtonByText(rendered, 'Use label name'), undefined);
    assert.equal(find(rendered, (element) => element.props?.['aria-label'] === 'Add positive exemplar box'), undefined);
    assert.equal(component.supportsMaskRefinement(), true);
});

test('interactors without a text schema omit task modes and keep single-object controls', () => {
    const { component } = create({ schema: [], promptMode: null });
    const rendered = component.renderInteractorBlock();
    assert.equal(promptModeRadio(component), undefined);
    assert.equal(modeControls(component).props.className, 'cvat-tools-interactor-mode-controls');
    assert.ok(find(rendered, (element) => element.props?.['aria-label'] === 'Start with a bounding box'));
    assert.equal(button(component).props.children, 'Interact');
});

test('ROI and mask conversion stay after the reserved mode-specific area', () => {
    const { component } = create({ promptMode: null });
    selectPromptMode(component, 'concept');
    const rendered = component.renderInteractorBlock();
    const directChildren = require('react').Children.toArray(rendered.props.children);
    const modeIndex = directChildren.findIndex((element) => (
        element.props?.className?.split(' ').includes('cvat-tools-interactor-mode-controls')
    ));
    const setupIndex = directChildren.findIndex((element) => (
        element.props?.className === 'cvat-tools-interactor-setups'
    ));
    const setups = directChildren[setupIndex];

    assert.ok(modeIndex >= 0);
    assert.ok(setupIndex > modeIndex);
    assert.ok(find(setups, (element) => (
        element.type === dependencies['components/model-runner-modal/region-of-interest-input']
    )));
    assert.match(renderedText(setups), /Convert masks to polygons/);
});

test('AI Tools width and concept-capable height modifier have scoped CSS contracts', () => {
    const stylesheet = fs.readFileSync(path.join(
        __dirname,
        '../../cvat-ui/src/components/annotation-page/standard-workspace/styles.scss',
    ), 'utf8');
    assert.match(stylesheet, /\.cvat-tools-control-popover-content\s*\{[^}]*width:\s*\$grid-unit-size \* 65;/s);
    assert.match(stylesheet, /\.cvat-tools-interactor-mode-controls\s*\{[^}]*min-height:\s*\$grid-unit-size \* 4;/s);
    assert.match(
        stylesheet,
        /\.cvat-tools-interactor-mode-controls-concept-capable\s*\{[^}]*min-height:\s*\$grid-unit-size \* 10;/s,
    );
});

test('real component default is single-object and a point request has no concept or text fields', async () => {
    const { component, requests } = create({ activated: true, promptMode: null });
    assert.equal(component.state.interactorPromptMode, 'single_object');
    assert.equal(component.state.conceptUsesBox, false);
    await component.interactionListener(event([positivePoint]));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].extraParams, {});
    assert.deepEqual(requests[0].data.pos_points, [[80, 90]]);
});

test('text-only concept submits explicit mode, trimmed text, and independent ROI exactly once', () => {
    const { component, commands, requests } = create();
    component.state.interactorRegionOfInterest = [10, 20, 200, 220];
    button(component).props.onClick();
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].extraParams, { prompt_mode: 'concept', text_prompt: 'red circles' });
    assert.deepEqual(requests[0].data, {
        frame: 3, obj_bbox: [], pos_points: [], neg_points: [], roi: [10, 20, 200, 220],
    });
    assert.equal(commands.filter((command) => command.enabled && command.command === 'put_shapes').length, 1);
});

test('legacy text-capable interactor submits trimmed text without explicit concept mode', () => {
    const { component, commands, requests } = create({ schema: [legacyTextSchema] });
    assert.equal(component.hasTextPrompting(), true);
    assert.equal(component.supportsConceptPrompting(), false);
    button(component).props.onClick();
    assert.equal(commands.find((command) => command.enabled).command, 'put_shapes');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].extraParams, { text_prompt: 'red circles' });
    assert.deepEqual(requests[0].data.obj_bbox, []);
});

test('legacy text-capable interactor can select and refine a returned mask', async () => {
    const { component, requests } = create({ activated: true, schema: [legacyTextSchema] });
    component.initializeOpenCV = async () => {};
    seedResult(component);
    component.selectRefinementMask(0);
    assert.equal(component.state.refiningMask, 0);
    await component.interactionListener(event([positivePoint]));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].extraParams, { refinement_mask: [0, 100, 30, 40, 39, 49] });
    assert.deepEqual(requests[0].data.pos_points, [[80, 90]]);
    assert.deepEqual(requests[0].data.obj_bbox, []);
});

test('exemplar-only concept waits for one positive rectangle and submits no points', async () => {
    const { component, commands, requests } = create();
    component.state.interactorExtraParams.text_prompt = '   ';
    component.state.interactorRegionOfInterest = [10, 20, 200, 220];
    useExemplar(component);
    button(component).props.onClick();
    const drawBox = commands.find((command) => command.enabled);
    assert.equal(drawBox.command, 'draw_box');
    assert.deepEqual(drawBox.settings.regionOfInterest, [10, 20, 200, 220]);
    assert.equal(requests.length, 0);
    await component.interactionListener(event([exemplar]));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].extraParams, { prompt_mode: 'concept' });
    assert.deepEqual(requests[0].data.obj_bbox, [[40, 50], [140, 160]]);
    assert.deepEqual(requests[0].data.pos_points, []);
    assert.deepEqual(requests[0].data.neg_points, []);
});

test('blocked combined concept snapshots text, exemplar flag, mapping, ROI, and box', async () => {
    const { component, requests } = create({ blocked: true });
    useExemplar(component);
    component.state.interactorMapping = { sam3: { name: 'defect' } };
    component.state.interactorRegionOfInterest = [10, 20, 200, 220];
    button(component).props.onClick();
    await component.interactionListener(event([exemplar]));
    const postponed = component.interaction.latestPostponedRequest;
    assert.ok(postponed);
    component.state.interactorExtraParams.text_prompt = 'new prompt';
    component.state.conceptUsesBox = false;
    component.state.interactorMapping.sam3.name = 'changed';
    component.state.interactorRegionOfInterest[0] = 99;
    changeProps(component, { toolsBlockerState: { algorithmsLocked: false } });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].extraParams, { prompt_mode: 'concept', text_prompt: 'red circles' });
    assert.deepEqual(requests[0].mapping, { sam3: { name: 'defect' } });
    assert.deepEqual(requests[0].data.roi, [10, 20, 200, 220]);
    assert.deepEqual(requests[0].data.obj_bbox, [[40, 50], [140, 160]]);
    assert.equal(postponed, requests[0]);
});

test('selected concept-mask refinement includes seed and omits concept and text prompts', async () => {
    const { component, requests } = create({ activated: true });
    component.initializeOpenCV = async () => {};
    seedResult(component);
    component.selectRefinementMask(0);
    await component.interactionListener(event([positivePoint]));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].extraParams, { refinement_mask: [0, 100, 30, 40, 39, 49] });
    assert.deepEqual(requests[0].data.pos_points, [[80, 90]]);
});

test('selected concept-mask refinement drops a stale exemplar box from the canvas event', async () => {
    const { component, requests } = create({ activated: true });
    component.initializeOpenCV = async () => {};
    seedResult(component);
    component.selectRefinementMask(0);
    await component.interactionListener(event([exemplar, positivePoint]));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].data.obj_bbox, []);
    assert.deepEqual(requests[0].data.pos_points, [[80, 90]]);
    assert.deepEqual(requests[0].extraParams, { refinement_mask: [0, 100, 30, 40, 39, 49] });
});

test('blank text disables text-only concept but permits exemplar-enabled concept', () => {
    const { component } = create();
    component.state.interactorExtraParams.text_prompt = '  ';
    assert.equal(button(component).props.disabled, true);
    useExemplar(component);
    assert.equal(button(component).props.disabled, false);
    component.state.interactorExtraParams.text_prompt = 'x'.repeat(257);
    assert.equal(button(component).props.disabled, true);
});

test('two exemplar boxes never submit a concept request', async () => {
    const { component, requests } = create({ activated: true });
    useExemplar(component);
    await component.interactionListener(event([exemplar, otherExemplar]));
    assert.deepEqual(requests, []);
});

test('initial concept point shapes never submit a concept request', async () => {
    const textOnly = create({ activated: true });
    await textOnly.component.interactionListener(event([positivePoint]));
    assert.deepEqual(textOnly.requests, []);
    const withExemplar = create({ activated: true });
    useExemplar(withExemplar.component);
    await withExemplar.component.interactionListener(event([exemplar, positivePoint]));
    assert.deepEqual(withExemplar.requests, []);
});

test('changing interactors resets single-object mode and disables concept exemplar', () => {
    const { component } = create();
    useExemplar(component);
    component.props.interactors.push({ ...component.props.interactors[0], id: 'other' });
    component.setActiveInteractor('other');
    assert.equal(component.state.interactorPromptMode, 'single_object');
    assert.equal(component.state.conceptUsesBox, false);
});

test('repeat reactivation restores submitted concept text, box flag, mapping, and ROI', async () => {
    const { component } = create();
    useExemplar(component);
    component.state.interactorMapping = { sam3: { name: 'defect' } };
    component.state.interactorRegionOfInterest = [10, 20, 200, 220];
    button(component).props.onClick();
    await component.interactionListener(event([exemplar]));
    changeProps(component, { isActivated: false });
    component.state.interactorPromptMode = 'single_object';
    component.state.conceptUsesBox = false;
    component.state.interactorExtraParams = { text_prompt: 'edited' };
    component.state.interactorMapping = null;
    component.state.interactorRegionOfInterest = null;
    changeProps(component, { isActivated: true });
    assert.equal(component.state.interactorPromptMode, 'concept');
    assert.equal(component.state.conceptUsesBox, true);
    assert.equal(component.state.interactorExtraParams.text_prompt, '  red circles  ');
    assert.deepEqual(component.state.interactorMapping, { sam3: { name: 'defect' } });
    assert.deepEqual(component.state.interactorRegionOfInterest, [10, 20, 200, 220]);
});

test('a new concept run clears result, refinement, morphology, and queued-request state before activation', () => {
    const { component } = create();
    seedResult(component);
    component.refinement = { index: 0, seed: component.interaction.latestResponse[0] };
    component.state.refiningMask = 0;
    component.state.showConfidenceControl = true;
    component.interaction.latestRequest = { stale: true };
    component.interaction.latestPostponedRequest = { stale: true };
    component.maskAdjustments.set(0, { value: 1 });
    const previousRevision = component.refinementRevision;
    let stateAtActivation;
    const record = component.props.canvasInstance.interact;
    component.props.canvasInstance.interact = (command) => {
        if (command.enabled) {
            stateAtActivation = {
                responseCount: component.interaction.latestResponse.length,
                latestRequest: component.interaction.latestRequest,
                postponed: component.interaction.latestPostponedRequest,
                adjustments: component.maskAdjustments.size,
                refinement: component.refinement,
                received: component.state.interactorResponseReceived,
                confidence: component.state.showConfidenceControl,
                refiningMask: component.state.refiningMask,
            };
        }
        record(command);
    };
    button(component).props.onClick();
    assert.deepEqual(stateAtActivation, {
        responseCount: 0,
        latestRequest: null,
        postponed: null,
        adjustments: 0,
        refinement: null,
        received: false,
        confidence: false,
        refiningMask: null,
    });
    assert.ok(component.refinementRevision > previousRevision);
});

test('text-only auto-submits once while exemplar mode waits for its box event', () => {
    const textOnly = create();
    button(textOnly.component).props.onClick();
    assert.equal(textOnly.requests.length, 1);
    changeProps(textOnly.component, { isActivated: true });
    assert.equal(textOnly.requests.length, 1);

    const exemplarMode = create();
    useExemplar(exemplarMode.component);
    button(exemplarMode.component).props.onClick();
    assert.equal(exemplarMode.requests.length, 0);
});

test('an interactor without concept-box capability remains single-object', () => {
    const schema = [{ ...textSchema, supports_concept_box: false }];
    const { component } = create({ schema, promptMode: null });
    assert.equal(component.state.interactorPromptMode, 'single_object');
    assert.equal(component.hasTextPrompting(), true);
    assert.equal(component.supportsConceptPrompting(), false);
    assert.equal(button(component).props.children, 'Interact');
});

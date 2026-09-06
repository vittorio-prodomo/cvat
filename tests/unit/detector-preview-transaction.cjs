// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
// Run with: node tests/unit/detector-preview-transaction.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');

const root = path.resolve(__dirname, '../..');
const sourceFile = path.join(
    root,
    'cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx',
);
const notifications = [];
const messages = [];
const workers = [];
const timers = new Map();
let nextTimer = 1;
let lambdaCall = async () => ({ tags: [], shapes: [], tracks: [] });

class FakeDetectorPostprocessingClient {
    constructor() {
        this.calls = [];
        this.disposed = false;
        this.failure = null;
        workers.push(this);
    }

    async process(shapes, frame, options) {
        this.calls.push({ shapes, frame, options });
        if (this.failure) throw this.failure;
        return shapes.filter(({ score }) => score === undefined ||
            options.confidenceThreshold === null || score >= options.confidenceThreshold);
    }

    async retry() {
        const latest = this.calls.at(-1);
        this.failure = null;
        return this.process(latest.shapes, latest.frame, latest.options);
    }

    dispose() {
        this.disposed = true;
    }
}

const core = {
    plugins: { register() {} },
    lambda: { call: (...args) => lambdaCall(...args) },
    classes: { ObjectState: class { constructor(data) { Object.assign(this, data); } } },
    enums: { Source: { AUTO: 'auto', SEMI_AUTO: 'semi-auto' } },
};

const normalizeDetectorShapes = (shapes, labels) => shapes.map((shape, sourceIndex) => ({
    ...shape,
    sourceIndex,
    targetLabelType: labels.find(({ id }) => id === shape.label_id).type,
}));
const toTemporaryCanvasShapes = (shapes) => shapes.map(({ type, points, rotation }) => ({
    shapeType: type, points, rotation,
}));
const toObjectStates = ({ tags, shapes }) => [
    ...tags.map((tag) => ({ kind: 'tag', source: tag })),
    ...shapes.map((shape) => ({ kind: 'shape', source: shape })),
];

function DetectorPreview() {
    return null;
}

const dependencies = {
    react: React,
    'react-dom': { createPortal: (content) => content },
    lodash: require('lodash'),
    'react-redux': { connect: () => (component) => component },
    'cvat-core-wrapper': {
        getCore: () => core,
        DimensionType: { DIMENSION_2D: '2d' },
        ObjectType: { TAG: 'tag', SHAPE: 'shape' },
        ShapeType: { MASK: 'mask', POLYGON: 'polygon', RECTANGLE: 'rectangle' },
    },
    'cvat-canvas-wrapper': { convertShapesForInteractor: () => [] },
    'utils/detector-postprocessing-client': { DetectorPostprocessingClient: FakeDetectorPostprocessingClient },
    'components/model-runner-modal/detector-runner-config': {},
    './detector-result-adapter': {
        normalizeDetectorShapes, toTemporaryCanvasShapes, toObjectStates,
    },
    './detector-preview': DetectorPreview,
    'antd/lib/select': Object.assign(() => null, { Option: () => null }),
    'antd/lib/radio': { Group: () => null, Button: () => null },
    'antd/lib/grid': { Row: 'div', Col: 'div' },
    'antd/lib/message': { info: (value) => messages.push(value), loading: () => () => {} },
    'antd/lib/notification': { error: (value) => notifications.push(value), warning() {} },
    './handle-popover-visibility': (component) => component,
    'components/common/model-extra-params-form': {
        buildExtraParamsDefaults: () => ({}),
        default: () => null,
    },
    '@ant-design/icons': {
        __esModule: true,
        default: () => null,
        QuestionCircleOutlined: () => null,
        LoadingOutlined: () => null,
    },
    icons: { AIToolsIcon: () => null },
};
for (const name of [
    'button', 'popover', 'switch', 'typography/Text', 'tabs',
]) {
    dependencies[`antd/lib/${name}`] = () => null;
}
for (const name of [
    'icons', 'utils/opencv-wrapper/opencv-wrapper', 'utils/primary-action-enter',
    'utils/mask-morphology-client', 'reducers', 'actions/annotation-actions',
    'components/model-runner-modal/detector-runner',
    'components/model-runner-modal/region-of-interest-input',
    'components/label-selector/label-selector', 'components/common/cvat-tooltip',
    'components/common/cvat-markdown',
    'components/annotation-page/standard-workspace/controls-side-bar/approximation-accuracy',
    'components/annotation-page/standard-workspace/controls-side-bar/confidence-threshold',
    'actions/settings-actions', 'components/model-runner-modal/label-mapping-utils',
    './interactor-label-mapper', './interactor-tooltips', './text-mask-refinement',
    './mask-morphology-control',
]) {
    if (!dependencies[name]) dependencies[name] = () => null;
}

function loadToolsControl() {
    const output = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
        fileName: sourceFile,
        compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.CommonJS,
            jsx: ts.JsxEmit.React,
            esModuleInterop: true,
        },
    }).outputText;
    const mod = { exports: {} };
    vm.compileFunction(output, ['require', 'module', 'exports', 'localStorage', 'window'], { filename: sourceFile })(
        (name) => dependencies[name] || {},
        mod,
        mod.exports,
        { getItem: () => null },
        {
            addEventListener() {},
            removeEventListener() {},
            setTimeout(callback) {
                const id = nextTimer++;
                timers.set(id, callback);
                return id;
            },
            clearTimeout(id) { timers.delete(id); },
            document: {
                getElementById: () => null,
                getElementsByClassName: () => [{}],
            },
        },
    );
    return mod.exports.ToolsControlComponent;
}

const ToolsControlComponent = loadToolsControl();

function makeResult({ tags = [], shapes = [] } = {}) {
    return { tags, shapes, tracks: [] };
}

function shape(score = 0.9) {
    return {
        label_id: 7,
        frame: 3,
        group: 0,
        source: 'auto',
        type: 'rectangle',
        points: [0, 0, 4, 4],
        rotation: 0,
        score,
        occluded: false,
        outside: false,
        z_order: 0,
        attributes: [],
        elements: [],
    };
}

function create() {
    workers.length = 0;
    timers.clear();
    messages.length = 0;
    notifications.length = 0;
    const commands = [];
    const creations = [];
    const canvasListeners = new Map();
    const lifecycle = { unmounting: false, setStateDuringUnmount: 0 };
    const canvasElement = {
        addEventListener(name, listener) {
            if (!canvasListeners.has(name)) canvasListeners.set(name, new Set());
            canvasListeners.get(name).add(listener);
        },
        removeEventListener(name, listener) {
            canvasListeners.get(name)?.delete(listener);
        },
    };
    const model = { id: 'detector', kind: 'detector', name: 'Detector' };
    const props = {
        canvasInstance: {
            interact: (command) => {
                commands.push(command);
                if (command.enabled === false) {
                    canvasListeners.get('canvas.canceled')?.forEach((listener) => listener());
                }
            },
            html: () => canvasElement,
        },
        isActivated: true,
        interactors: [],
        detectors: [model],
        trackers: [],
        interactorExtras: [],
        labels: [{ id: 7, name: 'damage', type: 'any', attributes: [] }],
        activeLabelID: 7,
        frame: 3,
        states: [],
        currentZOrder: 6,
        frameData: { width: 20, height: 20 },
        jobInstance: { id: 11, taskId: 12, dimension: '2d', labels: [{ id: 7, type: 'any' }] },
        defaultApproxPolyAccuracy: 0,
        toolsBlockerState: { algorithmsLocked: false },
        createAnnotations: (states) => creations.push(states),
        onInteractionStart() {},
    };
    const component = new ToolsControlComponent(props);
    component.setState = (update, callback) => {
        if (lifecycle.unmounting) lifecycle.setStateDuringUnmount++;
        component.state = { ...component.state, ...(typeof update === 'function' ? update(component.state) : update) };
        callback?.();
    };
    return { component, commands, creations, lifecycle, model };
}

function detectorRunner(component) {
    return component.renderDetectorBlock();
}

function find(element, predicate) {
    if (!element || typeof element !== 'object') return undefined;
    if (predicate(element)) return element;
    return React.Children.toArray(element.props?.children).map((child) => find(child, predicate)).find(Boolean);
}

function preview(component) {
    return find(component.render(), (element) => element.type === DetectorPreview);
}

const options = (previewConfidence = true) => ({
    previewConfidence,
    postprocessing: { method: 'disabled', metric: 'ios', threshold: 0.7 },
});
const body = {
    type: 'annotate_task', cleanup: false, conv_mask_to_poly: false, mapping: {}, threshold: 0.1,
};

test('holds preview results, recomputes immutable raw data, and Cancel discards them', async () => {
    const { component, commands, creations, model } = create();
    lambdaCall = async () => makeResult({ shapes: [shape(0.9), shape(0.3)] });

    await detectorRunner(component).props.runInference(model, body, options());

    assert.equal(component.state.detectorPreviewActive, true);
    assert.equal(component.state.detectorConfidence, 0.35);
    assert.equal(component.state.detectorVisibleCount, 1);
    assert.equal(creations.length, 0);
    assert.equal(workers.length, 1);
    const immutableRaw = workers[0].calls[0].shapes;
    preview(component).props.onConfidenceChange(0.8);
    assert.equal(timers.size, 1);
    timers.values().next().value();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(workers[0].calls.length, 2);
    assert.equal(workers[0].calls[1].shapes, immutableRaw);
    preview(component).props.onCancel();
    assert.equal(component.state.detectorPreviewActive, false);
    assert.equal(creations.length, 0);
    assert.deepEqual(commands.at(-1), { enabled: false });
});

test('Done snapshots and creates the displayed shapes and pending tags exactly once', async () => {
    const { component, creations, model } = create();
    lambdaCall = async () => makeResult({
        tags: [{ label_id: 7, frame: 3, source: 'auto', attributes: [] }],
        shapes: [shape()],
    });
    await detectorRunner(component).props.runInference(model, body, options());

    const done = preview(component).props.onDone;
    done();
    done();

    assert.equal(creations.length, 1);
    assert.deepEqual(creations[0].map(({ kind }) => kind), ['tag', 'shape']);
    assert.equal(component.state.detectorPreviewActive, false);
});

test('preview-disabled processing runs once and commits immediately without UI options in the request', async () => {
    const { component, creations, model } = create();
    let requestBody;
    lambdaCall = async (_taskID, _model, request) => {
        requestBody = request;
        return makeResult({ shapes: [shape()] });
    };

    await detectorRunner(component).props.runInference(model, body, options(false));

    assert.equal(workers[0].calls.length, 1);
    assert.equal(workers[0].calls[0].options.confidenceThreshold, null);
    assert.equal(creations.length, 1);
    assert.equal(component.state.detectorPreviewActive, false);
    assert.equal(Object.hasOwn(requestBody, 'cleanup'), false);
    assert.equal(Object.hasOwn(requestBody, 'postprocessing'), false);
    assert.equal(Object.hasOwn(requestBody, 'previewConfidence'), false);
});

test('tag-only preview commits immediately and an empty result reports without creating', async () => {
    const { component, creations, model } = create();
    lambdaCall = async () => makeResult({
        tags: [{ label_id: 7, frame: 3, source: 'auto', attributes: [] }],
    });
    await detectorRunner(component).props.runInference(model, body, options());
    assert.equal(creations.length, 1);
    assert.equal(workers.length, 0);

    lambdaCall = async () => makeResult();
    await detectorRunner(component).props.runInference(model, body, options());
    assert.equal(creations.length, 1);
    assert.ok(messages.some((entry) => String(entry).includes('No detections found')));
});

test('frame navigation invalidates a pending detector response', async () => {
    const { component, creations, model } = create();
    let release;
    lambdaCall = () => new Promise((resolve) => { release = resolve; });
    const request = detectorRunner(component).props.runInference(model, body, options());
    const previousProps = component.props;
    component.props = { ...previousProps, frame: 4 };
    component.componentDidUpdate(previousProps, component.state);
    release(makeResult({ shapes: [shape()] }));
    await request;

    assert.equal(component.state.detectorPreviewActive, false);
    assert.equal(workers.length, 0);
    assert.equal(creations.length, 0);
});

test('starting a fresh detector request does not emit an unrelated canvas cancellation', async () => {
    const { component, commands, model } = create();
    let release;
    lambdaCall = () => new Promise((resolve) => { release = resolve; });

    const request = detectorRunner(component).props.runInference(model, body, options());
    assert.deepEqual(commands, []);
    release(makeResult());
    await request;
});

test('worker errors retain raw results, clear canvas, and Retry restores the current preview', async () => {
    const { component, commands, model } = create();
    lambdaCall = async () => makeResult({ shapes: [shape()] });
    const originalProcess = FakeDetectorPostprocessingClient.prototype.process;
    FakeDetectorPostprocessingClient.prototype.process = async function failOnce(shapes, frame, workerOptions) {
        this.calls.push({ shapes, frame, options: workerOptions });
        this.failure = new Error('worker stopped');
        throw this.failure;
    };
    try {
        await detectorRunner(component).props.runInference(model, body, options());
    } finally {
        FakeDetectorPostprocessingClient.prototype.process = originalProcess;
    }

    assert.equal(component.state.detectorRawCount, 1);
    assert.match(component.state.detectorPreviewError, /worker stopped/);
    assert.deepEqual(commands.at(-1).payload.shapes, []);
    await preview(component).props.onRetry();
    assert.equal(component.state.detectorPreviewError, null);
    assert.equal(component.state.detectorVisibleCount, 1);
});

test('model, tab, AI deactivation, and unmount cancellation all dispose the active session', async () => {
    lambdaCall = async () => makeResult({ shapes: [shape()] });

    let harness = create();
    await detectorRunner(harness.component).props.runInference(harness.model, body, options());
    let worker = workers[0];
    detectorRunner(harness.component).props.onModelChange('other-detector');
    assert.equal(harness.component.state.detectorPreviewActive, false);
    assert.equal(worker.disposed, true);

    harness = create();
    await detectorRunner(harness.component).props.runInference(harness.model, body, options());
    worker = workers[0];
    const tabs = find(harness.component.renderPopoverContent(), (element) => (
        element.props?.activeKey && Array.isArray(element.props?.items)
    ));
    tabs.props.onChange('interactors');
    assert.equal(harness.component.state.detectorPreviewActive, false);
    assert.equal(worker.disposed, true);

    harness = create();
    await detectorRunner(harness.component).props.runInference(harness.model, body, options());
    worker = workers[0];
    const previousProps = harness.component.props;
    harness.component.props = { ...previousProps, isActivated: false };
    harness.component.componentDidUpdate(previousProps, harness.component.state);
    assert.equal(harness.component.state.detectorPreviewActive, false);
    assert.equal(worker.disposed, true);

    harness = create();
    await detectorRunner(harness.component).props.runInference(harness.model, body, options());
    worker = workers[0];
    harness.component.componentWillUnmount();
    assert.equal(worker.disposed, true);
    assert.equal(harness.component.detectorPreview.raw.length, 0);
});

test('unmount removes the canvas cancel listener before disabling detector preview interaction', async () => {
    const harness = create();
    lambdaCall = async () => makeResult({ shapes: [shape()] });
    await detectorRunner(harness.component).props.runInference(harness.model, body, options());
    harness.component.componentDidMount();

    harness.lifecycle.unmounting = true;
    harness.component.componentWillUnmount();

    assert.equal(harness.lifecycle.setStateDuringUnmount, 0);
});

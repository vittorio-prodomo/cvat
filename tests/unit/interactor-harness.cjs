// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
// Run with: node tests/unit/interactor-text-prompts.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');

const root = path.resolve(__dirname, '../..');
const core = {
    plugins: { register() {} },
    lambda: { call: async () => ({ shapes: [] }) },
    classes: { ObjectState: class { constructor(data) { Object.assign(this, data); } } },
    enums: { Source: { SEMI_AUTO: 'semi-auto' } },
};
const messages = [];
const dependencies = {
    react: React,
    'react-dom': { createPortal: (content) => content },
    lodash: require('lodash'),
    'react-redux': { connect: () => (component) => component },
    'cvat-core-wrapper': {
        getCore: () => core, DimensionType: { DIMENSION_2D: '2d' },
        ShapeType: { MASK: 'mask', POLYGON: 'polygon' }, ObjectType: { SHAPE: 'shape' },
    },
    'antd/lib/select': Object.assign(() => null, { Option: () => null }),
    'antd/lib/radio': { Group: () => null, Button: () => null },
    'antd/lib/grid': { Row: 'div', Col: 'div' },
    'antd/lib/message': { loading: () => () => {}, info: (value) => { messages.push(value); return () => {}; } },
    'antd/lib/notification': { error: (value) => messages.push(value), warning: (value) => messages.push(value) },
    './handle-popover-visibility': (component) => component,
    '@ant-design/icons': { QuestionCircleOutlined: () => null },
};
for (const name of ['button', 'input', 'popover', 'switch', 'divider', 'typography/Text']) {
    dependencies[`antd/lib/${name}`] = () => null;
}
for (const name of ['components/common/cvat-tooltip', 'components/label-selector/label-selector',
    'components/model-runner-modal/region-of-interest-input', './interactor-tooltips']) {
    dependencies[name] = () => null;
}
function load(relativePath) {
    const filename = path.join(root, relativePath);
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        fileName: filename,
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
            jsx: ts.JsxEmit.React, esModuleInterop: true },
    }).outputText;
    const mod = { exports: {} };
    vm.compileFunction(output, ['require', 'module', 'exports', 'localStorage', 'window'], { filename })(
        (name) => dependencies[name] || {}, mod, mod.exports, { getItem: () => null, setItem() {} },
        { addEventListener() {}, removeEventListener() {}, document: { getElementsByClassName: () => [{}] } },
    );
    return mod.exports;
}
dependencies['cvat-canvas-wrapper'] = load('cvat-ui/src/cvat-canvas-wrapper.ts');
dependencies['components/common/model-extra-params-form'] = load('cvat-ui/src/components/common/model-extra-params-form.tsx');
const { ToolsControlComponent } = load('cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx');
const textSchema = {
    name: 'text_prompt',
    type: 'text',
    default: '',
    max_length: 256,
    supports_mask_refinement: true,
    supports_concept_box: true,
};

function create({ activated = false, blocked = false, schema = [textSchema], promptMode = 'concept' } = {}) {
    const commands = [];
    const requests = [];
    const annotations = [];
    const interactor = { id: 'sam3', name: 'SAM3', version: 2, labels: [], extraParamsSchema: schema,
        params: { canvas: { minPosVertices: 0, minNegVertices: 0, startWithBoxOptional: true } } };
    const props = {
        canvasInstance: { interact: (command) => commands.push(command), cancel: () => commands.push({ cancel: true }) },
        isActivated: activated, interactors: [interactor], trackers: [], interactorExtras: [],
        labels: [{ id: 7, name: 'defect' }], activeLabelID: 7, frame: 3, states: [], currentZOrder: 0,
        frameData: { width: 300, height: 300 },
        jobInstance: { id: 336, taskId: 297, dimension: '2d' }, defaultApproxPolyAccuracy: 0,
        toolsBlockerState: { algorithmsLocked: blocked }, createAnnotations: (objects) => annotations.push(...objects),
        onInteractionStart: () => {
            const previous = component.props;
            component.props = { ...previous, isActivated: true };
            component.componentDidUpdate(previous, component.state);
        },
    };
    const component = new ToolsControlComponent(props);
    component.setState = (update, callback) => {
        component.state = { ...component.state, ...(typeof update === 'function' ? update(component.state) : update) };
        callback?.();
    };
    const realRun = component.runInteractionRequest;
    component.runInteractionRequest = () => requests.push(component.interaction.latestRequest);
    if (promptMode !== null) component.state.interactorPromptMode = promptMode;
    component.state.conceptUsesBox = false;
    component.state.interactorExtraParams = { text_prompt: '  red circles  ' };
    component.state.interactorExtraParamsTouched = { text_prompt: true };
    return { component, commands, requests, annotations, realRun };
}
function find(element, predicate) {
    if (!element || typeof element !== 'object') return undefined;
    if (predicate(element)) return element;
    return React.Children.toArray(element.props?.children).map((child) => find(child, predicate)).find(Boolean);
}
function button(component) {
    return find(component.renderInteractorBlock(), (element) => element.props?.className === 'cvat-tools-interact-button');
}
function changeProps(component, update) {
    const previous = component.props;
    component.props = { ...previous, ...update };
    component.componentDidUpdate(previous, component.state);
}
const event = (shapes = [], finished = false) => ({ detail: { shapes, finished } });


module.exports = {
    create, core, event, button, changeProps, find, dependencies, textSchema, load, messages, ToolsControlComponent,
};

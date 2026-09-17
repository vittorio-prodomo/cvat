// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
// Run with: node --test tests/unit/clean-image-mode.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const ActiveControl = {
    CURSOR: 'cursor',
    DRAG_CANVAS: 'drag_canvas',
    ZOOM_CANVAS: 'zoom_canvas',
    DRAW_RECTANGLE: 'draw_rectangle',
    DRAW_POLYGON: 'draw_polygon',
    DRAW_MASK: 'draw_mask',
    EDIT: 'edit',
    GROUP: 'group',
    MERGE: 'merge',
    JOIN: 'join',
    SPLIT: 'split',
    SLICE: 'slice',
    OPEN_ISSUE: 'open_issue',
    AI_TOOLS: 'ai_tools',
    OPENCV_TOOLS: 'opencv_tools',
};

const CanvasMode = {
    IDLE: 'idle',
    DRAG_CANVAS: 'drag_canvas',
    ZOOM_CANVAS: 'zoom_canvas',
    DRAW: 'draw',
    EDIT: 'edit',
    RESIZE: 'resize',
    INTERACT: 'interact',
    SELECT_REGION: 'select_region',
};

class Canvas {
    constructor(mode = CanvasMode.IDLE) {
        this.currentMode = mode;
        this.cancelCalls = 0;
    }

    mode() {
        return this.currentMode;
    }

    cancel() {
        this.cancelCalls += 1;
    }
}

function loadCleanImageMode() {
    const filename = path.resolve(__dirname, '../../cvat-ui/src/utils/clean-image-mode.ts');
    const mod = { exports: {} };
    const stubs = {
        reducers: { ActiveControl },
        'cvat-canvas-wrapper': { CanvasMode },
    };
    const requireStub = (request) => {
        if (request in stubs) return stubs[request];
        throw new Error(`Unexpected module request: ${request}`);
    };

    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, {
        module: mod,
        exports: mod.exports,
        require: requireStub,
    });

    return mod.exports;
}

function loadCanvasCleanImageMode() {
    const filename = path.resolve(__dirname, '../../cvat-canvas/src/typescript/cleanImageMode.ts');
    const mod = { exports: {} };

    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, {
        module: mod,
        exports: mod.exports,
    });

    return mod.exports;
}

function loadCanvasWrapper() {
    const filename = path.resolve(
        __dirname,
        '../../cvat-ui/src/components/annotation-page/canvas/views/canvas2d/canvas-wrapper.tsx',
    );
    const mod = { exports: {} };
    class PureComponent {
        constructor(props) {
            this.props = props;
        }
    }
    const react = {
        __esModule: true,
        default: {
            PureComponent,
            createRef: () => ({ current: null }),
        },
    };
    const stubs = {
        react,
        'react-redux': { connect: () => (component) => component },
        'lodash/debounce': { __esModule: true, default: (fn) => fn },
        'cvat-core-wrapper': { getCore: () => ({}) },
        'actions/shortcuts-actions': { registerComponentShortcuts: () => {} },
        'utils/enums': { ShortcutScope: { STANDARD_WORKSPACE: 'standard', ANNOTATION_PAGE: 'annotation' } },
        reducers: { Workspace: { ATTRIBUTES: 'attributes' } },
        config: { __esModule: true, default: { UNDEFINED_ATTRIBUTE_VALUE: 'undefined' } },
    };
    const requireStub = (request) => stubs[request] || {};

    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: {
            jsx: ts.JsxEmit.React,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
        },
    }).outputText, {
        module: mod,
        exports: mod.exports,
        require: requireStub,
    });

    return mod.exports.default;
}

function loadIssueAggregator(state, dispatchedActions, effects) {
    const filename = path.resolve(
        __dirname,
        '../../cvat-ui/src/components/annotation-page/review/issues-aggregator.tsx',
    );
    const mod = { exports: {} };
    const hookState = [];
    let hookIndex = 0;
    const react = {
        __esModule: true,
        default: {
            createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
        },
        useState: (initialValue) => {
            const index = hookIndex++;
            if (!(index in hookState)) hookState[index] = initialValue;
            return [hookState[index], (value) => { hookState[index] = value; }];
        },
        useEffect: (effect) => effects.push(effect),
        useCallback: (callback) => callback,
    };
    const stubs = {
        react,
        'react-redux': {
            useSelector: (selector) => selector(state),
            useDispatch: () => (action) => dispatchedActions.push(action),
        },
        'utils/redux': { shallowEqual: () => true },
        'utils/get-hidden-z-layers': { __esModule: true, default: () => new Set() },
        reducers: {
            ActiveControl,
            NewIssueSource: { ISSUE_TOOL: 'issue_tool' },
        },
        'actions/annotation-actions': {
            highlightConflict: (conflict) => ({ type: 'highlight', conflict }),
            updateActiveControl: () => ({}),
        },
        'cvat-canvas-wrapper': { Canvas, CanvasMode },
        './conflict-label': { default: 'ConflictLabel' },
    };
    const requireStub = (request) => stubs[request] || {};

    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: {
            jsx: ts.JsxEmit.React,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
        },
    }).outputText, {
        module: mod,
        exports: mod.exports,
        require: requireStub,
        window: { document: { getElementById: () => null } },
    });

    return () => {
        hookIndex = 0;
        return mod.exports.default();
    };
}

function loadComponentSubKeyMap() {
    const filename = path.resolve(__dirname, '../../cvat-ui/src/utils/component-subkeymap.ts');
    const mod = { exports: {} };

    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, {
        module: mod,
        exports: mod.exports,
        require: () => ({}),
    });

    return mod.exports.subKeyMap;
}

function loadCleanImageModeControl(state, dispatchedActions, warnings) {
    const filename = path.resolve(
        __dirname,
        '../../cvat-ui/src/components/annotation-page/top-bar/clean-image-mode-control.tsx',
    );
    const mod = { exports: {} };
    const registrations = [];
    const notificationWarnings = warnings || [];
    const { canEnterCleanImageMode } = loadCleanImageMode();
    const subKeyMap = loadComponentSubKeyMap();
    function Button() {}
    function CVATTooltip() {}
    function GlobalHotKeys() {}
    function EyeInvisibleOutlined() {}
    const react = {
        __esModule: true,
        default: {
            createElement: (type, props, ...children) => ({
                type,
                props: { ...props, children },
            }),
            memo: (component) => component,
        },
    };
    const stubs = {
        react,
        'react-redux': {
            useSelector: (selector) => selector(state),
            useDispatch: () => (action) => dispatchedActions.push(action),
        },
        'utils/redux': { shallowEqual: () => true },
        '@ant-design/icons': { EyeInvisibleOutlined },
        'antd/lib/button': { __esModule: true, default: Button },
        'antd/lib/notification': {
            __esModule: true,
            default: { warning: (configuration) => notificationWarnings.push(configuration) },
        },
        'cvat-core-wrapper': { DimensionType: { DIMENSION_2D: '2d', DIMENSION_3D: '3d' } },
        'cvat-canvas-wrapper': { Canvas },
        reducers: {},
        'actions/shortcuts-actions': {
            registerComponentShortcuts: (shortcuts) => registrations.push(shortcuts),
        },
        'actions/annotation-actions': {
            switchCleanImageMode: (enabled) => ({ type: 'switch-clean-image-mode', enabled }),
        },
        'components/common/cvat-tooltip': { __esModule: true, default: CVATTooltip },
        'utils/mousetrap-react': { __esModule: true, default: GlobalHotKeys },
        'utils/enums': { ShortcutScope: { ANNOTATION_PAGE: 'ANNOTATION_PAGE' } },
        'utils/component-subkeymap': { subKeyMap },
        'utils/clean-image-mode': { canEnterCleanImageMode },
    };
    const requireStub = (request) => {
        if (request in stubs) return stubs[request];
        throw new Error(`Unexpected module request: ${request}`);
    };

    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: {
            jsx: ts.JsxEmit.React,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
        },
    }).outputText, {
        module: mod,
        exports: mod.exports,
        require: requireStub,
    });

    return {
        ...mod.exports,
        registrations,
        elements: { Button, CVATTooltip, GlobalHotKeys, EyeInvisibleOutlined },
    };
}

function flattenElements(node) {
    if (Array.isArray(node)) return node.flatMap(flattenElements);
    if (!node || typeof node !== 'object') return [];
    return [node, ...((node.props?.children || []).flatMap(flattenElements))];
}

function cleanImageModeState({ cleanImageMode = false, dimension = '2d', mediaType = 'images' } = {}) {
    return {
        shortcuts: {
            keyMap: {
                TOGGLE_CLEAN_IMAGE_MODE: {
                    name: 'Toggle clean image mode',
                    description: 'Temporarily show only the source image and hide annotation and review overlays',
                    sequences: ['shift+h'],
                    scope: 'ANNOTATION_PAGE',
                },
            },
            normalizedKeyMap: { TOGGLE_CLEAN_IMAGE_MODE: 'Shift+H' },
        },
        annotation: {
            canvas: {
                cleanImageMode,
                detectorInferencePending: false,
                activeControl: ActiveControl.CURSOR,
                instance: new Canvas(),
            },
            editing: { objectState: null },
            job: { instance: { dimension, mediaType } },
        },
    };
}

function renderedCleanImageModeControl(loaded) {
    return flattenElements(loaded.CleanImageModeControl());
}

function cleanImageModeHotkeys(loaded) {
    return renderedCleanImageModeControl(loaded).find((element) => element.type === loaded.elements.GlobalHotKeys);
}

test('allows clean-image mode only during safe canvas activity', () => {
    const { canEnterCleanImageMode } = loadCleanImageMode();

    assert.equal(canEnterCleanImageMode(ActiveControl.CURSOR, CanvasMode.IDLE, false), true);
    assert.equal(canEnterCleanImageMode(ActiveControl.DRAG_CANVAS, CanvasMode.DRAG_CANVAS, false), true);
    assert.equal(canEnterCleanImageMode(ActiveControl.ZOOM_CANVAS, CanvasMode.ZOOM_CANVAS, false), true);
});

test('refuses clean-image mode for mutating active controls', () => {
    const { canEnterCleanImageMode } = loadCleanImageMode();
    const refusedControls = [
        ActiveControl.DRAW_RECTANGLE,
        ActiveControl.DRAW_POLYGON,
        ActiveControl.DRAW_MASK,
        ActiveControl.EDIT,
        ActiveControl.GROUP,
        ActiveControl.MERGE,
        ActiveControl.JOIN,
        ActiveControl.SPLIT,
        ActiveControl.SLICE,
        ActiveControl.OPEN_ISSUE,
        ActiveControl.AI_TOOLS,
        ActiveControl.OPENCV_TOOLS,
    ];

    for (const activeControl of refusedControls) {
        assert.equal(canEnterCleanImageMode(activeControl, CanvasMode.IDLE, false), false, activeControl);
    }
});

test('refuses clean-image mode for unsafe canvas modes and pending edits', () => {
    const { canEnterCleanImageMode } = loadCleanImageMode();

    for (const canvasMode of [
        CanvasMode.DRAW,
        CanvasMode.EDIT,
        CanvasMode.RESIZE,
        CanvasMode.INTERACT,
        CanvasMode.SELECT_REGION,
    ]) {
        assert.equal(canEnterCleanImageMode(ActiveControl.CURSOR, canvasMode, false), false, canvasMode);
    }

    assert.equal(canEnterCleanImageMode(ActiveControl.CURSOR, CanvasMode.IDLE, true), false);
});

test('clean-image transition policy preserves enabled mode for safe cursor, pan, and zoom controls', () => {
    const { shouldKeepCleanImageMode } = loadCleanImageMode();

    assert.equal(shouldKeepCleanImageMode(true, ActiveControl.CURSOR, false), true);
    assert.equal(shouldKeepCleanImageMode(true, ActiveControl.DRAG_CANVAS, false), true);
    assert.equal(shouldKeepCleanImageMode(true, ActiveControl.ZOOM_CANVAS, false), true);
});

test('clean-image transition policy clears enabled mode for unsafe draw and interaction controls', () => {
    const { shouldKeepCleanImageMode } = loadCleanImageMode();

    for (const activeControl of [
        ActiveControl.DRAW_RECTANGLE,
        ActiveControl.AI_TOOLS,
        ActiveControl.OPENCV_TOOLS,
    ]) {
        assert.equal(shouldKeepCleanImageMode(true, activeControl, false), false);
    }
});

test('clean-image transition policy clears mode when REMEMBER_OBJECT starts drawing', () => {
    const { shouldKeepCleanImageMode } = loadCleanImageMode();

    assert.equal(shouldKeepCleanImageMode(true, ActiveControl.DRAW_POLYGON, true), false);
});

test('clean-image transition policy clears mode when REMEMBER_OBJECT creates a tag with CURSOR', () => {
    const { shouldKeepCleanImageMode } = loadCleanImageMode();

    assert.equal(shouldKeepCleanImageMode(true, ActiveControl.CURSOR, true), false);
});

test('clean-image transition policy clears mode when repeat or paste starts annotation work', () => {
    const { shouldKeepCleanImageMode } = loadCleanImageMode();

    for (const activeControl of [ActiveControl.DRAW_RECTANGLE, ActiveControl.CURSOR]) {
        assert.equal(shouldKeepCleanImageMode(true, activeControl, true), false);
    }
});

test('clean-image transition policy keeps disabled mode disabled', () => {
    const { shouldKeepCleanImageMode } = loadCleanImageMode();

    assert.equal(shouldKeepCleanImageMode(false, ActiveControl.CURSOR, false), false);
    assert.equal(shouldKeepCleanImageMode(false, ActiveControl.DRAW_MASK, true), false);
});

test('hides and restores every annotation overlay without changing the source background', () => {
    const { applyCleanImageMode } = loadCanvasCleanImageMode();
    const sourceBackground = { style: { visibility: 'source' } };
    const contentClasses = {};
    const roots = {
        text: { style: { visibility: '' } },
        masks: { style: { visibility: '' } },
        bitmap: { style: { visibility: '' } },
        grid: { style: { visibility: '' } },
        content: { style: { visibility: '' }, classList: { toggle: (name, enabled) => { contentClasses[name] = enabled; } } },
        attachments: { style: { visibility: '' } },
    };

    applyCleanImageMode(roots, true);

    assert.equal(roots.content.style.visibility, '');
    assert.equal(contentClasses.cvat_canvas_clean_image, true);
    for (const [name, root] of Object.entries(roots)) {
        if (name !== 'content') assert.equal(root.style.visibility, 'hidden');
    }
    assert.equal(sourceBackground.style.visibility, 'source');

    applyCleanImageMode(roots, false);
    assert.equal(contentClasses.cvat_canvas_clean_image, false);

    for (const root of Object.values(roots)) {
        assert.equal(root.style.visibility, '');
    }
    assert.equal(sourceBackground.style.visibility, 'source');
});

test('reconfigures the canvas when only clean-image mode changes', () => {
    const CanvasWrapper = loadCanvasWrapper();
    const configureCalls = [];
    const props = {
        canvasInstance: { configure: (configuration) => configureCalls.push(configuration) },
        opacity: 0.5,
        selectedOpacity: 0.5,
        outlined: false,
        outlineColor: '',
        showBitmap: true,
        frameData: {},
        frameAngle: 0,
        annotations: [],
        activatedStateID: null,
        hiddenZLayers: new Set(),
        resetZoom: false,
        smoothImage: false,
        grid: false,
        gridSize: 100,
        gridOpacity: 1,
        gridColor: 'White',
        brightnessLevel: 1,
        contrastLevel: 1,
        saturationLevel: 1,
        showObjectsTextAlways: false,
        textFontSize: 12,
        controlPointsSize: 5,
        textPosition: 'auto',
        textContent: '',
        showAllInterpolationTracks: false,
        automaticBordering: false,
        snapToPoint: false,
        adaptiveZoom: false,
        intelligentPolygonCrop: false,
        showProjections: false,
        colorBy: 'Label',
        onFetchAnnotation: () => {},
        showGroundTruth: false,
        highlightedConflict: null,
        imageFilters: [],
        focusedObjectPadding: 0,
        renderData: {},
        cleanImageMode: true,
    };
    const wrapper = new CanvasWrapper(props);

    wrapper.componentDidUpdate({ ...props, cleanImageMode: false });

    assert.equal(configureCalls.length, 1);
    assert.equal(configureCalls[0].cleanImageMode, true);
});

test('clears a highlighted conflict when clean-image mode starts', () => {
    const effects = [];
    const dispatchedActions = [];
    const highlightedConflict = { annotationConflicts: [] };
    const state = {
        review: {
            frameIssues: [],
            issuesHidden: false,
            issuesResolvedHidden: false,
            newIssue: { position: null, source: null },
            fetching: { issueId: null },
            frameConflicts: [],
        },
        annotation: {
            canvas: { instance: null, ready: false, activeControl: ActiveControl.CURSOR, cleanImageMode: true },
            annotations: { states: [], highlightedConflict },
        },
        settings: { shapes: { showGroundTruth: false } },
    };
    const IssueAggregator = loadIssueAggregator(state, dispatchedActions, effects);

    IssueAggregator();
    effects.forEach((effect) => effect());

    assert.deepEqual(dispatchedActions, [{ type: 'highlight', conflict: null }]);
});

test('registers the clean-image shortcut metadata once', () => {
    const loaded = loadCleanImageModeControl(cleanImageModeState(), []);

    assert.deepEqual(Array.from(loaded.cleanImageModeShortcuts.TOGGLE_CLEAN_IMAGE_MODE.sequences), ['shift+h']);
    assert.equal(loaded.cleanImageModeShortcuts.TOGGLE_CLEAN_IMAGE_MODE.scope, 'ANNOTATION_PAGE');
    assert.equal(loaded.cleanImageModeShortcuts.TOGGLE_CLEAN_IMAGE_MODE.name, 'Toggle clean image mode');
    assert.equal(loaded.registrations.length, 1);
    assert.strictEqual(loaded.registrations[0], loaded.cleanImageModeShortcuts);
});

test('shows an inactive clean-image button alongside its hotkey for 2D jobs', () => {
    const state = cleanImageModeState();
    const loaded = loadCleanImageModeControl(state, []);
    const elements = renderedCleanImageModeControl(loaded);
    const hotkeys = cleanImageModeHotkeys(loaded);
    const button = elements.find((element) => element.type === loaded.elements.Button);
    const tooltip = elements.find((element) => element.type === loaded.elements.CVATTooltip);

    assert.ok(elements.some((element) => element.type === loaded.elements.GlobalHotKeys));
    assert.ok(button);
    assert.equal(button.props['aria-pressed'], false);
    assert.equal(button.props.className, 'cvat-clean-image-mode-indicator cvat-annotation-header-button');
    assert.equal(tooltip.props.overlay, 'Show only the source image · Shift+H to activate');
    assert.strictEqual(hotkeys.props.keyMap.TOGGLE_CLEAN_IMAGE_MODE, state.shortcuts.keyMap.TOGGLE_CLEAN_IMAGE_MODE);
});

test('shows the active clean-image indicator with its current shortcut binding', () => {
    const loaded = loadCleanImageModeControl(cleanImageModeState({ cleanImageMode: true }), []);
    const output = loaded.CleanImageModeControl();
    const elements = flattenElements(output);
    const indicator = elements.find((element) => element.type === loaded.elements.Button);
    const tooltip = elements.find((element) => element.type === loaded.elements.CVATTooltip);

    assert.equal(indicator.props['aria-pressed'], true);
    assert.equal(
        indicator.props.className,
        'cvat-clean-image-mode-indicator cvat-annotation-header-button cvat-button-active',
    );
    assert.equal(indicator.props.children[0].type, loaded.elements.EyeInvisibleOutlined);
    assert.equal(indicator.props.children[1], 'Clean');
    assert.equal(
        tooltip.props.overlay,
        'Annotations and review overlays are temporarily hidden · Shift+H to restore',
    );
});

test('does not render the clean-image control for non-2D jobs', () => {
    const loaded = loadCleanImageModeControl(cleanImageModeState({ dimension: '3d' }), []);

    assert.equal(loaded.CleanImageModeControl(), null);
});

test('enters clean-image mode through the registered safe shortcut handler', () => {
    const dispatchedActions = [];
    const warnings = [];
    const loaded = loadCleanImageModeControl(cleanImageModeState(), dispatchedActions, warnings);
    const hotkeys = cleanImageModeHotkeys(loaded);
    let prevented = false;

    hotkeys.props.handlers.TOGGLE_CLEAN_IMAGE_MODE({
        repeat: false,
        preventDefault: () => { prevented = true; },
    });

    assert.equal(prevented, true);
    assert.deepEqual(dispatchedActions, [{ type: 'switch-clean-image-mode', enabled: true }]);
    assert.deepEqual(warnings, []);
});

test('ignores repeated clean-image shortcut keydown events', () => {
    const dispatchedActions = [];
    const warnings = [];
    const loaded = loadCleanImageModeControl(cleanImageModeState(), dispatchedActions, warnings);
    const hotkeys = cleanImageModeHotkeys(loaded);

    hotkeys.props.handlers.TOGGLE_CLEAN_IMAGE_MODE({ repeat: true, preventDefault: () => {} });

    assert.deepEqual(dispatchedActions, []);
    assert.deepEqual(warnings, []);
});

test('warns without cancelling or dispatching when clean-image entry is unsafe', () => {
    const dispatchedActions = [];
    const warnings = [];
    const state = cleanImageModeState();
    const canvas = new Canvas(CanvasMode.DRAW);
    state.annotation.canvas.instance = canvas;
    const loaded = loadCleanImageModeControl(state, dispatchedActions, warnings);

    cleanImageModeHotkeys(loaded).props.handlers.TOGGLE_CLEAN_IMAGE_MODE({ repeat: false, preventDefault: () => {} });

    assert.deepEqual(dispatchedActions, []);
    assert.equal(canvas.cancelCalls, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].key, 'clean-image-mode-operation-warning');
    assert.equal(warnings[0].message, 'Finish or cancel the current canvas operation before entering clean-image mode.');
});

test('exits clean-image mode through an active shortcut even when canvas state is unsafe', () => {
    const dispatchedActions = [];
    const warnings = [];
    const state = cleanImageModeState({ cleanImageMode: true });
    state.annotation.canvas.activeControl = ActiveControl.DRAW_RECTANGLE;
    state.annotation.canvas.instance = null;
    const loaded = loadCleanImageModeControl(state, dispatchedActions, warnings);

    cleanImageModeHotkeys(loaded).props.handlers.TOGGLE_CLEAN_IMAGE_MODE({ repeat: false, preventDefault: () => {} });

    assert.deepEqual(dispatchedActions, [{ type: 'switch-clean-image-mode', enabled: false }]);
    assert.deepEqual(warnings, []);
});

test('exits clean-image mode through the active indicator button', () => {
    const dispatchedActions = [];
    const loaded = loadCleanImageModeControl(cleanImageModeState({ cleanImageMode: true }), dispatchedActions, []);
    const indicator = renderedCleanImageModeControl(loaded).find((element) => element.type === loaded.elements.Button);

    indicator.props.onClick();

    assert.deepEqual(dispatchedActions, [{ type: 'switch-clean-image-mode', enabled: false }]);
});

test('enters clean-image mode through the inactive button', () => {
    const dispatchedActions = [];
    const warnings = [];
    const loaded = loadCleanImageModeControl(cleanImageModeState(), dispatchedActions, warnings);
    const button = renderedCleanImageModeControl(loaded).find((element) => element.type === loaded.elements.Button);

    button.props.onClick();

    assert.deepEqual(dispatchedActions, [{ type: 'switch-clean-image-mode', enabled: true }]);
    assert.deepEqual(warnings, []);
});

test('refuses button activation during an active drawing operation', () => {
    const dispatchedActions = [];
    const warnings = [];
    const state = cleanImageModeState();
    state.annotation.canvas.instance = new Canvas(CanvasMode.DRAW);
    const loaded = loadCleanImageModeControl(state, dispatchedActions, warnings);
    const button = renderedCleanImageModeControl(loaded).find((element) => element.type === loaded.elements.Button);

    button.props.onClick();

    assert.deepEqual(dispatchedActions, []);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].message, 'Finish or cancel the current canvas operation before entering clean-image mode.');
});

test('uses a click fallback when the clean-image shortcut has no normalized binding', () => {
    for (const binding of ['', undefined]) {
        const state = cleanImageModeState({ cleanImageMode: true });
        state.shortcuts.normalizedKeyMap.TOGGLE_CLEAN_IMAGE_MODE = binding;
        const loaded = loadCleanImageModeControl(state, []);
        const tooltip = renderedCleanImageModeControl(loaded)
            .find((element) => element.type === loaded.elements.CVATTooltip);

        assert.equal(tooltip.props.overlay, 'Annotations and review overlays are temporarily hidden · Click to restore');
    }
});


function loadAnnotationReducer() {
    const filename = path.resolve(__dirname, '../../cvat-ui/src/reducers/annotation-reducer.ts');
    const mod = { exports: {} };
    const enums = new Proxy({}, { get: (_, name) => name });
    const dependencies = {
        lodash: { __esModule: true, default: require('lodash') },
        'actions/annotation-actions': { AnnotationActionTypes: enums },
        'actions/jobs-actions': { JobsActionTypes: enums },
        'actions/auth-actions': { AuthActionTypes: enums },
        'actions/boundaries-actions': { BoundariesActionTypes: enums },
        'actions/review-actions': { ReviewActionTypes: enums },
        'cvat-canvas-wrapper': { Canvas, CanvasMode },
        'cvat-canvas3d-wrapper': {},
        'utils/clean-image-mode': loadCleanImageMode(),
        'cvat-core-wrapper': {
            getCore: () => ({ utils: { getVisibleSkeletonElements: () => ({}) } }),
            ObjectType: { TAG: 'tag', SHAPE: 'shape' },
            ShapeType: { RECTANGLE: 'rectangle', POLYGON: 'polygon' },
        },
        '.': { ActiveControl, ContextMenuType: enums, NavigationType: enums, Workspace: enums },
    };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, { module: mod, exports: mod.exports, require: (name) => dependencies[name] || {} });
    return mod.exports.default;
}

const reduceAnnotation = loadAnnotationReducer();
const action = (type, payload = {}) => ({ type, payload });
const initialAnnotation = () => require('lodash').cloneDeep(reduceAnnotation(undefined, action('INIT')));
const enabledAnnotation = () => reduceAnnotation(initialAnnotation(), action('SWITCH_CLEAN_IMAGE_MODE', { enabled: true }));

test('actual reducer toggles clean mode and closes an existing context menu', () => {
    const before = initialAnnotation();
    before.canvas = { ...before.canvas, contextMenu: { ...before.canvas.contextMenu, visible: true, clientID: 42 } };
    const enabled = reduceAnnotation(before, action('SWITCH_CLEAN_IMAGE_MODE', { enabled: true }));
    assert.equal(enabled.canvas.cleanImageMode, true);
    assert.equal(enabled.canvas.contextMenu.visible, false);
    assert.equal(enabled.canvas.contextMenu.clientID, null);
    assert.equal(reduceAnnotation(enabled, action('SWITCH_CLEAN_IMAGE_MODE', { enabled: false })).canvas.cleanImageMode, false);
});

test('actual reducer preserves clean mode during frame loading and successful navigation', () => {
    const loading = reduceAnnotation(enabledAnnotation(), action('CHANGE_FRAME'));
    assert.equal(loading.canvas.cleanImageMode, true);
    const loaded = reduceAnnotation(loading, action('CHANGE_FRAME_SUCCESS', { number: 4, states: [], history: {} }));
    assert.equal(loaded.canvas.cleanImageMode, true);
    assert.equal(loaded.player.frame.number, 4);
});

test('actual reducer resets transient clean and detector pending state on close and logout', () => {
    for (const type of ['CLOSE_JOB', 'LOGOUT_SUCCESS']) {
        const before = enabledAnnotation();
        before.canvas = { ...before.canvas, detectorInferencePending: true };
        const after = reduceAnnotation(before, action(type));
        assert.equal(after.canvas.cleanImageMode, false, type);
        assert.equal(after.canvas.detectorInferencePending, false, type);
    }
});

test('actual reducer exits clean mode on every drawing, editing, paste, and interaction transition', () => {
    const transitions = [
        action('REMEMBER_OBJECT', { updateCurrentControl: true, activeShapeType: 'polygon' }),
        action('REMEMBER_OBJECT', { updateCurrentControl: true, activeObjectType: 'tag' }),
        action('REPEAT_DRAW_SHAPE', { activeControl: ActiveControl.DRAW_RECTANGLE }),
        action('REPEAT_DRAW_SHAPE', { activeControl: ActiveControl.CURSOR }),
        action('PASTE_SHAPE', { activeControl: ActiveControl.DRAW_RECTANGLE }),
        action('PASTE_SHAPE', { activeControl: ActiveControl.CURSOR }),
        action('UPDATE_EDITED_STATE', { objectState: { clientID: 42 } }),
        ...['detector', 'opencv_interactor'].map((kind) => action('INTERACT_WITH_CANVAS', { activeInteractor: { kind } })),
        ...Object.values(ActiveControl).filter((control) => !['cursor', 'drag_canvas', 'zoom_canvas'].includes(control))
            .map((activeControl) => action('UPDATE_ACTIVE_CONTROL', { activeControl })),
    ];
    for (const transition of transitions) {
        assert.equal(reduceAnnotation(enabledAnnotation(), transition).canvas.cleanImageMode, false, JSON.stringify(transition));
    }
    for (const activeControl of [ActiveControl.CURSOR, ActiveControl.DRAG_CANVAS, ActiveControl.ZOOM_CANVAS]) {
        assert.equal(reduceAnnotation(enabledAnnotation(), action('UPDATE_ACTIVE_CONTROL', { activeControl })).canvas.cleanImageMode, true);
    }
});

test('detector inference synchronously exits clean mode and blocks reducer entry until completion', () => {
    const pending = reduceAnnotation(enabledAnnotation(), action('SET_DETECTOR_INFERENCE_PENDING', { operationID: 'test', pending: true }));
    assert.equal(pending.canvas.cleanImageMode, false);
    assert.equal(pending.canvas.detectorInferencePending, true);
    assert.equal(reduceAnnotation(pending, action('SWITCH_CLEAN_IMAGE_MODE', { enabled: true })).canvas.cleanImageMode, false);
    const finished = reduceAnnotation(pending, action('SET_DETECTOR_INFERENCE_PENDING', { operationID: 'test', pending: false }));
    assert.equal(finished.canvas.detectorInferencePending, false);
    assert.equal(reduceAnnotation(finished, action('SWITCH_CLEAN_IMAGE_MODE', { enabled: true })).canvas.cleanImageMode, true);
});

test('pending detector inference blocks clean entry in both guard and shortcut control', () => {
    assert.equal(loadCleanImageMode().canEnterCleanImageMode(ActiveControl.CURSOR, CanvasMode.IDLE, false, true), false);
    const state = cleanImageModeState();
    state.annotation.canvas.detectorInferencePending = true;
    const dispatched = [];
    const warnings = [];
    const loaded = loadCleanImageModeControl(state, dispatched, warnings);
    cleanImageModeHotkeys(loaded).props.handlers.TOGGLE_CLEAN_IMAGE_MODE({ preventDefault() {} });
    assert.equal(dispatched.length, 0);
    assert.equal(warnings.length, 1);
});


test('clean mode preserves preexisting root visibility across repeated configuration and restore', () => {
    const { applyCleanImageMode } = loadCanvasCleanImageMode();
    const roots = Object.fromEntries(['text', 'masks', 'bitmap', 'grid', 'content', 'attachments']
        .map((name) => [name, { style: { visibility: name === 'grid' ? 'hidden' : 'visible' }, classList: { toggle() {} } }]));
    applyCleanImageMode(roots, true);
    applyCleanImageMode(roots, true);
    applyCleanImageMode(roots, false);
    assert.equal(roots.grid.style.visibility, 'hidden');
    assert.equal(roots.text.style.visibility, 'visible');
});

function zoomHarness() {
    const listeners = new Map();
    const attributes = {};
    let removed = 0;
    const node = {
        addEventListener: (name, handler) => listeners.set(name, handler),
        removeEventListener: (name, handler) => {
            if (listeners.get(name) === handler) listeners.delete(name);
        },
    };
    const rect = {
        addClass: () => rect,
        attr: (values) => Object.assign(attributes, values),
        remove: () => { removed++; },
    };
    const canvas = { node, rect: () => rect };
    const mod = { exports: {} };
    const source = fs.readFileSync(path.resolve(__dirname, '../../cvat-canvas/src/typescript/zoomHandler.ts'), 'utf8');
    const dependencies = {
        './consts': { default: { BASE_STROKE_WIDTH: 2 } },
        './shared': { translateToSVG: (target, [x, y]) => {
            assert.strictEqual(target, node);
            return [(x - 10) / 2, (y - 20) / 2];
        } },
    };
    vm.runInNewContext(ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, { module: mod, exports: mod.exports, require: (name) => dependencies[name] || {} });
    const boxes = [];
    const zoom = new mod.exports.ZoomHandlerImpl((...box) => boxes.push(box), canvas, { scale: 2 });
    return { zoom, boxes, attributes, listeners, removed: () => removed };
}

test('ROI zoom maps pointer coordinates through the content SVG and removes all listeners on cancel', () => {
    const { zoom, listeners, boxes } = zoomHarness();
    zoom.zoom();
    listeners.get('mousedown')({ which: 1, clientX: 30, clientY: 60 });
    listeners.get('mousemove')({ clientX: 110, clientY: 160 });
    listeners.get('mouseup')({ clientX: 110, clientY: 160 });
    assert.deepEqual(boxes, [[10, 20, 40, 50]]);
    zoom.cancel();
    assert.equal(listeners.size, 0);
});

test('cancelling an unfinished ROI drag removes its temporary selection rectangle', () => {
    const { zoom, listeners, removed } = zoomHarness();
    zoom.zoom();
    listeners.get('mousedown')({ which: 1, clientX: 30, clientY: 60 });
    zoom.cancel();
    assert.equal(removed(), 1);
    assert.equal(listeners.size, 0);
});


test('populated conflict mapping renders, clears while clean, and rebuilds from visible objects after restore', () => {
    const canvas = new Canvas();
    canvas.geometry = { offset: 0, angle: 0, scale: 1 };
    canvas.html = () => ({ addEventListener() {}, removeEventListener() {} });
    const mappedObjects = [];
    canvas.setupConflictRegions = (object) => { mappedObjects.push(object); return [20, 30]; };
    canvas.setupIssueRegions = () => {};
    const object = { serverID: 12, objectType: 'shape', zOrder: 0, hidden: false };
    const conflict = {
        annotationConflicts: [{ serverID: 12, type: 'shape' }], description: 'Mismatching label', severity: 'error',
    };
    const hiddenObject = { ...object, serverID: 13, hidden: true };
    const hiddenConflict = { ...conflict, annotationConflicts: [{ serverID: 13, type: 'shape' }] };
    const state = {
        review: {
            frameIssues: [], issuesHidden: false, issuesResolvedHidden: false,
            newIssue: { position: null, source: null }, fetching: { issueId: null },
            frameConflicts: [conflict, hiddenConflict],
        },
        annotation: {
            canvas: { instance: canvas, ready: true, activeControl: ActiveControl.CURSOR, cleanImageMode: false },
            annotations: { states: [object, hiddenObject], highlightedConflict: conflict },
        },
        settings: { shapes: { showGroundTruth: true } },
    };
    const effects = [];
    const dispatched = [];
    const render = loadIssueAggregator(state, dispatched, effects);
    const flushEffects = () => effects.splice(0).forEach((effect) => effect());
    const conflictLabels = (tree) => flattenElements(tree).filter((element) => element.type === 'ConflictLabel');
    render();
    flushEffects();
    const visible = conflictLabels(render());
    assert.equal(visible.length, 1);
    assert.equal(visible[0].props.text, conflict.description);
    assert.equal(visible[0].props.left, 20);
    assert.equal(visible[0].props.tooltipVisible, true);
    assert.deepEqual(mappedObjects, [object]);
    effects.length = 0;

    state.annotation.canvas.cleanImageMode = true;
    render();
    flushEffects();
    assert.equal(conflictLabels(render()).length, 0);
    effects.length = 0;
    assert.equal(mappedObjects.length, 1);
    assert.deepEqual(dispatched, [{ type: 'highlight', conflict: null }]);

    state.annotation.annotations.highlightedConflict = null;
    state.annotation.canvas.cleanImageMode = false;
    assert.equal(conflictLabels(render()).length, 0);
    flushEffects();
    const restored = conflictLabels(render());
    assert.equal(restored.length, 1);
    assert.equal(restored[0].props.tooltipVisible, false);
    assert.equal(hiddenObject.hidden, true);
    assert.equal(state.review.frameConflicts.length, 2);
});

function loadSourceModule(relativePath, dependencies) {
    const filename = path.resolve(__dirname, '../..', relativePath);
    const mod = { exports: {} };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: {
            jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
        },
    }).outputText, {
        module: mod, exports: mod.exports,
        require: (name) => dependencies[name] || {},
        window: global.window, document: global.document,
        setTimeout: global.setTimeout,
    });
    return mod.exports;
}

test('mounted issue and new-issue dialogs retain their draft inputs across clean mode toggles', async () => {
    // jsdom's optional raster dependency is not needed for DOM/React lifecycle checks.
    const canvasModule = require.resolve('canvas');
    const savedCanvasModule = require.cache[canvasModule];
    require.cache[canvasModule] = { exports: { createCanvas: undefined }, loaded: true };
    const { JSDOM } = require('jsdom');
    if (savedCanvasModule) require.cache[canvasModule] = savedCanvasModule;
    else delete require.cache[canvasModule];
    const dom = new JSDOM('<div id="root"></div><div id="cvat_canvas_attachment_board"></div>');
    const originalWindow = global.window;
    const originalDocument = global.document;
    global.window = dom.window;
    global.document = dom.window.document;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    const React = require('react');
    const ReactDOM = require('react-dom');
    const { createRoot } = require('react-dom/client');
    const { Simulate, act } = require('react-dom/test-utils');
    const canvas = new Canvas();
    canvas.geometry = { offset: 0, angle: 0, scale: 1 };
    canvas.html = () => document.getElementById('root');
    canvas.setupIssueRegions = () => {};
    canvas.translateFromSVG = (point) => point;
    const reviewWrites = [];
    const state = {
        review: {
            frameIssues: [{
                id: 1, position: [20, 30], comments: [], resolved: false,
                comment: async () => reviewWrites.push(state.annotation.canvas.cleanImageMode),
            }],
            issuesHidden: false, issuesResolvedHidden: false,
            newIssue: { position: null, source: null }, fetching: { issueId: null }, frameConflicts: [],
        },
        annotation: {
            canvas: { instance: canvas, ready: true, activeControl: ActiveControl.CURSOR, cleanImageMode: false },
            annotations: { states: [], highlightedConflict: null },
        },
        settings: { shapes: { showGroundTruth: false } },
    };
    state.auth = { user: { id: 7 } };
    const dispatch = (next) => {
        if (typeof next === 'function') return next(dispatch, () => state);
        state.annotation = reduceAnnotation(state.annotation, next);
        return next;
    };
    const annotationCommands = loadSourceModule('cvat-ui/src/actions/annotation-actions.ts', {
        'cvat-store': { getCVATStore: () => ({ getState: () => state }) },
        'cvat-canvas-wrapper': { Canvas, CanvasMode },
        'cvat-core-wrapper': { getCore: () => ({}), ShapeType: {} },
        reducers: { ActiveControl },
    });
    const reviewCommands = loadSourceModule('cvat-ui/src/actions/review-actions.ts', {
        './annotation-actions': annotationCommands,
        'utils/redux': { createAction: (type, payload) => ({ type, payload }) },
        'cvat-core-wrapper': { getCore: () => ({}) },
        reducers: { NewIssueSource: { ISSUE_TOOL: 'issue_tool' } },
    });
    const container = ({ children }) => React.createElement('div', null, children);
    const Input = React.forwardRef(({ value, onChange, placeholder, onPressEnter }, ref) => (
        React.createElement('input', { ref, value, onChange, placeholder, onKeyDown: (event) => {
            if (event.key === 'Enter') onPressEnter?.();
        } })
    ));
    const hiddenZLayers = new Set();
    const dependencies = {
        react: React,
        'react-dom': ReactDOM,
        'react-redux': { useSelector: (selector) => selector(state), useDispatch: () => dispatch },
        'actions/review-actions': reviewCommands,
        'actions/annotation-actions': annotationCommands,
        'antd/lib/input': Input,
        'antd/lib/form': Object.assign(container, { Item: container }),
        'antd/lib/button': container,
        'antd/lib/grid': { Row: container, Col: container },
        'antd/lib/typography/Text': container,
        '@ant-design/icons': { CloseOutlined: container },
        'components/common/cvat-tooltip': container,
        './use-dialog-positioning': { useDialogPositioning: () => ({ top: 0, left: 0 }) },
        'utils/hooks': { useIsMounted: () => () => true },
        'utils/redux': { shallowEqual: () => true },
        'utils/get-hidden-z-layers': { __esModule: true, default: () => hiddenZLayers },
        reducers: { ActiveControl, NewIssueSource: { ISSUE_TOOL: 'issue_tool' } },
        'cvat-canvas-wrapper': { Canvas, CanvasMode },
    };
    const directory = 'cvat-ui/src/components/annotation-page/review/';
    dependencies['./issue-dialog'] = loadSourceModule(`${directory}issue-dialog.tsx`, dependencies);
    dependencies['./create-issue-dialog'] = loadSourceModule(`${directory}create-issue-dialog.tsx`, dependencies);
    dependencies['./hidden-issue-label'] = ({ onClick }) => ReactDOM.createPortal(
        React.createElement('button', { onClick }, 'Open issue'),
        document.getElementById('cvat_canvas_attachment_board'),
    );
    const Aggregator = loadSourceModule(`${directory}issues-aggregator.tsx`, dependencies).default;
    const root = createRoot(document.getElementById('root'));
    const applyVisibility = loadCanvasCleanImageMode().applyCleanImageMode;
    const roots = Object.fromEntries(['text', 'masks', 'bitmap', 'grid', 'content']
        .map((name) => [name, document.createElement('div')]));
    roots.attachments = document.getElementById('cvat_canvas_attachment_board');
    const render = async () => {
        applyVisibility(roots, state.annotation.canvas.cleanImageMode);
        await act(async () => root.render(React.createElement(Aggregator)));
    };
    try {
        await render();
        await act(async () => Simulate.click(document.querySelector('button')));
        const comment = document.querySelector('.cvat-issue-dialog input');
        await act(async () => Simulate.change(comment, { target: { value: 'Unsent comment' } }));
        assert.equal(comment.value, 'Unsent comment');
        comment.focus();
        state.annotation.canvas.cleanImageMode = true;
        await render();
        assert.strictEqual(document.querySelector('.cvat-issue-dialog input'), comment);
        assert.equal(roots.attachments.style.visibility, 'hidden');
        assert.strictEqual(document.activeElement, comment);
        state.annotation.canvas.cleanImageMode = false;
        await render();
        assert.strictEqual(document.querySelector('.cvat-issue-dialog input'), comment);
        assert.equal(comment.value, 'Unsent comment');

        state.annotation.canvas.cleanImageMode = true;
        await render();
        await act(async () => Simulate.keyDown(comment, { key: 'Enter' }));
        assert.equal(state.annotation.canvas.cleanImageMode, false, 'focused hidden Enter must exit clean');
        assert.deepEqual(reviewWrites, [false]);

        state.review.newIssue = { position: [40, 50], source: 'issue_tool' };
        await render();
        const description = document.querySelector('.cvat-create-issue-dialog input');
        description.value = 'Unsent issue description';
        state.annotation.canvas.cleanImageMode = true;
        await render();
        assert.strictEqual(document.querySelector('.cvat-create-issue-dialog input'), description);
        state.annotation.canvas.cleanImageMode = false;
        await render();
        assert.strictEqual(document.querySelector('.cvat-create-issue-dialog input'), description);
        assert.equal(description.value, 'Unsent issue description');
        assert.equal(document.querySelector('#root .cvat-issue-dialog'), null);
        assert.equal(document.querySelector('#root .cvat-create-issue-dialog'), null);
    } finally {
        await act(async () => root.unmount());
        dom.window.close();
        global.window = originalWindow;
        global.document = originalDocument;
        delete global.IS_REACT_ACT_ENVIRONMENT;
    }
});

function annotationActionHarness(clean = true) {
    let state = {
        annotation: enabledAnnotation(),
        settings: { workspace: { showAllInterpolationTracks: false }, shapes: { showGroundTruth: false } },
    };
    state.annotation.canvas = { ...state.annotation.canvas, instance: new Canvas(), cleanImageMode: clean };
    const trace = [];
    const mark = (name) => trace.push({ name, clean: state.annotation.canvas.cleanImageMode });
    const job = {
        dimension: '2d',
        annotations: Object.fromEntries(['clear', 'put', 'merge', 'group', 'join', 'slice', 'split', 'updateLayer', 'compactLayers']
            .map((name) => [name, async () => { mark(name); return []; }])),
        actions: {
            get: async () => ({ undo: [], redo: [] }), clear: async () => {},
            undo: async () => mark('undo'), redo: async () => mark('redo'),
        },
        logger: { log: async () => ({ close: async () => {} }) },
    };
    state.annotation.job.instance = job;
    state.annotation.annotations.history = { undo: [['update', null]], redo: [['update', null]] };
    const enums = new Proxy({}, { get: (_, name) => name });
    const core = { config: {}, utils: { propagateShapes: (states) => states } };
    const actions = loadSourceModule('cvat-ui/src/actions/annotation-actions.ts', {
        'cvat-core-wrapper': {
            getCore: () => core, ShapeType: { RECTANGLE: 'rectangle' }, ObjectType: { TAG: 'tag' },
        },
        'cvat-canvas-wrapper': { Canvas, CanvasMode },
        'cvat-canvas3d-wrapper': {},
        'cvat-store': { getCVATStore: () => ({ getState: () => state }) },
        'cvat-logger': { EventScope: enums },
        reducers: { ActiveControl, Workspace: { REVIEW: 'review' } },
        './settings-actions': { switchToolsBlockerState: () => ({ type: 'BLOCK_TOOLS' }) },
    });
    const dispatch = (next) => {
        // Follow-up fetches do not change the synchronous ordering under test.
        if (typeof next === 'function') return Promise.resolve();
        state = { ...state, annotation: reduceAnnotation(state.annotation, next) };
        mark(next.type);
        return next;
    };
    const object = {
        clientID: 42, parentID: null, shapeType: 'rectangle', updateFlags: {}, isGroundTruth: false,
        save: async () => { mark('save'); return object; },
        delete: async () => { mark('delete'); return true; },
    };
    state.annotation.annotations.states = [object];
    state.annotation.annotations.activatedStateID = object.clientID;
    const run = (thunk) => thunk(dispatch, () => state);
    return { actions, trace, object, run, getState: () => state, dispatch };
}

test('actual delete action exits clean before deleting and retains normal behavior when already disabled', async () => {
    for (const clean of [true, false]) {
        const { actions, trace, object, run } = annotationActionHarness(clean);
        await run(actions.removeObjectAsync(object, false));
        assert.deepEqual(trace.map(({ name }) => name), [
            ...(clean ? ['SWITCH_CLEAN_IMAGE_MODE'] : []), 'delete', 'REMOVE_OBJECT_SUCCESS',
        ]);
        assert.equal(trace.find(({ name }) => name === 'delete').clean, false);
    }
});

test('the actual object lock handler exits clean through the shared update action before save', async () => {
    const harness = annotationActionHarness();
    const React = require('react');
    const Component = loadSourceModule(
        'cvat-ui/src/containers/annotation-page/standard-workspace/objects-side-bar/object-buttons.tsx',
        { react: React, 'react-redux': { connect: () => (component) => component } },
    ).default;
    let update;
    const component = new Component({
        objectState: harness.object,
        updateAnnotations: (states) => { update = harness.run(harness.actions.updateAnnotationsAsync(states)); },
    });
    component.lock();
    await update;
    assert.equal(harness.object.lock, true);
    assert.deepEqual(harness.trace.map(({ name }) => name), ['SWITCH_CLEAN_IMAGE_MODE', 'save', 'UPDATE_ANNOTATIONS_SUCCESS']);
    assert.equal(harness.trace.find(({ name }) => name === 'save').clean, false);
});

test('bulk updates and annotation mutation APIs exit clean before their first core mutation', async (t) => {
    for (const [name, args, operation] of [
        ['updateAnnotationsAsync', (object) => [object, { ...object, clientID: 43 }], 'save'],
        ['createAnnotationsAsync', (object) => [[object]], 'put'],
        ['removeAnnotationsAsync', () => [0, 4, false], 'clear'],
        ['updateLayerAsync', (object) => [0, { exact: 3 }, [object]], 'updateLayer'],
        ['compactLayersAsync', () => [0], 'compactLayers'],
        ['mergeAnnotationsAsync', (object) => [[object]], 'merge'],
        ['groupAnnotationsAsync', (object) => [[object]], 'group'],
        ['joinAnnotationsAsync', (object) => [[object], []], 'join'],
        ['sliceAnnotationsAsync', (object) => [object, []], 'slice'],
        ['splitAnnotationsAsync', (object) => [object], 'split'],
        ['undoActionAsync', () => [], 'undo'],
        ['redoActionAsync', () => [], 'redo'],
        ['propagateObjectAsync', () => [1, 4], 'put'],
    ]) {
        await t.test(name, async () => {
            const { actions, trace, object, run } = annotationActionHarness();
            const parameters = name === 'updateAnnotationsAsync' ? [args(object)] : args(object);
            await run(actions[name](...parameters));
            assert.equal(trace.find((entry) => entry.name === operation)?.clean, false, name);
            assert.equal(trace[0].name, 'SWITCH_CLEAN_IMAGE_MODE', name);
        });
    }
});

function starterDependencies(state) {
    const React = require('react');
    return {
        react: { ...React, useRef: () => ({ current: null }), useState: (initial) => [initial, () => {}], useEffect: () => {} },
        'react-redux': { connect: () => (component) => component, useSelector: (selector) => selector(state) },
        'cvat-canvas-wrapper': { Canvas, CanvasMode, RectDrawingMethod: {}, CuboidDrawingMethod: {} },
        'cvat-core-wrapper': { ShapeType: { RECTANGLE: 'rectangle', POLYGON: 'polygon' }, LabelType: {} },
        'actions/shortcuts-actions': { registerComponentShortcuts() {} },
        'utils/component-subkeymap': { subKeyMap: (_, map) => map },
        'utils/enums': { ShortcutScope: {} },
        'antd/lib/layout': { Sider: 'div' },
        '@ant-design/icons': () => null,
        'components/common/cvat-tooltip': () => null,
        'utils/mousetrap-react': () => null,
        'cvat-store': { getCVATStore: () => ({ getState: () => state }) },
        reducers: { ActiveControl },
    };
}

function operationHarness() {
    const state = { annotation: enabledAnnotation(), shortcuts: { keyMap: {}, normalizedKeyMap: {} } };
    state.annotation.annotations.activatedStateID = 42;
    const trace = [];
    const canvas = new Canvas();
    canvas.cancel = () => trace.push('cancel');
    for (const method of ['draw', 'selectRegion', 'merge', 'group', 'split', 'join', 'slice', 'interact']) {
        canvas[method] = (configuration) => trace.push({ method, clean: state.annotation.canvas.cleanImageMode, configuration });
    }
    const updateActiveControl = (activeControl) => {
        state.annotation = reduceAnnotation(state.annotation, action('UPDATE_ACTIVE_CONTROL', { activeControl }));
        trace.push(activeControl);
    };
    return { state, trace, canvas, updateActiveControl };
}

test('2D draw starts only after the real reducer transition exits clean mode', () => {
    const harness = operationHarness();
    const Component = loadSourceModule(
        'cvat-ui/src/containers/annotation-page/standard-workspace/controls-side-bar/draw-shape-popover.tsx',
        starterDependencies(harness.state),
    ).default;
    const component = new Component({
        canvasInstance: harness.canvas, shapeType: 'rectangle', labels: [{ id: 7, type: 'any' }],
        onDrawStart: (activeShapeType) => {
            harness.state.annotation = reduceAnnotation(harness.state.annotation, action('REMEMBER_OBJECT', {
                activeShapeType, updateCurrentControl: true,
            }));
        },
    });
    component.onDraw('shape');
    assert.equal(harness.trace.find((entry) => entry.method === 'draw').clean, false);
});

test('issue selection, join, and slice shortcuts exit clean before calling the canvas and preserve slice target', async (t) => {
    for (const [path, method] of [
        ['review-workspace/controls-side-bar/issue-control.tsx', 'selectRegion'],
        ['standard-workspace/controls-side-bar/join-control.tsx', 'join'],
        ['standard-workspace/controls-side-bar/slice-control.tsx', 'slice'],
    ]) {
        await t.test(method, () => {
            const harness = operationHarness();
            const loaded = loadSourceModule(`cvat-ui/src/components/annotation-page/${path}`, starterDependencies(harness.state));
            const Component = loaded.default.type || loaded.default;
            const tree = Component({ canvasInstance: harness.canvas, activeControl: ActiveControl.CURSOR, updateActiveControl: harness.updateActiveControl });
            const visit = (node) => {
                if (Array.isArray(node)) return node.flatMap(visit);
                if (!node || typeof node !== 'object') return [];
                return [node, ...visit(node.props?.children)];
            };
            const hotkeys = visit(tree).find((element) => element.props?.handlers);
            Object.values(hotkeys.props.handlers)[0]();
            const called = harness.trace.find((entry) => entry.method === method);
            assert.equal(called.clean, false, method);
            if (method === 'slice') assert.equal(called.configuration.clientID, 42);
        });
    }
});

test('repeating an AI interaction exits clean before starting the 2D canvas operation', async () => {
    const harness = annotationActionHarness();
    const state = harness.getState();
    state.annotation.drawing = { activeInteractor: { kind: 'interactor' }, activeInteractorParameters: {}, activeLabelID: 7 };
    let cleanAtStart;
    state.annotation.canvas.instance.interact = () => { cleanAtStart = harness.getState().annotation.canvas.cleanImageMode; };
    await harness.run(harness.actions.repeatDrawShapeAsync());
    assert.equal(cleanAtStart, false);
});

function reviewActionHarness() {
    const harness = annotationActionHarness();
    const state = harness.getState();
    const issue = { id: 9 };
    const mutations = [];
    for (const method of ['comment', 'resolve', 'reopen', 'delete']) {
        issue[method] = async () => mutations.push({ method, clean: harness.getState().annotation.canvas.cleanImageMode });
    }
    state.review = { newIssue: { position: [10, 20] }, frameIssues: [issue] };
    state.auth = { user: { id: 7 } };
    state.annotation.job.instance.openIssue = async () => {
        mutations.push({ method: 'openIssue', clean: harness.getState().annotation.canvas.cleanImageMode });
        return issue;
    };
    const actions = loadSourceModule('cvat-ui/src/actions/review-actions.ts', {
        'utils/redux': { createAction: (type, payload) => ({ type, payload }) },
        'cvat-core-wrapper': { getCore: () => ({ classes: { Issue: class { constructor(data) { Object.assign(this, data); } } } }) },
        reducers: { NewIssueSource: { ISSUE_TOOL: 'issue_tool' } },
        './annotation-actions': harness.actions,
    });
    return { ...harness, reviewActions: actions, mutations };
}

test('each review mutation exits clean before the first core write', async (t) => {
    for (const [name, args, method] of [
        ['finishIssueAsync', ['Description'], 'openIssue'],
        ['commentIssueAsync', [9, 'Comment'], 'comment'],
        ['resolveIssueAsync', [9], 'resolve'],
        ['reopenIssueAsync', [9], 'reopen'],
        ['deleteIssueAsync', [9], 'delete'],
    ]) {
        await t.test(name, async () => {
            const harness = reviewActionHarness();
            await harness.run(harness.reviewActions[name](...args));
            assert.deepEqual(harness.mutations, [{ method, clean: false }]);
            assert.equal(harness.trace[0].name, 'SWITCH_CLEAN_IMAGE_MODE');
        });
    }
});

test('plain submit-review and create/start-issue actions exit clean through the actual reducer', () => {
    for (const type of ['SUBMIT_REVIEW', 'CREATE_ISSUE', 'START_ISSUE']) {
        const state = enabledAnnotation();
        state.canvas.instance = new Canvas();
        assert.equal(reduceAnnotation(state, action(type, { jobId: 1, position: [10, 20] })).canvas.cleanImageMode, false, type);
    }
});

test('detector operation tokens prevent stale completion from releasing newer work or a new job session', () => {
    let state = enabledAnnotation();
    const start = (operationID) => action('SET_DETECTOR_INFERENCE_PENDING', { operationID, pending: true });
    const finish = (operationID) => action('SET_DETECTOR_INFERENCE_PENDING', { operationID, pending: false });
    state = reduceAnnotation(state, start('first'));
    state = reduceAnnotation(state, start('second'));
    state = reduceAnnotation(state, finish('first'));
    assert.equal(state.canvas.detectorInferencePending, true);
    state = reduceAnnotation(state, action('SWITCH_CLEAN_IMAGE_MODE', { enabled: true }));
    assert.equal(state.canvas.cleanImageMode, false);
    state = reduceAnnotation(state, action('CLOSE_JOB'));
    state = reduceAnnotation(state, start('new-job'));
    state = reduceAnnotation(state, finish('second'));
    assert.equal(state.canvas.detectorInferencePending, true);
    state = reduceAnnotation(state, finish('new-job'));
    assert.equal(state.canvas.detectorInferencePending, false);
});

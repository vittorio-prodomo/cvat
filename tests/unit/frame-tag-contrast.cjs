// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const repositoryRoot = path.resolve(__dirname, '../..');
const frameTagsPath = path.join(
    repositoryRoot,
    'cvat-ui/src/components/annotation-page/tag-annotation-workspace/frame-tags.tsx',
);
const computeTextColorPath = path.join(repositoryRoot, 'cvat-ui/src/utils/compute-text-color.ts');

function loadTypeScriptModule(filename, stubs = {}) {
    const source = fs.readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, {
        compilerOptions: {
            esModuleInterop: true,
            jsx: ts.JsxEmit.React,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
        },
        fileName: filename,
    }).outputText;
    const loadedModule = new Module(filename, module);
    loadedModule.filename = filename;
    loadedModule.paths = Module._nodeModulePaths(path.dirname(filename));

    const originalLoad = Module._load;
    const originalScssLoader = Module._extensions['.scss'];
    Module._load = function load(request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(stubs, request)) {
            return stubs[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    Module._extensions['.scss'] = () => {};

    try {
        loadedModule._compile(output, filename);
    } finally {
        Module._load = originalLoad;
        if (originalScssLoader) {
            Module._extensions['.scss'] = originalScssLoader;
        } else {
            delete Module._extensions['.scss'];
        }
    }

    return loadedModule.exports;
}

function createReactHarness() {
    const Fragment = Symbol('Fragment');
    const stateSlots = [];
    let hookIndex = 0;
    let pendingEffects = [];

    const React = {
        Fragment,
        createElement(type, props, ...children) {
            const normalizedChildren = children.length === 1 ? children[0] : children;
            return {
                type,
                props: {
                    ...(props || {}),
                    ...(children.length ? { children: normalizedChildren } : {}),
                },
            };
        },
        memo: (component) => component,
        useCallback: (callback) => callback,
        useEffect(effect) {
            pendingEffects.push(effect);
        },
        useState(initialValue) {
            const currentIndex = hookIndex++;
            if (!(currentIndex in stateSlots)) {
                stateSlots[currentIndex] = initialValue;
            }
            return [
                stateSlots[currentIndex],
                (nextValue) => {
                    stateSlots[currentIndex] = nextValue;
                },
            ];
        },
    };

    return {
        React,
        render(Component) {
            hookIndex = 0;
            pendingEffects = [];
            const tree = Component();
            pendingEffects.forEach((effect) => effect());
            return tree;
        },
    };
}

function childrenOf(element) {
    const { children } = element.props;
    return Array.isArray(children) ? children : [children];
}

function resolveOptionalPackage(packageName, resolver = require.resolve) {
    try {
        return resolver(packageName);
    } catch (error) {
        const exactMissingPackage = error instanceof Error &&
            error.code === 'MODULE_NOT_FOUND' &&
            error.message.split('\n', 1)[0] === `Cannot find module '${packageName}'`;
        if (exactMissingPackage) {
            return null;
        }
        throw error;
    }
}

const jsdomPath = resolveOptionalPackage('jsdom');

test('optional package detection suppresses only the exact missing-package error', () => {
    const exactMissing = Object.assign(new Error("Cannot find module 'jsdom'\nRequire stack:\n- test"), {
        code: 'MODULE_NOT_FOUND',
    });
    const transitiveMissing = Object.assign(new Error("Cannot find module 'canvas'\nRequire stack:\n- jsdom"), {
        code: 'MODULE_NOT_FOUND',
    });
    const unexpected = Object.assign(new Error('permission denied'), { code: 'EACCES' });

    assert.equal(resolveOptionalPackage('jsdom', () => '/node_modules/jsdom/lib/api.js'),
        '/node_modules/jsdom/lib/api.js');
    assert.equal(resolveOptionalPackage('jsdom', () => { throw exactMissing; }), null);
    assert.throws(() => resolveOptionalPackage('jsdom', () => { throw transitiveMissing; }),
        (error) => error === transitiveMissing);
    assert.throws(() => resolveOptionalPackage('jsdom', () => { throw unexpected; }),
        (error) => error === unexpected);
});

async function withDOM(callback) {
    // This DOM test does not need jsdom's optional native canvas renderer.
    const canvasPath = resolveOptionalPackage('canvas');
    const previousCanvas = canvasPath ? require.cache[canvasPath] : null;
    if (canvasPath) {
        require.cache[canvasPath] = {
            exports: {}, filename: canvasPath, id: canvasPath, loaded: true,
        };
    }
    let JSDOM;
    try {
        ({ JSDOM } = require(jsdomPath));
    } finally {
        if (canvasPath && previousCanvas) {
            require.cache[canvasPath] = previousCanvas;
        } else if (canvasPath) {
            delete require.cache[canvasPath];
        }
    }
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
        pretendToBeVisual: true,
    });
    const { window } = dom;
    window.matchMedia = () => ({
        addEventListener: () => {},
        addListener: () => {},
        matches: false,
        removeEventListener: () => {},
        removeListener: () => {},
    });

    class ResizeObserver {
        observe() {}

        unobserve() {}

        disconnect() {}
    }

    const globals = {
        Element: window.Element,
        HTMLElement: window.HTMLElement,
        IS_REACT_ACT_ENVIRONMENT: true,
        MouseEvent: window.MouseEvent,
        MutationObserver: window.MutationObserver,
        Node: window.Node,
        ResizeObserver,
        ShadowRoot: window.ShadowRoot,
        SVGElement: window.SVGElement,
        cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
        document: window.document,
        getComputedStyle: window.getComputedStyle.bind(window),
        navigator: window.navigator,
        requestAnimationFrame: window.requestAnimationFrame.bind(window),
        self: window,
        window,
    };
    const originalDescriptors = new Map();
    for (const [name, value] of Object.entries(globals)) {
        originalDescriptors.set(name, Object.getOwnPropertyDescriptor(global, name));
        Object.defineProperty(global, name, {
            configurable: true,
            value,
            writable: true,
        });
    }

    try {
        await callback(window);
    } finally {
        for (const [name, descriptor] of originalDescriptors) {
            if (descriptor) {
                Object.defineProperty(global, name, descriptor);
            } else {
                delete global[name];
            }
        }
        window.close();
    }
}

test('computeTextColor chooses the higher-contrast black or white foreground', () => {
    const { computeTextColor } = loadTypeScriptModule(computeTextColorPath);
    const expectations = new Map([
        ['#ffffff', '#000000'],
        ['#000000', '#ffffff'],
        ['#6f42c1', '#ffffff'],
        ['#24b353', '#000000'],
        ['#3df53d', '#000000'],
        ['#fa3253', '#000000'],
        ['#ff007c', '#000000'],
    ]);

    for (const [background, foreground] of expectations) {
        assert.equal(computeTextColor(background), foreground, background);
    }
});

test('computeTextColor preserves its white fallback for malformed input', () => {
    const { computeTextColor } = loadTypeScriptModule(computeTextColorPath);
    assert.equal(computeTextColor('not-a-color'), '#ffffff');
    assert.equal(computeTextColor('#fff'), '#ffffff');
    assert.equal(computeTextColor('#gggggg'), '#ffffff');
});

test('FrameTags uses adaptive foregrounds for ordinary and ground-truth tags', () => {
    const { computeTextColor } = loadTypeScriptModule(computeTextColorPath);
    assert.equal(computeTextColor('#ffffff'), '#000000');
    assert.equal(computeTextColor('#6f42c1'), '#ffffff');

    const tags = [
        {
            clientID: 101,
            isGroundTruth: false,
            label: { name: 'White ordinary', color: '#ffffff' },
            objectType: 'tag',
            serverID: 201,
        },
        {
            clientID: 102,
            isGroundTruth: false,
            label: { name: 'Purple ordinary', color: '#6f42c1' },
            objectType: 'tag',
            serverID: 202,
        },
        {
            clientID: 103,
            isGroundTruth: true,
            label: { name: 'White ground truth', color: '#ffffff' },
            objectType: 'tag',
            serverID: 203,
        },
    ];
    const storeState = {
        annotation: {
            annotations: {
                highlightedConflict: null,
                states: tags,
            },
            workspace: 'standard',
        },
    };
    const { React, render } = createReactHarness();
    const Tag = function Tag() {};
    const CloseOutlined = function CloseOutlined() {};
    const frameTagsModule = loadTypeScriptModule(frameTagsPath, {
        '@ant-design/icons': { CloseOutlined },
        'actions/annotation-actions': { removeObject: () => ({ type: 'REMOVE_OBJECT' }) },
        'antd/lib/tag': Tag,
        'cvat-core-wrapper': { ObjectType: { TAG: 'tag' } },
        react: { __esModule: true, default: React, ...React },
        'react-redux': {
            useDispatch: () => () => {},
            useSelector: (selector) => selector(storeState),
        },
        'utils/compute-text-color': { computeTextColor },
        'utils/filter-annotations': { filterAnnotations: (states) => states },
        'utils/redux': { shallowEqual: () => true },
    });

    render(frameTagsModule.default);
    const tree = render(frameTagsModule.default);
    const [ordinaryContainer, groundTruthContainer] = childrenOf(tree);
    const [whiteOrdinary, purpleOrdinary] = childrenOf(ordinaryContainer);
    const [whiteGroundTruth] = childrenOf(groundTruthContainer);

    assert.equal(whiteOrdinary.type, Tag);
    assert.equal(whiteOrdinary.props.color, '#ffffff');
    assert.equal(whiteOrdinary.props.closable, true);
    assert.deepEqual(whiteOrdinary.props.style, { color: '#000000' });
    assert.equal(whiteOrdinary.props.closeIcon.type, CloseOutlined);
    assert.deepEqual(whiteOrdinary.props.closeIcon.props.style, { color: '#000000' });

    assert.equal(purpleOrdinary.type, Tag);
    assert.equal(purpleOrdinary.props.color, '#6f42c1');
    assert.equal(purpleOrdinary.props.closable, true);
    assert.deepEqual(purpleOrdinary.props.style, { color: '#ffffff' });
    assert.equal(purpleOrdinary.props.closeIcon.type, CloseOutlined);
    assert.deepEqual(purpleOrdinary.props.closeIcon.props.style, { color: '#ffffff' });

    assert.equal(whiteGroundTruth.type, Tag);
    assert.equal(whiteGroundTruth.props.color, '#ffffff');
    assert.equal(whiteGroundTruth.props.closable, undefined);
    assert.equal(whiteGroundTruth.props.closeIcon, undefined);
    assert.deepEqual(whiteGroundTruth.props.style, { color: '#000000' });
});

test('FrameTags renders accessible Ant Design tags and dispatches removal from the real close control', {
    skip: jsdomPath ? false : 'jsdom is not installed; skipping the optional real-DOM frame-tag coverage',
}, async () => {
    await withDOM(async (window) => {
        const React = require('react');
        const { createRoot } = require('react-dom/client');
        const { act } = require('react-dom/test-utils');
        const AntTag = require('antd/dist/antd.js').Tag;
        const { computeTextColor } = loadTypeScriptModule(computeTextColorPath);
        const tags = [
            {
                clientID: 301,
                isGroundTruth: false,
                label: { name: 'White ordinary DOM', color: '#ffffff' },
                objectType: 'tag',
                serverID: 401,
            },
            {
                clientID: 302,
                isGroundTruth: false,
                label: { name: 'Purple ordinary DOM', color: '#6f42c1' },
                objectType: 'tag',
                serverID: 402,
            },
            {
                clientID: 303,
                isGroundTruth: true,
                label: { name: 'White ground truth DOM', color: '#ffffff' },
                objectType: 'tag',
                serverID: 403,
            },
        ];
        const storeState = {
            annotation: {
                annotations: {
                    highlightedConflict: null,
                    states: tags,
                },
                workspace: 'standard',
            },
        };
        const removalCalls = [];
        const dispatchedActions = [];
        const frameTagsModule = loadTypeScriptModule(frameTagsPath, {
            'actions/annotation-actions': {
                removeObject: (state, force) => {
                    removalCalls.push([state, force]);
                    return { type: 'REMOVE_OBJECT', state };
                },
            },
            'antd/lib/tag': AntTag,
            'cvat-core-wrapper': { ObjectType: { TAG: 'tag' } },
            'react-redux': {
                useDispatch: () => (action) => dispatchedActions.push(action),
                useSelector: (selector) => selector(storeState),
            },
            'utils/compute-text-color': { computeTextColor },
            'utils/filter-annotations': { filterAnnotations: (states) => states },
            'utils/redux': { shallowEqual: () => true },
        });
        const container = window.document.getElementById('root');
        const root = createRoot(container);

        try {
            await act(async () => {
                root.render(React.createElement(frameTagsModule.default));
            });

            const ordinaryTags = container.querySelectorAll('.cvat-canvas-annotation-frame-tags .ant-tag');
            const groundTruthTags = container.querySelectorAll('.cvat-canvas-ground-truth-frame-tags .ant-tag');
            assert.equal(ordinaryTags.length, 2);
            assert.equal(groundTruthTags.length, 1);

            const [whiteOrdinary, purpleOrdinary] = ordinaryTags;
            const [whiteGroundTruth] = groundTruthTags;
            assert.equal(window.getComputedStyle(whiteOrdinary).color, 'rgb(0, 0, 0)');
            assert.equal(window.getComputedStyle(whiteOrdinary).backgroundColor, 'rgb(255, 255, 255)');
            assert.equal(window.getComputedStyle(purpleOrdinary).color, 'rgb(255, 255, 255)');
            assert.equal(window.getComputedStyle(purpleOrdinary).backgroundColor, 'rgb(111, 66, 193)');
            assert.equal(window.getComputedStyle(whiteGroundTruth).color, 'rgb(0, 0, 0)');
            assert.equal(window.getComputedStyle(whiteGroundTruth).backgroundColor, 'rgb(255, 255, 255)');

            const whiteClose = whiteOrdinary.querySelector('.ant-tag-close-icon');
            const purpleClose = purpleOrdinary.querySelector('.ant-tag-close-icon');
            assert.ok(whiteClose);
            assert.ok(purpleClose);
            assert.equal(window.getComputedStyle(whiteClose).color, 'rgb(0, 0, 0)');
            assert.equal(window.getComputedStyle(purpleClose).color, 'rgb(255, 255, 255)');
            assert.equal(whiteClose.querySelector('svg').getAttribute('fill'), 'currentColor');
            assert.equal(purpleClose.querySelector('svg').getAttribute('fill'), 'currentColor');
            assert.equal(whiteGroundTruth.querySelector('.ant-tag-close-icon'), null);

            await act(async () => {
                whiteClose.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            assert.equal(removalCalls.length, 1);
            assert.equal(removalCalls[0][0], tags[0]);
            assert.equal(removalCalls[0][1], false);
            assert.equal(dispatchedActions.length, 1);
            assert.equal(dispatchedActions[0].state, tags[0]);
        } finally {
            await act(async () => root.unmount());
        }
    });
});

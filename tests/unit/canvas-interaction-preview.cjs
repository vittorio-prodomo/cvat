// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const sourceFile = path.resolve(__dirname, '../../cvat-canvas/src/typescript/interactionHandler.ts');

class FakeSVGImageElement {
    constructor() {
        this.href = { baseVal: '' };
    }
}

class FakeElement {
    constructor(type) {
        this.type = type;
        this.attributes = {};
        this.classes = [];
        this.node = type === 'image' ? new FakeSVGImageElement() : {};
        this.node.after = () => {};
    }

    attr(attributes, value) {
        if (typeof attributes === 'string') {
            if (typeof value === 'undefined') return this.attributes[attributes];
            this.attributes[attributes] = value;
        } else {
            Object.assign(this.attributes, attributes);
        }
        return this;
    }

    fill(value) {
        if (typeof value === 'string') {
            this.attributes.fill = value;
        } else {
            if (value.color) this.attributes.fill = value.color;
            if (typeof value.opacity !== 'undefined') this.attributes['fill-opacity'] = value.opacity;
        }
        return this;
    }

    stroke(value) {
        if (typeof value === 'string') {
            this.attributes.stroke = value;
        } else {
            if (value.color) this.attributes.stroke = value.color;
            if (typeof value.width !== 'undefined') this.attributes['stroke-width'] = value.width;
        }
        return this;
    }

    addClass(className) {
        this.classes.push(className);
        return this;
    }

    move(x, y) {
        this.attributes.x = x;
        this.attributes.y = y;
        return this;
    }

    center(x, y) {
        this.attributes.cx = x;
        this.attributes.cy = y;
        return this;
    }

    rotate(angle, cx, cy) {
        this.rotation = { angle, cx, cy };
        return this;
    }

    parent() {
        return this.removed ? null : {};
    }

    loaded(callback) {
        this.loadedCallback = callback;
        return this;
    }

    error(callback) {
        this.errorCallback = callback;
        return this;
    }

    load(url) {
        this.node.href.baseVal = url;
        return this;
    }

    remove() {
        this.removed = true;
    }
}

class FakeRect extends FakeElement {
    constructor(width, height) {
        super('rect');
        this.attributes.width = width;
        this.attributes.height = height;
    }
}

class FakeCircle extends FakeElement {
    constructor(diameter) {
        super('circle');
        this.attributes.r = diameter / 2;
    }
}

class FakePath extends FakeElement {}

const svg = {
    Rect: FakeRect,
    Circle: FakeCircle,
    Path: FakePath,
};

let nextMaskURL = 0;
let deferMaskDataURLs = false;
let deferredMaskCallbacks = [];

function loadInteractionHandler() {
    const mod = { exports: {} };
    const output = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
        compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
        },
    }).outputText;
    const shared = {
        stringifyPoints: (points) => Array.from(points).join(','),
        translateToCanvas: (offset, points) => Array.from(points, (point) => point + offset),
        RLEToImageData: () => ({}),
        imageDataToDataURL: (_data, _width, _height, callback) => {
            nextMaskURL++;
            const dataURL = `blob:detector-preview-mask-${nextMaskURL}`;
            if (deferMaskDataURLs) {
                deferredMaskCallbacks.push(() => callback(dataURL));
            } else {
                callback(dataURL);
            }
        },
        translateFromCanvas: () => {},
        translateToSVG: () => {},
        clamp: (value) => value,
    };
    const customRequire = (name) => {
        if (name === 'lodash') return require('lodash');
        if (name === 'svg.js') return svg;
        if (name === './consts') return { BASE_STROKE_WIDTH: 2, BASE_POINT_SIZE: 5 };
        if (name === './crosshair') return class {};
        if (name === './shared') return shared;
        if (name === './canvasModel') return {};
        throw new Error(`Unexpected module: ${name}`);
    };

    vm.compileFunction(output, ['require', 'module', 'exports'], { filename: sourceFile })(
        customRequire, mod, mod.exports,
    );
    return mod.exports.InteractionHandlerImpl;
}

function makeContainer() {
    const elements = [];
    const add = (element) => {
        elements.push(element);
        return element;
    };

    return {
        elements,
        node: { prepend() {} },
        on() {},
        rect: (width, height) => add(new FakeRect(width, height)),
        ellipse: (width, height) => add(new FakeElement('ellipse').attr({ width, height })),
        polygon: (points) => add(new FakeElement('polygon').attr({ points })),
        image: () => add(new FakeElement('image')),
        polyline: (points) => add(new FakeElement('polyline').attr({ points })),
        circle: (diameter) => add(new FakeCircle(diameter)),
    };
}

function makeHarness({ deferMaskURLs = false } = {}) {
    deferMaskDataURLs = deferMaskURLs;
    deferredMaskCallbacks = [];
    const container = makeContainer();
    const Handler = loadInteractionHandler();
    const geometry = { offset: 10, scale: 2 };
    const handler = new Handler(() => {}, () => {}, container, geometry, {
        controlPointsSize: 6,
        selectedShapeOpacity: 0.4,
    });
    const shapes = [
        { shapeType: 'rectangle', points: [10, 10, 40, 30], rotation: 15, selected: true },
        { shapeType: 'polygon', points: [100, 10, 130, 10, 120, 35] },
        {
            shapeType: 'mask',
            points: [0, 4, 150, 10, 151, 11],
            maskOutlines: [[150, 10, 151, 10, 151, 11, 150, 11]],
        },
        { shapeType: 'polyline', points: [180, 10, 200, 30, 220, 10] },
        { shapeType: 'points', points: [240, 20, 255, 25] },
    ];
    handler.putShapes(shapes);
    return { container, handler, shapes };
}

test('scale-only transforms refresh preview strokes and point radii without rebuilding geometry', () => {
    global.SVGImageElement = FakeSVGImageElement;
    const { handler } = makeHarness();
    const initialShapes = [...handler.intermediateShapes];
    const polygon = initialShapes.find(({ type }) => type === 'polygon');
    const polyline = initialShapes.find(({ type }) => type === 'polyline');

    handler.transform({ offset: 10, scale: 4 });

    assert.deepEqual(handler.intermediateShapes, initialShapes);
    handler.intermediateShapes.forEach((shape) => {
        assert.equal(shape.attributes['stroke-width'], 0.5);
    });
    handler.intermediateShapes.filter(({ type }) => type === 'circle').forEach((point) => {
        assert.equal(point.attributes.r, 1.5);
    });
    assert.equal(polygon.attributes.fill, 'white');
    assert.equal(polygon.attributes['fill-opacity'], 0.4);
    assert.equal(polyline.attributes.fill, 'none');
    assert.equal(handler.intermediateMaskOutlines[0].attributes['stroke-width'], 0.5);
});

test('offset transforms rebuild retained preview geometry and clean old masks and outlines', () => {
    global.SVGImageElement = FakeSVGImageElement;
    const revokedURLs = [];
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => revokedURLs.push(url);

    try {
        const { handler, shapes } = makeHarness();
        const initialShapes = [...handler.intermediateShapes];
        const initialOutline = handler.intermediateMaskOutlines[0];
        const initialMask = initialShapes.find(({ type }) => type === 'image');
        const initialMaskURL = initialMask.node.href.baseVal;

        handler.transform({ offset: 30, scale: 2 });

        assert.equal(handler.selectionShapes, shapes);
        assert.notDeepEqual(handler.intermediateShapes, initialShapes);
        initialShapes.forEach((shape) => assert.equal(shape.removed, true));
        assert.equal(initialOutline.removed, true);
        assert.ok(revokedURLs.includes(initialMaskURL));
        assert.equal(
            handler.intermediateShapes.find(({ type }) => type === 'rect').attributes.x,
            40,
        );
        assert.equal(
            handler.intermediateShapes.find(({ type }) => type === 'image').attributes.x,
            180,
        );
        assert.equal(handler.intermediateShapes[0].attributes.stroke, '#1890ff');
        assert.equal(handler.intermediateMaskOutlines.length, 1);
    } finally {
        URL.revokeObjectURL = originalRevokeObjectURL;
    }
});

test('offset redraw revokes mask URLs that finish encoding after their old image is removed', () => {
    global.SVGImageElement = FakeSVGImageElement;
    const revokedURLs = [];
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => revokedURLs.push(url);

    try {
        const { handler } = makeHarness({ deferMaskURLs: true });
        const initialMask = handler.intermediateShapes.find(({ type }) => type === 'image');

        handler.transform({ offset: 30, scale: 2 });

        assert.equal(initialMask.removed, true);
        assert.equal(deferredMaskCallbacks.length, 2);
        deferredMaskCallbacks.shift()();
        assert.ok(revokedURLs.includes(`blob:detector-preview-mask-${nextMaskURL - 1}`));

        deferredMaskCallbacks.shift()();
        const currentMask = handler.intermediateShapes.find(({ type }) => type === 'image');
        const currentMaskURL = currentMask.node.href.baseVal;
        handler.clearIntermediateShapes();
        assert.ok(revokedURLs.includes(currentMaskURL));
    } finally {
        deferMaskDataURLs = false;
        deferredMaskCallbacks = [];
        URL.revokeObjectURL = originalRevokeObjectURL;
    }
});

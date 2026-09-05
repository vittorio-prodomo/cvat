// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
// Run with: node --test tests/unit/mask-morphology.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function loadEngine() {
    const filename = path.resolve(__dirname, '../../cvat-ui/src/utils/mask-morphology.ts');
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const mod = { exports: {} };
    vm.runInNewContext(output, { module: mod, exports: mod.exports, Int32Array, Uint16Array, Float64Array });
    return mod.exports.MaskMorphologyEngine;
}

function encode(pixels, width, height, left = 0, top = 0) {
    let minX = width; let minY = height; let maxX = -1; let maxY = -1;
    pixels.forEach((value, i) => {
        if (value) {
            const x = i % width; const y = Math.floor(i / width);
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
    });
    if (maxX < 0) return new Int32Array();
    const runs = []; let current = 0; let count = 0;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const value = pixels[y * width + x] ? 1 : 0;
        if (value !== current) { runs.push(count); count = 0; current = value; }
        count++;
    }
    runs.push(count, minX + left, minY + top, maxX + left, maxY + top);
    return Int32Array.from(runs);
}

function decode(rle, bounds) {
    const width = bounds[2] - bounds[0]; const height = bounds[3] - bounds[1];
    const result = new Uint8Array(width * height);
    if (!rle.length) return result;
    const [left, top, right, bottom] = rle.slice(-4);
    assert.ok(left >= bounds[0] && top >= bounds[1] && right < bounds[2] && bottom < bounds[3]);
    const maskWidth = right - left + 1;
    let position = 0;
    for (let run = 0; run < rle.length - 4; run++) {
        for (let i = 0; i < rle[run]; i++, position++) {
            if (run % 2) result[(top - bounds[1] + Math.floor(position / maskWidth)) * width + left - bounds[0] + position % maskWidth] = 1;
        }
    }
    assert.equal(position, maskWidth * (bottom - top + 1));
    return result;
}

function bruteForce(source, width, height, radius) {
    const result = new Uint8Array(width * height); const r = Math.abs(radius);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let value = radius < 0 ? 1 : 0;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy > r * r) continue;
            const xx = x + dx; const yy = y + dy;
            const foreground = xx >= 0 && yy >= 0 && xx < width && yy < height && source[yy * width + xx];
            if (radius < 0 && !foreground) value = 0;
            if (radius >= 0 && foreground) value = 1;
        }
        result[y * width + x] = value;
    }
    return result;
}

test('exact Euclidean disks match brute force for holes, disconnected pixels, and image/ROI edges', () => {
    const Engine = loadEngine();
    const width = 13; const height = 11;
    const source = new Uint8Array(width * height);
    for (let y = 1; y < 10; y++) for (let x = 1; x < 10; x++) source[y * width + x] = 1;
    for (let y = 4; y < 7; y++) for (let x = 4; x < 7; x++) source[y * width + x] = 0;
    source[0] = 1; source[width * height - 1] = 1;
    for (const origin of [[0, 0], [103, 207]]) {
        const bounds = [origin[0], origin[1], origin[0] + width, origin[1] + height];
        const input = encode(source, width, height, ...origin);
        const preserved = input.slice(); const engine = new Engine();
        for (const radius of [1, 2, 20, -1, -2, -20, 0, 2, -1]) {
            const output = engine.apply(input, radius, bounds);
            assert.deepEqual(decode(output, bounds), bruteForce(source, width, height, radius), `radius ${radius}`);
            assert.deepEqual(input, preserved);
        }
    }
});

test('dilation grows beyond the original tight bbox and uses a disk rather than a square', () => {
    const Engine = loadEngine(); const engine = new Engine();
    const input = new Int32Array([0, 1, 30, 30, 30, 30]);
    const bounds = [0, 0, 61, 61];
    const output = engine.apply(input, 20, bounds);
    assert.deepEqual(Array.from(output.slice(-4)), [10, 10, 50, 50]);
    const pixels = decode(output, bounds);
    assert.equal(pixels[10 * 61 + 10], 0);
    assert.equal(pixels[10 * 61 + 30], 1);
    assert.deepEqual(pixels, bruteForce(decode(input, bounds), 61, 61, 20));
    assert.equal(engine.apply(input, -1, bounds).length, 0);
});

test('outside the ROI is background for erosion even when every received pixel is foreground', () => {
    const Engine = loadEngine();
    const output = new Engine().apply(new Int32Array([0, 25, 40, 70, 44, 74]), -1, [40, 70, 45, 75]);
    assert.deepEqual(Array.from(output), [0, 9, 41, 71, 43, 73]);
    const wide = new Engine().apply(new Int32Array([0, 3721, 0, 0, 60, 60]), -20, [0, 0, 61, 61]);
    assert.deepEqual(Array.from(wide), [0, 441, 20, 20, 40, 40]);
});

test('zero restores the exact original RLE, including legal zero runs, without sharing its buffer', () => {
    const Engine = loadEngine(); const engine = new Engine();
    const input = new Int32Array([0, 2, 0, 2, 10, 20, 11, 21]);
    engine.apply(input, 2, [0, 0, 40, 40]);
    const reset = engine.apply(input, 0, [0, 0, 40, 40]);
    assert.deepEqual(reset, input);
    assert.notEqual(reset.buffer, input.buffer);
});

test('random masks and alternating radius changes remain based on the immutable source', () => {
    const Engine = loadEngine(); let seed = 12;
    for (let sample = 0; sample < 12; sample++) {
        const width = 5 + sample; const height = 4 + sample % 7;
        const source = Uint8Array.from({ length: width * height }, () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed % 3 ? 1 : 0;
        });
        const bounds = [2, 3, 2 + width, 3 + height];
        const input = encode(source, width, height, 2, 3); const engine = new Engine();
        for (const radius of [-2, 2, -1, 1, 0, -2]) {
            assert.deepEqual(decode(engine.apply(input, radius, bounds), bounds), bruteForce(source, width, height, radius));
        }
    }
});

test('empty masks stay empty and replacing a cached source releases its old distance maps', () => {
    const Engine = loadEngine(); const engine = new Engine();
    const bounds = [0, 0, 200, 200];
    engine.apply(new Int32Array([0, 10000, 10, 10, 109, 109]), 2, bounds);
    const large = engine.memoryBytes;
    engine.apply(new Int32Array([0, 1, 30, 30, 30, 30]), 2, bounds);
    assert.ok(engine.memoryBytes > 0 && engine.memoryBytes < large);
    for (const radius of [-20, 0, 20]) assert.equal(engine.apply(new Int32Array(), radius, bounds).length, 0);
    assert.equal(engine.memoryBytes, 0);
});

test('rejects malformed counts, bbox, radius, bounds, and non-Int32 RLE input', () => {
    const Engine = loadEngine(); const valid = new Int32Array([0, 1, 1, 1, 1, 1]);
    for (const radius of [-21, 21, 1.2, NaN, Infinity, '2']) {
        assert.throws(() => new Engine().apply(valid, radius, [0, 0, 5, 5]));
    }
    for (const bounds of [[0, 0, 0, 5], [0, 0, 5, 0], [2, 2, 5, 5], [0, 0, Infinity, 5], [0, 0, 1.5, 5]]) {
        assert.throws(() => new Engine().apply(valid, 1, bounds));
    }
    for (const rle of [[0, 1, 1], [0, -1, 1, 1, 1, 1], [0, 2, 1, 1, 1, 1], [0, 1, 2, 1, 1, 1]]) {
        assert.throws(() => new Engine().apply(Int32Array.from(rle), 1, [0, 0, 5, 5]));
    }
    assert.throws(() => new Engine().apply(Array.from(valid), 1, [0, 0, 5, 5]));
    assert.throws(() => new Engine().apply(
        new Int32Array([0, 100000000, 0, 0, 9999, 9999]), 1, [0, 0, 10000, 10000],
    ), /working area/);
});

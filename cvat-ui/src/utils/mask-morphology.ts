// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

export type MaskBounds = [number, number, number, number];

export const MAX_MORPHOLOGY_RADIUS = 20;
const DISTANCE_LIMIT = MAX_MORPHOLOGY_RADIUS ** 2 + 1;
const MAX_WORK_PIXELS = 64 * 1024 * 1024;

interface DistanceCache {
    source: Int32Array;
    bounds: MaskBounds;
    foreground: Uint16Array;
    background: Uint16Array;
    left: number;
    top: number;
    width: number;
    height: number;
}

function validate(rle: Int32Array, radius: number, bounds: MaskBounds): void {
    if (!(rle instanceof Int32Array)) throw new Error('Mask must be an Int32Array');
    if (!Number.isInteger(radius) || Math.abs(radius) > MAX_MORPHOLOGY_RADIUS) {
        throw new Error('Mask radius must be an integer between -20 and 20');
    }
    if (!Array.isArray(bounds) || bounds.length !== 4 ||
        bounds.some((value) => !Number.isInteger(value) || value < 0 || value > 0x7fffffff) ||
        bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
        throw new Error('Mask bounds must describe a nonempty image or region of interest');
    }
    if (!rle.length) return;
    if (rle.length < 5) throw new Error('Mask RLE has no counts or bounding box');
    const [left, top, right, bottom] = rle.subarray(-4);
    if (left < bounds[0] || top < bounds[1] || right >= bounds[2] || bottom >= bounds[3] ||
        right < left || bottom < top) {
        throw new Error('Mask bounding box is outside its image or region of interest');
    }
    const area = (right - left + 1) * (bottom - top + 1);
    let total = 0;
    for (let index = 0; index < rle.length - 4; index++) {
        if (rle[index] < 0) throw new Error('Mask RLE counts cannot be negative');
        total += rle[index];
        if (total > area) throw new Error('Mask RLE exceeds its bounding box');
    }
    if (!Number.isSafeInteger(area) || total !== area) throw new Error('Mask RLE does not fill its bounding box');
}

/** Exact squared Euclidean distances up to radius 20; larger values saturate at 401. */
/* eslint-disable no-param-reassign -- Private distance buffers are transformed in place to bound memory. */
function distanceTransform(field: Uint16Array, width: number, height: number): void {
    const verticalLimit = MAX_MORPHOLOGY_RADIUS + 1;
    // The first axis starts with binary seeds. Two linear passes find the
    // nearest seed in each column while accessing contiguous memory.
    for (let index = 0; index < field.length; index++) {
        if (field[index]) {
            field[index] = index < width ? verticalLimit : Math.min(verticalLimit, field[index - width] + 1);
        }
    }
    for (let index = field.length - width - 1; index >= 0; index--) {
        field[index] = Math.min(field[index], field[index + width] + 1);
    }
    for (let index = 0; index < field.length; index++) {
        field[index] = Math.min(DISTANCE_LIMIT, field[index] ** 2);
    }

    // Lower envelope of parabolas on the second axis. Saturation is exact for
    // every supported threshold: a cost above 400 can never produce <= 400.
    const costs = new Float64Array(width);
    const sites = new Int32Array(width);
    const boundaries = new Float64Array(width + 1);
    for (let row = 0; row < height; row++) {
        const offset = row * width;
        costs.set(field.subarray(offset, offset + width));
        let envelope = 0;
        sites[0] = 0;
        boundaries[0] = -Infinity;
        boundaries[1] = Infinity;
        for (let position = 1; position < width; position++) {
            let intersection: number;
            do {
                const site = sites[envelope];
                intersection = (costs[position] - costs[site]) / (2 * (position - site)) +
                    (position + site) / 2;
                if (intersection > boundaries[envelope]) break;
                envelope--;
            } while (envelope >= 0);
            envelope++;
            sites[envelope] = position;
            boundaries[envelope] = intersection;
            boundaries[envelope + 1] = Infinity;
        }
        envelope = 0;
        for (let position = 0; position < width; position++) {
            while (boundaries[envelope + 1] < position) envelope++;
            field[offset + position] = Math.min(
                DISTANCE_LIMIT, (position - sites[envelope]) ** 2 + costs[sites[envelope]],
            );
        }
    }
}
/* eslint-enable no-param-reassign */

function prepare(rle: Int32Array, bounds: MaskBounds): DistanceCache {
    const [sourceLeft, sourceTop, sourceRight, sourceBottom] = rle.subarray(-4);
    // Include the full possible dilation plus a background ring beyond the
    // image/ROI edge, so erosion also sees background outside that boundary.
    const left = Math.max(bounds[0], sourceLeft - MAX_MORPHOLOGY_RADIUS) - 1;
    const top = Math.max(bounds[1], sourceTop - MAX_MORPHOLOGY_RADIUS) - 1;
    const right = Math.min(bounds[2], sourceRight + 1 + MAX_MORPHOLOGY_RADIUS) + 1;
    const bottom = Math.min(bounds[3], sourceBottom + 1 + MAX_MORPHOLOGY_RADIUS) + 1;
    const width = right - left;
    const height = bottom - top;
    if (width * height > MAX_WORK_PIXELS) throw new Error('Mask morphology working area exceeds 64 million pixels');
    const foreground = new Uint16Array(width * height).fill(DISTANCE_LIMIT);
    const background = new Uint16Array(width * height);
    const sourceWidth = sourceRight - sourceLeft + 1;
    let position = 0;
    for (let index = 0; index < rle.length - 4; index++) {
        const end = position + rle[index];
        if (index % 2) {
            while (position < end) {
                const sourceX = position % sourceWidth;
                const count = Math.min(end - position, sourceWidth - sourceX);
                const offset = (sourceTop - top + Math.floor(position / sourceWidth)) * width +
                    sourceLeft - left + sourceX;
                foreground.fill(0, offset, offset + count);
                background.fill(DISTANCE_LIMIT, offset, offset + count);
                position += count;
            }
        } else {
            position = end;
        }
    }
    distanceTransform(foreground, width, height);
    distanceTransform(background, width, height);
    return {
        source: rle.slice(), bounds: [...bounds], foreground, background, left, top, width, height,
    };
}

function encode(cache: DistanceCache, radius: number): Int32Array {
    const {
        width, height, left, top, bounds,
    } = cache;
    const distance = radius > 0 ? cache.foreground : cache.background;
    const threshold = radius * radius;
    const startX = Math.max(0, bounds[0] - left);
    const startY = Math.max(0, bounds[1] - top);
    const endX = Math.min(width, bounds[2] - left);
    const endY = Math.min(height, bounds[3] - top);
    let minX = endX;
    let minY = endY;
    let maxX = -1;
    let maxY = -1;
    for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
            const selected = radius > 0 ? distance[y * width + x] <= threshold : distance[y * width + x] > threshold;
            if (selected) {
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = y;
            }
        }
    }
    if (maxX < 0) return new Int32Array();
    const runs: number[] = [];
    let previous = false;
    let length = 0;
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const selected = radius > 0 ? distance[y * width + x] <= threshold : distance[y * width + x] > threshold;
            if (selected !== previous) {
                runs.push(length);
                length = 0;
                previous = selected;
            }
            length++;
        }
    }
    runs.push(length, minX + left, minY + top, maxX + left, maxY + top);
    return Int32Array.from(runs);
}

export class MaskMorphologyEngine {
    private cache: DistanceCache | null = null;

    public get memoryBytes(): number {
        return this.cache ? this.cache.source.byteLength +
            this.cache.foreground.byteLength + this.cache.background.byteLength : 0;
    }

    private sameSource(rle: Int32Array, bounds: MaskBounds): boolean {
        const { cache } = this;
        return !!cache && rle.length === cache.source.length &&
            bounds.every((value, index) => value === cache.bounds[index]) &&
            rle.every((value, index) => value === cache.source[index]);
    }

    public apply(rle: Int32Array, radius: number, bounds: MaskBounds): Int32Array {
        validate(rle, radius, bounds);
        if (!rle.length) {
            this.cache = null;
            return new Int32Array();
        }
        const sameSource = this.sameSource(rle, bounds);
        if (!sameSource) this.cache = null;
        if (radius === 0) return rle.slice();
        if (!this.cache) this.cache = prepare(rle, bounds);
        return encode(this.cache, radius);
    }
}

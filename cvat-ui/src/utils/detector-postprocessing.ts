import type {
    DetectorOverlapMetric,
    DetectorPostprocessingOptions,
} from '../components/model-runner-modal/detector-runner-config';

export type AreaShapeType = 'mask' | 'polygon' | 'rectangle' | 'ellipse';

export interface DetectorShape {
    id?: number;
    label_id: number;
    type: string;
    points: number[];
    rotation?: number;
    score?: number;
    attributes: { spec_id: number; value: string }[];
    sourceIndex: number;
    targetLabelType: string;
    confidenceAttributeSpecID?: number;
}

export interface FrameSize {
    width: number;
    height: number;
}

export interface ProcessingOptions {
    confidenceThreshold: number | null;
    postprocessing: DetectorPostprocessingOptions;
}

type Span = [number, number];

interface Bounds {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

interface RowBand {
    top: number;
    bottom: number;
    spans: Span[];
}

interface SparseRaster extends Bounds {
    bands: RowBand[];
    area: number;
}

interface PreparedShape {
    shape: DetectorShape;
    score: number;
    bounds: Bounds | null;
}

interface Point {
    x: number;
    y: number;
}

const MAX_RASTER_PIXELS = 64_000_000;
const MAX_ENCODED_RLE_COUNTS = 1_000_000;
const AREA_TYPES = new Set<string>(['mask', 'polygon', 'rectangle', 'ellipse']);
const RASTER_CACHE = new WeakMap<PreparedShape, SparseRaster>();

export class DetectorPostprocessingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DetectorPostprocessingError';
    }
}

function validateFrame(frame: FrameSize): void {
    if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) ||
        frame.width <= 0 || frame.height <= 0) {
        throw new DetectorPostprocessingError('Detector postprocessing requires a positive integer frame size');
    }
}

function ensureWorkingRegion(bounds: Bounds): void {
    const width = bounds.right - bounds.left + 1;
    const height = bounds.bottom - bounds.top + 1;
    if (width * height > MAX_RASTER_PIXELS) {
        throw new DetectorPostprocessingError('Detector postprocessing raster region exceeds 64 million pixels');
    }
}

function isAreaShape(shape: DetectorShape): shape is DetectorShape & { type: AreaShapeType } {
    return AREA_TYPES.has(shape.type);
}

function normalizeScore(score: unknown): number | null {
    return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1 ? score : null;
}

function validateFinitePoints(shape: DetectorShape, expectedLength?: number): void {
    if ((expectedLength !== undefined && shape.points.length !== expectedLength) ||
        shape.points.some((coordinate) => !Number.isFinite(coordinate))) {
        throw new DetectorPostprocessingError(`Malformed ${shape.type} geometry`);
    }
}

function validateDerivedValue(
    shapeType: AreaShapeType,
    description: string,
    value: number,
): void {
    if (!Number.isFinite(value)) {
        throw new DetectorPostprocessingError(
            `Malformed ${shapeType} geometry: derived ${description} must be finite`,
        );
    }
}

function validateDerivedValues(
    shapeType: AreaShapeType,
    description: string,
    values: number[],
): void {
    for (const value of values) {
        validateDerivedValue(shapeType, description, value);
    }
}

function normalizeDegrees(rotation: number | undefined, shapeType: AreaShapeType): number {
    const value = rotation ?? 0;
    if (!Number.isFinite(value) || value < 0 || value > 360) {
        throw new DetectorPostprocessingError(
            `Malformed ${shapeType} rotation: persisted values must be between 0 and 360`,
        );
    }
    return value === 360 ? 0 : value;
}

function rotationTrigonometry(rotation: number): { cosine: number; sine: number } {
    if (rotation === 0) {
        return { cosine: 1, sine: 0 };
    }
    if (rotation === 90) {
        return { cosine: 0, sine: 1 };
    }
    if (rotation === 180) {
        return { cosine: -1, sine: 0 };
    }
    if (rotation === 270) {
        return { cosine: 0, sine: -1 };
    }
    const radians = (rotation * Math.PI) / 180;
    return { cosine: Math.cos(radians), sine: Math.sin(radians) };
}

function rotatePoint(point: Point, center: Point, rotation: number): Point {
    const { cosine, sine } = rotationTrigonometry(rotation);
    const deltaX = point.x - center.x;
    const deltaY = point.y - center.y;
    const rotated = {
        x: deltaX * cosine - deltaY * sine + center.x,
        y: deltaY * cosine + deltaX * sine + center.y,
    };
    validateDerivedValues('rectangle', 'rotated corner coordinates', [rotated.x, rotated.y]);
    return rotated;
}

function rectangleCorners(shape: DetectorShape): Point[] {
    validateFinitePoints(shape, 4);
    const [left, top, right, bottom] = shape.points;
    if (right <= left || bottom <= top) {
        throw new DetectorPostprocessingError('Malformed rectangle geometry: x2 > x1 and y2 > y1 are required');
    }
    const center = { x: left / 2 + right / 2, y: top / 2 + bottom / 2 };
    validateDerivedValues('rectangle', 'center coordinates', [center.x, center.y]);
    const rotation = normalizeDegrees(shape.rotation, 'rectangle');
    const corners = [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
    ];
    return rotation === 0 ? corners : corners.map((point) => rotatePoint(point, center, rotation));
}

function polygonPoints(shape: DetectorShape): Point[] {
    validateFinitePoints(shape);
    if (shape.points.length < 6 || shape.points.length % 2 !== 0) {
        throw new DetectorPostprocessingError('Malformed polygon geometry');
    }
    const points: Point[] = [];
    for (let index = 0; index < shape.points.length; index += 2) {
        points.push({ x: shape.points[index], y: shape.points[index + 1] });
    }
    return points;
}

function pixelBoundsFromContinuous(
    minimumX: number,
    minimumY: number,
    maximumX: number,
    maximumY: number,
    frame: FrameSize,
    shapeType: AreaShapeType,
): Bounds | null {
    validateDerivedValues(shapeType, 'continuous bounds coordinates', [
        minimumX,
        minimumY,
        maximumX,
        maximumY,
    ]);
    const left = Math.max(0, Math.ceil(minimumX - 0.5));
    const top = Math.max(0, Math.ceil(minimumY - 0.5));
    const right = Math.min(frame.width - 1, Math.floor(maximumX - 0.5));
    const bottom = Math.min(frame.height - 1, Math.floor(maximumY - 0.5));
    if (left > right || top > bottom) {
        return null;
    }
    const bounds = {
        left, top, right, bottom,
    };
    validateDerivedValues(shapeType, 'raster bounds coordinates', [left, top, right, bottom]);
    ensureWorkingRegion(bounds);
    return bounds;
}

function boundsFromPoints(points: Point[], frame: FrameSize, shapeType: AreaShapeType): Bounds | null {
    let minimumX = Infinity;
    let minimumY = Infinity;
    let maximumX = -Infinity;
    let maximumY = -Infinity;
    for (const { x, y } of points) {
        minimumX = Math.min(minimumX, x);
        minimumY = Math.min(minimumY, y);
        maximumX = Math.max(maximumX, x);
        maximumY = Math.max(maximumY, y);
    }
    return pixelBoundsFromContinuous(minimumX, minimumY, maximumX, maximumY, frame, shapeType);
}

function validateMask(shape: DetectorShape, frame: FrameSize): Bounds {
    if (shape.points.length < 5) {
        throw new DetectorPostprocessingError('Malformed CVAT mask RLE: missing counts or bounds');
    }
    const boundsValues = shape.points.slice(-4);
    const counts = shape.points.slice(0, -4);
    if (boundsValues.some((value) => !Number.isSafeInteger(value))) {
        throw new DetectorPostprocessingError('Malformed CVAT mask RLE bounds');
    }
    const [left, top, right, bottom] = boundsValues;
    if (left < 0 || top < 0 || right < left || bottom < top ||
        right >= frame.width || bottom >= frame.height) {
        throw new DetectorPostprocessingError('Malformed CVAT mask RLE bounds');
    }
    const bounds = {
        left, top, right, bottom,
    };
    ensureWorkingRegion(bounds);
    if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
        throw new DetectorPostprocessingError('Malformed CVAT mask RLE counts');
    }
    const expectedPixels = (right - left + 1) * (bottom - top + 1);
    const encodedPixels = counts.reduce((sum, count) => sum + count, 0);
    if (encodedPixels !== expectedPixels) {
        throw new DetectorPostprocessingError('Malformed CVAT mask RLE: counts do not match its bounds');
    }
    return bounds;
}

function ellipseBounds(shape: DetectorShape, frame: FrameSize): Bounds | null {
    validateFinitePoints(shape, 4);
    const [centerX, centerY, rightX, topY] = shape.points;
    if (rightX <= centerX || topY >= centerY) {
        throw new DetectorPostprocessingError('Malformed ellipse geometry: rightX > cx and topY < cy are required');
    }
    const radiusX = rightX - centerX;
    const radiusY = centerY - topY;
    validateDerivedValues('ellipse', 'radius values', [radiusX, radiusY]);
    const rotation = normalizeDegrees(shape.rotation, 'ellipse');
    const { cosine, sine } = rotationTrigonometry(rotation);
    const xExtent = Math.hypot(radiusX * cosine, radiusY * sine);
    const yExtent = Math.hypot(radiusX * sine, radiusY * cosine);
    validateDerivedValues('ellipse', 'rotated extent values', [xExtent, yExtent]);
    return pixelBoundsFromContinuous(
        centerX - xExtent,
        centerY - yExtent,
        centerX + xExtent,
        centerY + yExtent,
        frame,
        'ellipse',
    );
}

function shapeBounds(shape: DetectorShape, frame: FrameSize): Bounds | null {
    if (shape.type === 'mask') {
        return validateMask(shape, frame);
    }
    if (shape.type === 'rectangle') {
        return boundsFromPoints(rectangleCorners(shape), frame, 'rectangle');
    }
    if (shape.type === 'polygon') {
        return boundsFromPoints(polygonPoints(shape), frame, 'polygon');
    }
    if (shape.type === 'ellipse') {
        return ellipseBounds(shape, frame);
    }
    throw new DetectorPostprocessingError(`Shape type ${shape.type} does not have area geometry`);
}

function mergeSpans(spans: Span[]): Span[] {
    if (!spans.length) {
        return [];
    }
    const sorted = spans.slice().sort((first, second) => first[0] - second[0] || first[1] - second[1]);
    const merged: Span[] = [[sorted[0][0], sorted[0][1]]];
    for (let index = 1; index < sorted.length; index += 1) {
        const current = sorted[index];
        const previous = merged[merged.length - 1];
        if (current[0] <= previous[1] + 1) {
            previous[1] = Math.max(previous[1], current[1]);
        } else {
            merged.push([current[0], current[1]]);
        }
    }
    return merged;
}

function spansEqual(first: Span[], second: Span[]): boolean {
    return first.length === second.length && first.every(
        ([start, end], index) => start === second[index][0] && end === second[index][1],
    );
}

function appendBand(bands: RowBand[], top: number, bottom: number, spans: Span[]): void {
    if (top > bottom || !spans.length) {
        return;
    }
    const mergedSpans = mergeSpans(spans);
    const previous = bands[bands.length - 1];
    if (previous && previous.bottom + 1 === top && spansEqual(previous.spans, mergedSpans)) {
        previous.bottom = bottom;
    } else {
        bands.push({ top, bottom, spans: mergedSpans });
    }
}

function rasterFromBands(bounds: Bounds, bands: RowBand[]): SparseRaster {
    let area = 0;
    for (const band of bands) {
        let rowArea = 0;
        for (const [start, end] of band.spans) {
            rowArea += end - start + 1;
        }
        area += rowArea * (band.bottom - band.top + 1);
    }
    return { ...bounds, bands, area };
}

function emptyRaster(): SparseRaster {
    return {
        left: 0, top: 0, right: -1, bottom: -1, bands: [], area: 0,
    };
}

function rasterizePolygon(
    points: Point[],
    bounds: Bounds | null,
    shapeType: 'polygon' | 'rectangle',
): SparseRaster {
    if (!bounds) {
        return emptyRaster();
    }
    const bands: RowBand[] = [];
    for (let y = bounds.top; y <= bounds.bottom; y += 1) {
        const centerY = y + 0.5;
        const intersections: number[] = [];
        for (let index = 0; index < points.length; index += 1) {
            const start = points[index];
            const end = points[(index + 1) % points.length];
            if ((start.y > centerY) !== (end.y > centerY)) {
                const intersection =
                    start.x + ((centerY - start.y) * (end.x - start.x)) / (end.y - start.y);
                validateDerivedValue(shapeType, 'scanline intersection coordinates', intersection);
                intersections.push(intersection);
            }
        }
        intersections.sort((first, second) => first - second);
        const spans: Span[] = [];
        for (let index = 0; index + 1 < intersections.length; index += 2) {
            const start = Math.max(bounds.left, Math.ceil(intersections[index] - 0.5));
            const end = Math.min(bounds.right, Math.ceil(intersections[index + 1] - 0.5) - 1);
            if (start <= end) {
                spans.push([start, end]);
            }
        }
        appendBand(bands, y, y, spans);
    }
    return rasterFromBands(bounds, bands);
}

function rasterizeMask(shape: DetectorShape, frame: FrameSize): SparseRaster {
    const bounds = validateMask(shape, frame);
    const width = bounds.right - bounds.left + 1;
    const bands: RowBand[] = [];
    const counts = shape.points.slice(0, -4);
    let pendingY: number | null = null;
    let pendingSpans: Span[] = [];
    let offset = 0;
    let foreground = false;

    const flushPendingRow = (): void => {
        if (pendingY !== null) {
            appendBand(bands, pendingY, pendingY, pendingSpans);
            pendingY = null;
            pendingSpans = [];
        }
    };
    const addRowSpan = (y: number, span: Span): void => {
        if (pendingY !== y) {
            flushPendingRow();
            pendingY = y;
        }
        pendingSpans.push(span);
    };
    const addFullRows = (top: number, bottom: number): void => {
        if (top <= bottom) {
            flushPendingRow();
            appendBand(bands, top, bottom, [[bounds.left, bounds.right]]);
        }
    };

    for (const count of counts) {
        if (foreground && count > 0) {
            const firstOffset = offset;
            const lastOffset = offset + count - 1;
            const firstRow = Math.floor(firstOffset / width);
            const lastRow = Math.floor(lastOffset / width);
            const firstColumn = firstOffset % width;
            const lastColumn = lastOffset % width;
            if (firstRow === lastRow) {
                addRowSpan(
                    bounds.top + firstRow,
                    [bounds.left + firstColumn, bounds.left + lastColumn],
                );
            } else {
                addRowSpan(
                    bounds.top + firstRow,
                    [bounds.left + firstColumn, bounds.right],
                );
                addFullRows(bounds.top + firstRow + 1, bounds.top + lastRow - 1);
                addRowSpan(
                    bounds.top + lastRow,
                    [bounds.left, bounds.left + lastColumn],
                );
            }
        }
        offset += count;
        foreground = !foreground;
    }
    flushPendingRow();
    return rasterFromBands(bounds, bands);
}

function rasterizeEllipse(shape: DetectorShape, bounds: Bounds | null): SparseRaster {
    if (!bounds) {
        return emptyRaster();
    }
    const [centerX, centerY, rightX, topY] = shape.points;
    const radiusX = rightX - centerX;
    const radiusY = centerY - topY;
    validateDerivedValues('ellipse', 'radius values', [radiusX, radiusY]);
    const rotation = normalizeDegrees(shape.rotation, 'ellipse');
    const { cosine, sine } = rotationTrigonometry(rotation);
    const bands: RowBand[] = [];
    for (let y = bounds.top; y <= bounds.bottom; y += 1) {
        const spans: Span[] = [];
        let spanStart: number | null = null;
        for (let x = bounds.left; x <= bounds.right; x += 1) {
            const deltaX = x + 0.5 - centerX;
            const deltaY = y + 0.5 - centerY;
            const localX = deltaX * cosine + deltaY * sine;
            const localY = -deltaX * sine + deltaY * cosine;
            const inside = (localX / radiusX) ** 2 + (localY / radiusY) ** 2 <= 1;
            if (inside && spanStart === null) {
                spanStart = x;
            }
            if (!inside && spanStart !== null) {
                spans.push([spanStart, x - 1]);
                spanStart = null;
            }
        }
        if (spanStart !== null) {
            spans.push([spanStart, bounds.right]);
        }
        appendBand(bands, y, y, spans);
    }
    return rasterFromBands(bounds, bands);
}

function rasterize(prepared: PreparedShape, frame: FrameSize): SparseRaster {
    const cached = RASTER_CACHE.get(prepared);
    if (cached) {
        return cached;
    }
    const { shape, bounds } = prepared;
    let raster: SparseRaster;
    if (shape.type === 'mask') {
        raster = rasterizeMask(shape, frame);
    } else if (shape.type === 'rectangle') {
        raster = rasterizePolygon(rectangleCorners(shape), bounds, 'rectangle');
    } else if (shape.type === 'polygon') {
        raster = rasterizePolygon(polygonPoints(shape), bounds, 'polygon');
    } else if (shape.type === 'ellipse') {
        raster = rasterizeEllipse(shape, bounds);
    } else {
        throw new DetectorPostprocessingError(`Shape type ${shape.type} does not have area geometry`);
    }
    RASTER_CACHE.set(prepared, raster);
    return raster;
}

function boundsIntersect(first: Bounds | null, second: Bounds | null): boolean {
    return first !== null && second !== null &&
        first.left <= second.right && first.right >= second.left &&
        first.top <= second.bottom && first.bottom >= second.top;
}

function intersectionArea(first: SparseRaster, second: SparseRaster): number {
    if (!boundsIntersect(first, second)) {
        return 0;
    }
    let firstBandIndex = 0;
    let secondBandIndex = 0;
    let area = 0;

    while (firstBandIndex < first.bands.length && secondBandIndex < second.bands.length) {
        const firstBand = first.bands[firstBandIndex];
        const secondBand = second.bands[secondBandIndex];
        const sharedTop = Math.max(firstBand.top, secondBand.top);
        const sharedBottom = Math.min(firstBand.bottom, secondBand.bottom);
        let rowIntersection = 0;
        let firstIndex = 0;
        let secondIndex = 0;

        if (sharedTop <= sharedBottom) {
            while (firstIndex < firstBand.spans.length && secondIndex < secondBand.spans.length) {
                const firstSpan = firstBand.spans[firstIndex];
                const secondSpan = secondBand.spans[secondIndex];
                const start = Math.max(firstSpan[0], secondSpan[0]);
                const end = Math.min(firstSpan[1], secondSpan[1]);
                if (start <= end) {
                    rowIntersection += end - start + 1;
                }
                if (firstSpan[1] < secondSpan[1]) {
                    firstIndex += 1;
                } else {
                    secondIndex += 1;
                }
            }
            area += rowIntersection * (sharedBottom - sharedTop + 1);
        }

        if (firstBand.bottom < secondBand.bottom) {
            firstBandIndex += 1;
        } else if (secondBand.bottom < firstBand.bottom) {
            secondBandIndex += 1;
        } else {
            firstBandIndex += 1;
            secondBandIndex += 1;
        }
    }
    return area;
}

function overlapPrepared(
    first: PreparedShape,
    second: PreparedShape,
    metric: DetectorOverlapMetric,
    frame: FrameSize,
): number {
    if (!boundsIntersect(first.bounds, second.bounds)) {
        return 0;
    }
    const firstRaster = rasterize(first, frame);
    const secondRaster = rasterize(second, frame);
    const intersection = intersectionArea(firstRaster, secondRaster);
    if (metric === 'ios') {
        const smallerArea = Math.min(firstRaster.area, secondRaster.area);
        return smallerArea > 0 ? intersection / smallerArea : 0;
    }
    const union = firstRaster.area + secondRaster.area - intersection;
    return union > 0 ? intersection / union : 0;
}

function prepareShape(shape: DetectorShape, score: number, frame: FrameSize): PreparedShape {
    return { shape, score, bounds: shapeBounds(shape, frame) };
}

export function computeOverlap(
    first: DetectorShape,
    second: DetectorShape,
    metric: DetectorOverlapMetric,
    frame: FrameSize,
): number {
    validateFrame(frame);
    if (!isAreaShape(first) || !isAreaShape(second)) {
        throw new DetectorPostprocessingError('Overlap requires two area-bearing shapes');
    }
    return overlapPrepared(
        prepareShape(first, normalizeScore(first.score) ?? 0, frame),
        prepareShape(second, normalizeScore(second.score) ?? 0, frame),
        metric,
        frame,
    );
}

function compareRank(first: PreparedShape, second: PreparedShape): number {
    return second.score - first.score || first.shape.sourceIndex - second.shape.sourceIndex;
}

function mergeSparseRasters(rasters: SparseRaster[]): SparseRaster {
    const nonemptyBounds = rasters.filter((raster) => raster.right >= raster.left && raster.bottom >= raster.top);
    if (!nonemptyBounds.length) {
        return emptyRaster();
    }
    const bounds: Bounds = {
        left: nonemptyBounds[0].left,
        top: nonemptyBounds[0].top,
        right: nonemptyBounds[0].right,
        bottom: nonemptyBounds[0].bottom,
    };
    for (let index = 1; index < nonemptyBounds.length; index += 1) {
        const raster = nonemptyBounds[index];
        bounds.left = Math.min(bounds.left, raster.left);
        bounds.top = Math.min(bounds.top, raster.top);
        bounds.right = Math.max(bounds.right, raster.right);
        bounds.bottom = Math.max(bounds.bottom, raster.bottom);
    }
    ensureWorkingRegion(bounds);

    interface BandEvent {
        additions: Span[][];
        removals: Span[][];
    }

    const events = new Map<number, BandEvent>();
    const eventAt = (y: number): BandEvent => {
        const event = events.get(y) ?? { additions: [], removals: [] };
        events.set(y, event);
        return event;
    };
    for (const raster of rasters) {
        for (const band of raster.bands) {
            eventAt(band.top).additions.push(band.spans);
            eventAt(band.bottom + 1).removals.push(band.spans);
        }
    }

    const boundaries = Array.from(events.keys()).sort((first, second) => first - second);
    const activeRows = new Set<Span[]>();
    const bands: RowBand[] = [];
    for (let index = 0; index + 1 < boundaries.length; index += 1) {
        const y = boundaries[index];
        const event = events.get(y) as BandEvent;
        for (const spans of event.removals) {
            activeRows.delete(spans);
        }
        for (const spans of event.additions) {
            activeRows.add(spans);
        }
        const spans = Array.from(activeRows).flat();
        appendBand(bands, y, boundaries[index + 1] - 1, spans);
    }
    if (!bands.length) {
        return rasterFromBands(bounds, bands);
    }

    let tightLeft = Infinity;
    let tightRight = -Infinity;
    for (const band of bands) {
        tightLeft = Math.min(tightLeft, band.spans[0][0]);
        tightRight = Math.max(tightRight, band.spans[band.spans.length - 1][1]);
    }
    const tightBounds = {
        left: tightLeft,
        top: bands[0].top,
        right: tightRight,
        bottom: bands[bands.length - 1].bottom,
    };
    return rasterFromBands(tightBounds, bands);
}

function encodeRaster(raster: SparseRaster): number[] {
    if (raster.area === 0) {
        throw new DetectorPostprocessingError('Cannot encode an empty mask union without foreground pixels');
    }
    if (raster.right < raster.left || raster.bottom < raster.top) {
        throw new DetectorPostprocessingError('Cannot encode an empty raster without bounds as a CVAT mask RLE');
    }
    const width = raster.right - raster.left + 1;
    const totalPixels = width * (raster.bottom - raster.top + 1);
    const counts: number[] = [];
    let currentValue = 0;
    let currentCount = 0;
    let offset = 0;

    const pushCount = (count: number): void => {
        if (counts.length >= MAX_ENCODED_RLE_COUNTS) {
            throw new DetectorPostprocessingError(
                'Detector postprocessing encoded mask RLE exceeds 1 million counts',
            );
        }
        counts.push(count);
    };
    const append = (value: number, count: number): void => {
        if (count === 0) {
            return;
        }
        if (value === currentValue) {
            currentCount += count;
        } else {
            pushCount(currentCount);
            currentValue = value;
            currentCount = count;
        }
    };

    for (const band of raster.bands) {
        const [onlySpan] = band.spans;
        const isFullWidth = band.spans.length === 1 &&
            onlySpan[0] === raster.left && onlySpan[1] === raster.right;
        if (isFullWidth) {
            const start = (band.top - raster.top) * width;
            const end = (band.bottom - raster.top + 1) * width;
            append(0, start - offset);
            append(1, end - start);
            offset = end;
        } else {
            for (let y = band.top; y <= band.bottom; y += 1) {
                for (const [spanStart, spanEnd] of band.spans) {
                    const start = (y - raster.top) * width + spanStart - raster.left;
                    const end = (y - raster.top) * width + spanEnd - raster.left + 1;
                    append(0, start - offset);
                    append(1, end - start);
                    offset = end;
                }
            }
        }
    }
    append(0, totalPixels - offset);
    pushCount(currentCount);
    counts.push(raster.left, raster.top, raster.right, raster.bottom);
    return counts;
}

function snapCoordinate(value: number): number {
    const nearestInteger = Math.round(value);
    return Math.abs(value - nearestInteger) < 1e-10 ? nearestInteger : value;
}

function rectangleEnclosure(group: PreparedShape[]): number[] {
    let minimumX = Infinity;
    let minimumY = Infinity;
    let maximumX = -Infinity;
    let maximumY = -Infinity;
    for (const { shape } of group) {
        for (const { x, y } of rectangleCorners(shape)) {
            minimumX = Math.min(minimumX, x);
            minimumY = Math.min(minimumY, y);
            maximumX = Math.max(maximumX, x);
            maximumY = Math.max(maximumY, y);
        }
    }
    const enclosure = [
        snapCoordinate(minimumX),
        snapCoordinate(minimumY),
        snapCoordinate(maximumX),
        snapCoordinate(maximumY),
    ];
    validateDerivedValues('rectangle', 'enclosure coordinates', enclosure);
    return enclosure;
}

function requireTargetType(group: PreparedShape[], requiredType: 'mask' | 'rectangle'): void {
    const compatibleTypes = new Set(['any', requiredType]);
    if (group.some(({ shape }) => !compatibleTypes.has(shape.targetLabelType))) {
        throw new DetectorPostprocessingError(
            `Mapped label ${group[0].shape.label_id} must accept ${requiredType} results`,
        );
    }
}

function mergeGroup(group: PreparedShape[], frame: FrameSize): DetectorShape {
    if (group.length === 1) {
        return group[0].shape;
    }
    const ranked = group.slice().sort(compareRank);
    const anchor = ranked[0];
    const maximumScore = ranked.reduce((maximum, candidate) => Math.max(maximum, candidate.score), 0);
    const onlyRectangles = ranked.every(({ shape }) => shape.type === 'rectangle');
    let type: 'mask' | 'rectangle';
    let points: number[];
    if (onlyRectangles) {
        type = 'rectangle';
        requireTargetType(ranked, type);
        points = rectangleEnclosure(ranked);
    } else {
        type = 'mask';
        requireTargetType(ranked, type);
        points = encodeRaster(mergeSparseRasters(ranked.map((candidate) => rasterize(candidate, frame))));
    }
    let foundConfidenceAttribute = false;
    const attributes = anchor.shape.attributes.map((attribute) => {
        if (anchor.shape.confidenceAttributeSpecID === attribute.spec_id) {
            foundConfidenceAttribute = true;
            return { ...attribute, value: maximumScore.toFixed(2) };
        }
        return { ...attribute };
    });
    if (anchor.shape.confidenceAttributeSpecID !== undefined && !foundConfidenceAttribute) {
        attributes.push({
            spec_id: anchor.shape.confidenceAttributeSpecID,
            value: maximumScore.toFixed(2),
        });
    }
    return {
        ...anchor.shape,
        type,
        points,
        rotation: 0,
        score: maximumScore,
        attributes,
    };
}

function processNMS(
    partition: PreparedShape[],
    metric: DetectorOverlapMetric,
    threshold: number,
    frame: FrameSize,
): DetectorShape[] {
    let remaining = partition.slice().sort(compareRank);
    const retained: DetectorShape[] = [];
    while (remaining.length) {
        const [keeper, ...candidates] = remaining;
        retained.push(keeper.shape);
        remaining = candidates.filter((candidate) => overlapPrepared(keeper, candidate, metric, frame) < threshold);
    }
    return retained;
}

function processNMM(
    partition: PreparedShape[],
    metric: DetectorOverlapMetric,
    threshold: number,
    frame: FrameSize,
): DetectorShape[] {
    const ranked = partition.slice().sort(compareRank);
    const parents = ranked.map((_, index) => index);
    const find = (index: number): number => {
        let root = index;
        while (parents[root] !== root) {
            root = parents[root];
        }
        let cursor = index;
        while (parents[cursor] !== cursor) {
            const next = parents[cursor];
            parents[cursor] = root;
            cursor = next;
        }
        return root;
    };
    for (let firstIndex = 0; firstIndex < ranked.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < ranked.length; secondIndex += 1) {
            if (overlapPrepared(ranked[firstIndex], ranked[secondIndex], metric, frame) >= threshold) {
                const firstRoot = find(firstIndex);
                const secondRoot = find(secondIndex);
                if (firstRoot !== secondRoot) {
                    parents[secondRoot] = firstRoot;
                }
            }
        }
    }
    const components = new Map<number, PreparedShape[]>();
    for (let index = 0; index < ranked.length; index += 1) {
        const root = find(index);
        components.set(root, [...(components.get(root) ?? []), ranked[index]]);
    }
    return Array.from(components.values()).map((component) => mergeGroup(component, frame));
}

function processGreedyNMM(
    partition: PreparedShape[],
    metric: DetectorOverlapMetric,
    threshold: number,
    frame: FrameSize,
): DetectorShape[] {
    let remaining = partition.slice().sort(compareRank);
    const merged: DetectorShape[] = [];
    while (remaining.length) {
        const [anchor, ...candidates] = remaining;
        const group = [anchor];
        const next: PreparedShape[] = [];
        for (const candidate of candidates) {
            if (overlapPrepared(anchor, candidate, metric, frame) >= threshold) {
                group.push(candidate);
            } else {
                next.push(candidate);
            }
        }
        merged.push(mergeGroup(group, frame));
        remaining = next;
    }
    return merged;
}

function buildPartitionKeyByLabelID(labelGroups: number[][]): Map<number, string> {
    const partitionKeyByLabelID = new Map<number, string>();
    labelGroups.forEach((group, groupIndex) => {
        if (!Array.isArray(group) || group.length < 2) {
            throw new DetectorPostprocessingError('Detector postprocessing label group must contain two labels');
        }
        const groupLabels = new Set<number>();
        for (const labelID of group) {
            if (!Number.isSafeInteger(labelID) || labelID < 0 || groupLabels.has(labelID) ||
                partitionKeyByLabelID.has(labelID)) {
                throw new DetectorPostprocessingError('Detector postprocessing label group is invalid or overlaps');
            }
            groupLabels.add(labelID);
            partitionKeyByLabelID.set(labelID, `group:${groupIndex}`);
        }
    });
    return partitionKeyByLabelID;
}

function formatConfidenceAttribute(shape: DetectorShape): DetectorShape {
    const score = normalizeScore(shape.score);
    if (score === null || shape.confidenceAttributeSpecID === undefined ||
        !shape.attributes.some(({ spec_id: specID }) => specID === shape.confidenceAttributeSpecID)) {
        return shape;
    }
    return {
        ...shape,
        attributes: shape.attributes.map((attribute) => (
            attribute.spec_id === shape.confidenceAttributeSpecID ?
                { ...attribute, value: score.toFixed(2) } :
                { ...attribute }
        )),
    };
}

export function processDetectorShapes(
    shapes: DetectorShape[],
    frame: FrameSize,
    options: ProcessingOptions,
): DetectorShape[] {
    validateFrame(frame);
    const passthrough: DetectorShape[] = [];
    const partitionKeyByLabelID = buildPartitionKeyByLabelID(options.postprocessing.labelGroups ?? []);
    const partitions = new Map<string, PreparedShape[]>();
    for (const shape of shapes) {
        const score = normalizeScore(shape.score);
        if (score !== null && options.confidenceThreshold !== null && score < options.confidenceThreshold) {
            continue;
        }
        if (score === null || !isAreaShape(shape) || options.postprocessing.method === 'disabled') {
            passthrough.push(shape);
        } else {
            const partitionKey = partitionKeyByLabelID.get(shape.label_id) ?? `label:${shape.label_id}`;
            const partition = partitions.get(partitionKey) ?? [];
            partition.push(prepareShape(shape, score, frame));
            partitions.set(partitionKey, partition);
        }
    }

    const processed = Array.from(partitions.values()).flatMap((partition) => {
        const { method, metric, threshold } = options.postprocessing;
        if (method === 'nms') {
            return processNMS(partition, metric, threshold, frame);
        }
        if (method === 'nmm') {
            return processNMM(partition, metric, threshold, frame);
        }
        return processGreedyNMM(partition, metric, threshold, frame);
    });
    return [...passthrough, ...processed]
        .sort((first, second) => first.sourceIndex - second.sourceIndex)
        .map(formatConfidenceAttribute);
}

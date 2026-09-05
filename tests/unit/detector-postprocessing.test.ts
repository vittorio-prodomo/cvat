import assert from 'node:assert/strict';
import test from 'node:test';

import {
    computeOverlap,
    DetectorPostprocessingError,
    processDetectorShapes,
    type DetectorShape,
} from '../../cvat-ui/src/utils/detector-postprocessing.ts';

const FRAME = { width: 20, height: 20 };

const rectangle = (
    id: number,
    labelId: number,
    score: number | undefined,
    points: number[],
    rotation = 0,
): DetectorShape => ({
    id,
    label_id: labelId,
    type: 'rectangle',
    points,
    rotation,
    ...(score === undefined ? {} : { score }),
    attributes: [],
    sourceIndex: id,
    targetLabelType: 'any',
});

const mask = (
    id: number,
    score: number | undefined,
    points: number[],
    labelId = 1,
): DetectorShape => ({
    id,
    label_id: labelId,
    type: 'mask',
    points,
    ...(score === undefined ? {} : { score }),
    attributes: [],
    sourceIndex: id,
    targetLabelType: 'mask',
});

const process = (
    shapes: DetectorShape[],
    method: 'disabled' | 'nms' | 'nmm' | 'greedy_nmm',
    metric: 'iou' | 'ios' = 'iou',
    threshold = 0.3,
    confidenceThreshold: number | null = 0,
    frame = FRAME,
): DetectorShape[] => processDetectorShapes(shapes, frame, {
    confidenceThreshold,
    postprocessing: { method, metric, threshold },
});

test('computes exact IoU and IoS for rectangle overlap cases', () => {
    const cases: [string, DetectorShape, DetectorShape, number, number][] = [
        [
            'disjoint',
            rectangle(0, 1, 0.9, [0, 0, 2, 2]),
            rectangle(1, 1, 0.8, [3, 3, 5, 5]),
            0,
            0,
        ],
        [
            'partial overlap',
            rectangle(0, 1, 0.9, [0, 0, 4, 4]),
            rectangle(1, 1, 0.8, [2, 0, 6, 4]),
            1 / 3,
            1 / 2,
        ],
        [
            'identical',
            rectangle(0, 1, 0.9, [0, 0, 4, 4]),
            rectangle(1, 1, 0.8, [0, 0, 4, 4]),
            1,
            1,
        ],
        [
            'contained',
            rectangle(0, 1, 0.9, [0, 0, 10, 10]),
            rectangle(1, 1, 0.8, [2, 2, 4, 4]),
            4 / 100,
            1,
        ],
    ];

    for (const [name, first, second, expectedIoU, expectedIoS] of cases) {
        assert.equal(computeOverlap(first, second, 'iou', FRAME), expectedIoU, `${name} IoU`);
        assert.equal(computeOverlap(first, second, 'ios', FRAME), expectedIoS, `${name} IoS`);
    }
});

test('uses a native pixel grid for polygon, rotated rectangle, and rotated ellipse geometry', () => {
    const pixelSquare: DetectorShape = {
        id: 0,
        label_id: 1,
        type: 'polygon',
        points: [0, 0, 2, 0, 2, 2, 0, 2],
        score: 0.9,
        rotation: 0,
        attributes: [],
        sourceIndex: 0,
        targetLabelType: 'any',
    };
    assert.equal(computeOverlap(
        pixelSquare,
        rectangle(1, 1, 0.8, [0, 0, 2, 2]),
        'iou',
        { width: 4, height: 4 },
    ), 1);

    const rotatedRectangle = rectangle(2, 1, 0.9, [1, 1, 5, 3], 90);
    assert.equal(computeOverlap(
        rotatedRectangle,
        rectangle(3, 1, 0.8, [2, 0, 4, 4]),
        'iou',
        { width: 6, height: 5 },
    ), 1);

    const rotatedEllipse: DetectorShape = {
        id: 4,
        label_id: 1,
        type: 'ellipse',
        points: [3, 3, 5, 2],
        score: 0.9,
        rotation: 90,
        attributes: [],
        sourceIndex: 4,
        targetLabelType: 'any',
    };
    const equivalentEllipse: DetectorShape = {
        ...rotatedEllipse,
        id: 5,
        points: [3, 3, 4, 1],
        rotation: 0,
        sourceIndex: 5,
    };
    assert.equal(computeOverlap(rotatedEllipse, equivalentEllipse, 'iou', { width: 7, height: 7 }), 1);
});

test('uses exact quadrant trigonometry for pixel-center circle invariance', () => {
    const circle: DetectorShape = {
        ...rectangle(0, 1, 0.9, [0, 0, 1, 1]),
        type: 'ellipse',
        points: [2, 2.5, 4.5, 0],
        rotation: 0,
    };

    for (const rotation of [90, 270]) {
        assert.equal(computeOverlap(
            circle,
            { ...circle, id: rotation, sourceIndex: rotation, rotation },
            'iou',
            { width: 6, height: 6 },
        ), 1);
    }
});

test('rasterizes a 45-degree rectangle instead of filling its bounding box', () => {
    const rotated = rectangle(0, 1, 0.9, [2, 2, 6, 4], 45);
    const bboxCorner = rectangle(1, 1, 0.8, [2, 1, 3, 2]);

    assert.equal(computeOverlap(rotated, bboxCorner, 'iou', { width: 10, height: 10 }), 0);
});

test('accepts persisted rotation boundary values 0 and 360', () => {
    assert.equal(computeOverlap(
        rectangle(0, 1, 0.9, [0, 0, 1.5, 1.5], 0),
        rectangle(1, 1, 0.8, [0, 0, 1.5, 1.5], 360),
        'iou',
        { width: 3, height: 3 },
    ), 1);
});

test('rejects persisted rectangle and ellipse rotations outside 0 through 360', () => {
    for (const rotation of [-1, 361, Number.MAX_VALUE]) {
        const malformedRectangle = rectangle(0, 1, 0.9, [2, 2, 6, 4], rotation);
        assert.throws(
            () => computeOverlap(malformedRectangle, malformedRectangle, 'iou', { width: 10, height: 10 }),
            (error: unknown) => error instanceof DetectorPostprocessingError &&
                /rectangle.*rotation.*0.*360/i.test(error.message),
        );

        const malformedEllipse: DetectorShape = {
            ...rectangle(1, 1, 0.8, [2, 2, 6, 4], rotation),
            type: 'ellipse',
            points: [4, 4, 6, 3],
        };
        assert.throws(
            () => computeOverlap(malformedEllipse, malformedEllipse, 'iou', { width: 10, height: 10 }),
            (error: unknown) => error instanceof DetectorPostprocessingError &&
                /ellipse.*rotation.*0.*360/i.test(error.message),
        );
    }
});

test('rejects unrepresentable derived rectangle and ellipse geometry before overlap and NMM output', () => {
    const maximum = Number.MAX_VALUE;
    const extremeRectangle = rectangle(0, 1, 0.9, [-maximum, -maximum, maximum, maximum], 45);
    const extremeEllipse: DetectorShape = {
        ...rectangle(1, 1, 0.8, [-maximum, 10, maximum, 0]),
        type: 'ellipse',
    };
    const normal = rectangle(2, 1, 0.7, [0, 0, 2, 2]);

    for (const extreme of [extremeRectangle, extremeEllipse]) {
        assert.throws(
            () => computeOverlap(extreme, extreme, 'iou', { width: 4, height: 4 }),
            (error: unknown) => error instanceof DetectorPostprocessingError &&
                new RegExp(`${extreme.type}.*derived.*finite`, 'i').test(error.message),
        );
        assert.throws(
            () => process([extreme, normal], 'nmm', 'iou', 0, 0, { width: 4, height: 4 }),
            (error: unknown) => error instanceof DetectorPostprocessingError &&
                new RegExp(`${extreme.type}.*derived.*finite`, 'i').test(error.message),
        );
    }
});

test('uses overflow-safe rectangle midpoints for finite NMM enclosures', () => {
    const huge = rectangle(0, 1, 0.9, [1e308, 1e308, 1.1e308, 1.1e308]);
    const normal = rectangle(1, 1, 0.8, [0, 0, 2, 2]);
    const [merged] = process([huge, normal], 'nmm', 'iou', 0, 0, { width: 4, height: 4 });

    assert.deepEqual(merged.points, [0, 0, 1.1e308, 1.1e308]);
    assert.ok(merged.points.every(Number.isFinite));
});

test('decodes CVAT RLE inside its inclusive bounds and treats empty masks as zero area', () => {
    const offsetPixel = mask(0, 0.9, [0, 1, 0, 2, 0, 2]);
    assert.equal(computeOverlap(
        offsetPixel,
        rectangle(1, 1, 0.8, [0, 2, 1, 3]),
        'iou',
        { width: 4, height: 4 },
    ), 1);

    const empty = mask(2, 0.7, [4, 0, 0, 0, 1, 1]);
    assert.equal(computeOverlap(empty, empty, 'iou', { width: 2, height: 2 }), 0);
    assert.equal(computeOverlap(empty, offsetPixel, 'ios', { width: 4, height: 4 }), 0);
});

test('compares foreground instead of overlapping bounding boxes', () => {
    const diagonalA = mask(0, 0.9, [0, 1, 2, 1, 0, 0, 1, 1]);
    const diagonalB = mask(1, 0.8, [1, 2, 1, 0, 0, 1, 1]);
    assert.equal(computeOverlap(diagonalA, diagonalB, 'iou', { width: 2, height: 2 }), 0);
});

test('uses filled triangle and ellipse geometry instead of their bounding boxes', () => {
    const triangle: DetectorShape = {
        ...rectangle(0, 1, 0.9, [0, 0, 4, 4]),
        type: 'polygon',
        points: [0, 0, 4, 0, 0, 4],
    };
    const ellipse: DetectorShape = {
        ...rectangle(1, 1, 0.8, [0, 0, 6, 4]),
        type: 'ellipse',
        points: [3, 2, 6, 0],
    };

    assert.equal(computeOverlap(
        triangle,
        rectangle(2, 1, 0.7, [3, 3, 4, 4]),
        'iou',
        { width: 6, height: 6 },
    ), 0);
    assert.equal(computeOverlap(
        ellipse,
        rectangle(3, 1, 0.6, [0, 0, 1, 1]),
        'iou',
        { width: 7, height: 5 },
    ), 0);
});

test('rejects non-finite polygon scanline intersections before overlap and NMM output', () => {
    const maximum = Number.MAX_VALUE;
    const extremePolygon: DetectorShape = {
        ...rectangle(0, 1, 0.9, [0, 0, 1, 1]),
        type: 'polygon',
        points: [-maximum, -maximum, maximum, maximum, -maximum, maximum],
    };
    const normal = rectangle(1, 1, 0.8, [0, 0, 2, 2]);

    assert.throws(
        () => computeOverlap(extremePolygon, extremePolygon, 'iou', { width: 4, height: 4 }),
        (error: unknown) => error instanceof DetectorPostprocessingError &&
            /polygon.*derived.*scanline.*finite/i.test(error.message),
    );
    assert.throws(
        () => process([extremePolygon, normal], 'nmm', 'iou', 0, 0, { width: 4, height: 4 }),
        (error: unknown) => error instanceof DetectorPostprocessingError &&
            /polygon.*derived.*scanline.*finite/i.test(error.message),
    );
});

test('attributes rotated rectangle scanline overflow to rectangle geometry', () => {
    const maximum = Number.MAX_VALUE;
    const extremeRectangle = rectangle(0, 1, 0.9, [-maximum, -1, maximum, 1], 10);

    assert.throws(
        () => computeOverlap(extremeRectangle, extremeRectangle, 'iou', { width: 4, height: 4 }),
        (error: unknown) => error instanceof DetectorPostprocessingError &&
            /rectangle.*derived.*scanline.*finite/i.test(error.message) &&
            !/polygon/i.test(error.message),
    );
});

test('returns zero for disjoint bounding boxes before exact span comparison', () => {
    assert.equal(computeOverlap(
        mask(0, 0.9, [0, 1, 0, 0, 0, 0]),
        mask(1, 0.8, [0, 1, 0, 19, 19, 19, 19]),
        'ios',
        FRAME,
    ), 0);
});

test('NMS is confidence-ranked, class-aware, and inclusive at the threshold', () => {
    const shapes = [
        rectangle(0, 1, 0.9, [0, 0, 10, 10]),
        rectangle(1, 1, 0.8, [2, 2, 4, 4]),
        rectangle(2, 2, 0.7, [2, 2, 4, 4]),
        rectangle(3, 1, undefined, [3, 3, 5, 5]),
    ];
    assert.deepEqual(process(shapes, 'nms', 'ios', 1).map((shape) => shape.id), [0, 2, 3]);
});

test('NMS keeps higher confidence even when it is the smaller shape', () => {
    assert.deepEqual(process([
        rectangle(0, 1, 0.6, [0, 0, 10, 10]),
        rectangle(1, 1, 0.9, [2, 2, 4, 4]),
    ], 'nms', 'ios', 1).map((shape) => shape.id), [1]);
});

test('rejects malformed high-confidence rectangles before NMS ranking', () => {
    const malformedRectangles = [
        rectangle(0, 1, 0.9, [4, 0, 0, 4]),
        rectangle(1, 1, 0.9, [0, 4, 4, 0]),
    ];
    for (const malformed of malformedRectangles) {
        assert.throws(
            () => process([
                malformed,
                rectangle(2, 1, 0.8, [0, 0, 4, 4]),
            ], 'nms', 'iou', 0.5),
            (error: unknown) => error instanceof DetectorPostprocessingError &&
                /rectangle.*x2 > x1.*y2 > y1/i.test(error.message),
        );
    }
});

test('rejects malformed high-confidence ellipses before NMS ranking', () => {
    const validEllipse: DetectorShape = {
        ...rectangle(2, 1, 0.8, [0, 0, 4, 4]),
        type: 'ellipse',
        points: [2, 2, 4, 0],
    };
    const malformedEllipses: DetectorShape[] = [
        { ...validEllipse, id: 0, score: 0.9, sourceIndex: 0, points: [2, 2, 0, 0] },
        { ...validEllipse, id: 1, score: 0.9, sourceIndex: 1, points: [2, 2, 4, 4] },
    ];
    for (const malformed of malformedEllipses) {
        assert.throws(
            () => process([malformed, validEllipse], 'nms', 'iou', 0.5),
            (error: unknown) => error instanceof DetectorPostprocessingError &&
                /ellipse.*rightX > cx.*topY < cy/i.test(error.message),
        );
    }
});

test('uses stable response order for equal confidence and deterministic output order', () => {
    const kept = process([
        { ...rectangle(4, 1, 0.8, [0, 0, 5, 5]), sourceIndex: 0 },
        { ...rectangle(2, 1, 0.8, [0, 0, 5, 5]), sourceIndex: 1 },
        { ...rectangle(8, 2, 0.9, [7, 7, 9, 9]), sourceIndex: 3 },
        { ...rectangle(6, 3, undefined, [7, 7, 9, 9]), sourceIndex: 2 },
    ], 'nms', 'ios', 1);
    assert.deepEqual(kept.map((shape) => shape.id), [4, 6, 8]);
});

test('filters valid confidence before grouping while Disabled preserves survivors', () => {
    const high = {
        ...rectangle(0, 1, 0.9, [0, 0, 6, 6]),
        attributes: [{ spec_id: 8, value: 'preserved' }],
        confidenceAttributeSpecID: 7,
    };
    const input = [
        high,
        rectangle(1, 1, 0.2, [1, 1, 5, 5]),
    ];
    for (const method of ['disabled', 'nmm'] as const) {
        const result = process(input, method, 'ios', 0.5, 0.35);
        assert.deepEqual(result, [high]);
        assert.equal(result[0], high);
    }
});

test('filters below-threshold malformed geometry before preparing overlap rasters', () => {
    const survivor = rectangle(0, 1, 0.9, [0, 0, 4, 4]);
    const malformedBelowThreshold = mask(1, 0.2, [0, 2, 0, 0, 2, 2]);

    assert.deepEqual(
        process(
            [survivor, malformedBelowThreshold],
            'nmm',
            'iou',
            0.5,
            0.35,
            { width: 5, height: 5 },
        ),
        [survivor],
    );
});

test('keeps missing and invalid confidence visible and excludes it from overlap processing', () => {
    const invalidScores: unknown[] = [undefined, Number.NaN, Infinity, -0.1, 1.1, '0.8'];
    const shapes = invalidScores.map((score, index) => ({
        ...rectangle(index, 1, undefined, [0, 0, 4, 4]),
        ...(score === undefined ? {} : { score }),
    })) as DetectorShape[];
    shapes.push(rectangle(10, 1, 0.9, [0, 0, 4, 4]));

    for (const method of ['nms', 'nmm', 'greedy_nmm'] as const) {
        assert.deepEqual(
            process(shapes, method, 'ios', 0, 1).map((shape) => shape.id),
            [0, 1, 2, 3, 4, 5],
        );
    }
});

test('passes through points, polylines, and unsupported shape types unchanged', () => {
    const base = rectangle(0, 1, 0.9, [0, 0, 4, 4]);
    const shapes: DetectorShape[] = [
        { ...base, id: 0, sourceIndex: 0, type: 'points', points: [2, 2] },
        { ...base, id: 1, sourceIndex: 1, type: 'polyline', points: [0, 0, 4, 4] },
        { ...base, id: 2, sourceIndex: 2, type: 'skeleton', points: [] },
    ];
    assert.deepEqual(process(shapes, 'nms', 'ios', 0, 0), shapes);
});

test('does not mutate nested detector input data under any processing method', () => {
    for (const method of ['disabled', 'nms', 'nmm', 'greedy_nmm'] as const) {
        const polygon: DetectorShape = {
            ...rectangle(1, 1, 0.8, [1, 0, 5, 4]),
            type: 'polygon',
            points: [1, 0, 5, 0, 5, 4, 1, 4],
        };
        const shapes = [
            {
                ...rectangle(0, 1, 0.9, [0, 0, 4, 4]),
                attributes: [{ spec_id: 7, value: '0.9000' }],
                confidenceAttributeSpecID: 7,
            },
            polygon,
            mask(2, 0.7, [0, 4, 0, 0, 1, 1], 2),
        ];
        const snapshot = structuredClone(shapes);

        process(shapes, method, 'iou', 0.3, 0, { width: 8, height: 6 });

        assert.deepEqual(shapes, snapshot, method);
    }
});

test('full NMM is transitive while greedy NMM follows only the anchor', () => {
    const chain = [
        rectangle(0, 1, 0.9, [0, 0, 4, 4]),
        rectangle(1, 1, 0.8, [2, 0, 6, 4]),
        rectangle(2, 1, 0.7, [4, 0, 8, 4]),
    ];
    assert.equal(process(chain, 'nmm', 'iou', 0.3, 0, { width: 10, height: 5 }).length, 1);
    assert.equal(process(chain, 'greedy_nmm', 'iou', 0.3, 0, { width: 10, height: 5 }).length, 2);
});

test('unions mask holes and disconnected foreground into tight CVAT RLE bounds', () => {
    const ring = mask(0, 0.9, [0, 4, 1, 4, 0, 0, 2, 2]);
    const center = mask(1, 0.8, [1, 1, 2, 1, 4, 0, 0, 2, 2]);
    const [filled] = process([ring, center], 'nmm', 'ios', 0.5, 0, { width: 3, height: 3 });
    assert.equal(filled.type, 'mask');
    assert.deepEqual(filled.points, [0, 9, 0, 0, 2, 2]);

    const left = mask(2, 0.9, [0, 1, 1, 1, 2, 0, 0, 4, 0]);
    const right = mask(3, 0.8, [2, 1, 1, 1, 0, 0, 4, 0]);
    const [disconnected] = process([left, right], 'nmm', 'ios', 0.5, 0, { width: 5, height: 1 });
    assert.deepEqual(disconnected.points, [0, 1, 1, 1, 1, 1, 0, 0, 4, 0]);
});

test('rejects an empty mask union instead of emitting an invalid CVAT RLE', () => {
    const emptyMasks = [
        mask(0, 0.9, [4, 0, 0, 1, 1]),
        mask(1, 0.8, [4, 0, 0, 1, 1]),
    ];
    const snapshot = structuredClone(emptyMasks);
    assert.equal(computeOverlap(emptyMasks[0], emptyMasks[1], 'iou', { width: 2, height: 2 }), 0);

    assert.throws(
        () => process(emptyMasks, 'nmm', 'iou', 0, 0, { width: 2, height: 2 }),
        (error: unknown) => error instanceof DetectorPostprocessingError && /empty.*mask.*foreground/i.test(error.message),
    );
    assert.deepEqual(emptyMasks, snapshot);
});

test('encloses axis-aligned and rotated rectangle groups', () => {
    const [axisAligned] = process([
        rectangle(0, 1, 0.9, [0, 0, 4, 4]),
        rectangle(1, 1, 0.8, [2, 0, 6, 4]),
    ], 'nmm', 'iou', 0.3, 0, { width: 8, height: 6 });
    assert.deepEqual(axisAligned.points, [0, 0, 6, 4]);
    assert.equal(axisAligned.rotation, 0);

    const [rotated] = process([
        rectangle(2, 1, 0.9, [1, 1, 5, 3], 90),
        rectangle(3, 1, 0.8, [2, 0, 4, 4]),
    ], 'nmm', 'iou', 1, 0, { width: 6, height: 5 });
    assert.deepEqual(rotated.points, [2, 0, 4, 4]);
    assert.equal(rotated.rotation, 0);
});

test('converts polygon, ellipse, and mixed geometry merges to exact union masks', () => {
    const polygon: DetectorShape = {
        ...rectangle(0, 1, 0.9, [0, 0, 2, 2]),
        type: 'polygon',
        points: [0, 0, 2, 0, 2, 2, 0, 2],
    };
    const ellipse: DetectorShape = {
        ...rectangle(1, 1, 0.8, [0, 0, 2, 2]),
        type: 'ellipse',
        points: [1, 1, 2, 0],
    };
    const [polygonMerged] = process([polygon, { ...polygon, id: 2, sourceIndex: 2 }], 'nmm', 'iou', 1);
    const [ellipseMerged] = process([ellipse, { ...ellipse, id: 3, sourceIndex: 3 }], 'nmm', 'iou', 1);
    const [mixed] = process([polygon, rectangle(4, 1, 0.7, [0, 0, 2, 2])], 'nmm', 'iou', 1);

    for (const result of [polygonMerged, ellipseMerged, mixed]) {
        assert.equal(result.type, 'mask');
        assert.deepEqual(result.points, [0, 4, 0, 0, 1, 1]);
        assert.equal(result.rotation, 0);
    }
});

test('uses maximum score and spreads anchor metadata while replacing only mapped confidence', () => {
    const high: DetectorShape = {
        ...rectangle(7, 1, 0.9, [0, 0, 4, 4]),
        attributes: [{ spec_id: 7, value: 'incorrect' }, { spec_id: 8, value: 'anchor' }],
        confidenceAttributeSpecID: 7,
        sourceIndex: 4,
    };
    const low = { ...rectangle(8, 1, 0.8, [2, 0, 6, 4]), sourceIndex: 1 };
    const [merged] = process([low, high], 'nmm', 'iou', 0.3, 0, { width: 8, height: 6 });

    assert.equal(merged.id, 7);
    assert.equal(merged.label_id, 1);
    assert.equal(merged.sourceIndex, 4);
    assert.equal(merged.score, 0.9);
    assert.deepEqual(merged.attributes, [
        { spec_id: 7, value: '0.9000' },
        { spec_id: 8, value: 'anchor' },
    ]);
    assert.deepEqual(high.attributes, [
        { spec_id: 7, value: 'incorrect' },
        { spec_id: 8, value: 'anchor' },
    ]);
});

test('appends mapped confidence when the anchor attribute is absent', () => {
    const high: DetectorShape = {
        ...rectangle(0, 1, 0.9, [0, 0, 4, 4]),
        attributes: [{ spec_id: 8, value: 'anchor' }],
        confidenceAttributeSpecID: 7,
    };
    const [merged] = process([
        high,
        rectangle(1, 1, 0.8, [2, 0, 6, 4]),
    ], 'nmm', 'iou', 0.3, 0, { width: 8, height: 6 });

    assert.deepEqual(merged.attributes, [
        { spec_id: 8, value: 'anchor' },
        { spec_id: 7, value: '0.9000' },
    ]);
});

test('rejects NMM results incompatible with mapped label types', () => {
    const polygon: DetectorShape = {
        ...rectangle(0, 1, 0.9, [0, 0, 4, 4]),
        type: 'polygon',
        points: [0, 0, 4, 0, 4, 4, 0, 4],
        targetLabelType: 'polygon',
    };
    const ellipse: DetectorShape = {
        ...rectangle(1, 1, 0.8, [0, 0, 4, 4]),
        type: 'ellipse',
        points: [2, 2, 4, 0],
        targetLabelType: 'polygon',
    };
    assert.throws(
        () => process([polygon, ellipse], 'nmm', 'ios', 0.5, 0, { width: 6, height: 6 }),
        /label 1.*mask/i,
    );

    const wrongRectangleTarget = [
        { ...rectangle(2, 2, 0.9, [0, 0, 4, 4]), targetLabelType: 'polygon' },
        { ...rectangle(3, 2, 0.8, [2, 0, 6, 4]), targetLabelType: 'polygon' },
    ];
    assert.throws(
        () => process(wrongRectangleTarget, 'greedy_nmm', 'iou', 0.3, 0, { width: 8, height: 6 }),
        /label 2.*rectangle/i,
    );
});

test('rejects malformed CVAT RLE and invalid frame sizes', () => {
    const malformedMasks = [
        mask(0, 0.9, [0, 2, 0, 0, 2, 2]),
        mask(1, 0.9, [0, -1, 2, 0, 0, 0, 0]),
        mask(2, 0.9, [0.5, 0.5, 0, 0, 0, 0]),
        mask(3, 0.9, [0, 1, 0, 2, 2, 1, 1]),
    ];
    for (const malformed of malformedMasks) {
        assert.throws(() => computeOverlap(malformed, malformed, 'iou', { width: 3, height: 3 }), /RLE/i);
    }

    for (const frame of [
        { width: 0, height: 1 },
        { width: 1.5, height: 2 },
        { width: Number.NaN, height: 2 },
    ]) {
        assert.throws(
            () => computeOverlap(rectangle(0, 1, 0.9, [0, 0, 1, 1]), rectangle(1, 1, 0.8, [0, 0, 1, 1]), 'iou', frame),
            /frame/i,
        );
    }
});

test('rejects raster working regions above 64 million pixels', () => {
    assert.throws(() => processDetectorShapes(
        [rectangle(0, 1, 0.9, [0, 0, 9000, 9000])],
        { width: 9001, height: 9001 },
        {
            confidenceThreshold: 0,
            postprocessing: { method: 'nmm', metric: 'iou', threshold: 0.5 },
        },
    ), /64 million pixels/i);
});

test('processes and encodes tall sparse masks within the 64-million-pixel limit', () => {
    const tallSparseRLE = [0, 1, 999_999, 1, 0, 0, 0, 1_000_000];
    const first = mask(0, 0.9, tallSparseRLE);
    const second = mask(1, 0.8, tallSparseRLE);
    const frame = { width: 1, height: 1_000_001 };

    assert.equal(computeOverlap(first, second, 'iou', frame), 1);
    const [merged] = process([first, second], 'nmm', 'iou', 1, 0, frame);
    assert.equal(merged.type, 'mask');
    assert.deepEqual(merged.points, tallSparseRLE);
});

test('processes near-limit dense tall masks as compact vertical bands', () => {
    const height = 63_000_000;
    const denseTallRLE = [0, height, 0, 0, 0, height - 1];
    const first = mask(0, 0.9, denseTallRLE);
    const second = mask(1, 0.8, denseTallRLE);
    const frame = { width: 1, height };

    assert.equal(computeOverlap(first, second, 'iou', frame), 1);
    const [merged] = process([first, second], 'nmm', 'iou', 1, 0, frame);
    assert.equal(merged.type, 'mask');
    assert.deepEqual(merged.points, denseTallRLE);
});

test('allows an encoded RLE output at the one-million-count boundary', () => {
    const height = 499_999;
    const leftColumn = mask(0, 0.9, [0, height, 0, 0, 0, height - 1]);
    const rightColumn = mask(1, 0.8, [0, height, 2, 0, 2, height - 1]);
    const [merged] = process(
        [leftColumn, rightColumn],
        'nmm',
        'iou',
        0,
        0,
        { width: 3, height },
    );

    assert.equal(merged.points.length, 1_000_004);
    assert.deepEqual(merged.points.slice(-4), [0, 0, 2, height - 1]);
});

test('rejects pathological encoded RLE output before count allocation exhausts memory', () => {
    const height = 4_000_000;
    const leftColumn = mask(0, 0.9, [0, height, 0, 0, 0, height - 1]);
    const rightColumn = mask(1, 0.8, [0, height, 2, 0, 2, height - 1]);

    assert.throws(
        () => process(
            [leftColumn, rightColumn],
            'nmm',
            'iou',
            0,
            0,
            { width: 3, height },
        ),
        (error: unknown) => error instanceof DetectorPostprocessingError &&
            /encoded.*RLE.*1 million counts/i.test(error.message),
    );
});

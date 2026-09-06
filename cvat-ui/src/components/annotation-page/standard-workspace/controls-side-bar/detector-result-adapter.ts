// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import {
    getCore, Label, ObjectState, ObjectType, ShapeType, Source,
} from 'cvat-core-wrapper';
import type { InteractionData } from 'cvat-canvas-wrapper';
import type { DetectorShape } from 'utils/detector-postprocessing';

interface SerializedDetectorAttribute {
    spec_id: number;
    value: string;
}

export interface SerializedDetectorElement {
    label_id: number;
    frame: number;
    group: number;
    source: Source;
    type: ShapeType;
    points: number[];
    rotation?: number;
    occluded: boolean;
    outside: boolean;
    z_order: number;
    attributes: SerializedDetectorAttribute[];
}

export interface SerializedDetectorShape extends SerializedDetectorElement {
    id?: number;
    score?: number;
    elements?: SerializedDetectorElement[];
}

export interface SerializedDetectorTag {
    id?: number;
    label_id: number;
    frame: number;
    group: number;
    source: Source;
    attributes: SerializedDetectorAttribute[];
}

export interface SerializedDetectorResult {
    tags: SerializedDetectorTag[];
    shapes: SerializedDetectorShape[];
    tracks: unknown[];
}

type NormalizedDetectorShape = DetectorShape & SerializedDetectorShape;

const core = getCore();

function findMappedLabel(labels: Label[], labelID: number): Label {
    const label = labels.find(({ id }) => id === labelID);
    if (!label) {
        throw new Error(`Mapped label ${labelID} was not found in the current job`);
    }
    return label;
}

function loadAttributes(attributes: SerializedDetectorAttribute[]): Record<number, string> {
    return Object.fromEntries(attributes.map(({ spec_id: specID, value }) => [specID, value]));
}

export function normalizeDetectorShapes(
    shapes: SerializedDetectorShape[],
    labels: Label[],
): DetectorShape[] {
    return shapes.map((shape, sourceIndex): NormalizedDetectorShape => {
        const label = findMappedLabel(labels, shape.label_id);
        const confidenceAttributeSpecID = label.attributes.find(
            ({ name }) => name === 'model_confidence',
        )?.id;
        const { score, ...serialized } = shape;
        return {
            ...serialized,
            ...(score === undefined ? {} : { score }),
            points: [...shape.points],
            attributes: shape.attributes.map((attribute) => ({ ...attribute })),
            elements: shape.elements?.map((element) => ({
                ...element,
                points: [...element.points],
                attributes: element.attributes.map((attribute) => ({ ...attribute })),
            })),
            sourceIndex,
            targetLabelType: label.type,
            ...(confidenceAttributeSpecID === undefined ? {} : { confidenceAttributeSpecID }),
        };
    });
}

export function toTemporaryCanvasShapes(
    shapes: DetectorShape[],
): InteractionData['payload']['shapes'] {
    return shapes.map((shape) => ({
        shapeType: shape.type,
        points: [...shape.points],
        rotation: shape.rotation,
    }));
}

export function toObjectStates(
    result: { tags: SerializedDetectorTag[]; shapes: DetectorShape[] },
    context: { labels: Label[]; frame: number; zOrder: number },
): ObjectState[] {
    const { labels, frame, zOrder } = context;
    const tagStates = result.tags.map((tag) => new core.classes.ObjectState({
        attributes: loadAttributes(tag.attributes),
        frame,
        label: findMappedLabel(labels, tag.label_id),
        objectType: ObjectType.TAG,
        source: tag.source,
    }));
    const shapeStates = result.shapes.map((detectorShape) => {
        const shape = detectorShape as NormalizedDetectorShape;
        const label = findMappedLabel(labels, shape.label_id);
        const elements = shape.elements?.map((element) => {
            const sublabel = label.structure?.sublabels.find(({ id }) => id === element.label_id);
            if (!sublabel) {
                throw new Error(
                    `Mapped sublabel ${element.label_id} was not found under label ${shape.label_id}`,
                );
            }
            return {
                attributes: loadAttributes(element.attributes),
                frame,
                label: sublabel,
                objectType: ObjectType.SHAPE,
                occluded: element.occluded,
                outside: element.outside,
                points: [...element.points],
                rotation: element.rotation,
                shapeType: element.type,
                source: element.source,
            };
        });
        return new core.classes.ObjectState({
            attributes: loadAttributes(shape.attributes),
            elements,
            frame,
            label,
            objectType: ObjectType.SHAPE,
            occluded: shape.occluded,
            outside: shape.outside,
            points: [...shape.points],
            rotation: shape.rotation,
            ...(shape.score === undefined ? {} : { score: shape.score }),
            shapeType: shape.type,
            source: shape.source,
            zOrder,
        });
    });

    return [...tagStates, ...shapeStates];
}

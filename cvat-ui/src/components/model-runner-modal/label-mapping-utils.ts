// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import { Label } from 'cvat-core-wrapper';
import type { LabelInterface, FullMapping } from './label-mapping-types';

export type ServerMapping = Record<string, {
    name: string;
    attributes: Record<string, string>;
    sublabels?: ServerMapping;
}>;

export function convertTaskLabels(labels: Label[]): LabelInterface[] {
    return labels.map((label) => ({
        name: label.name,
        type: label.type,
        color: label.color,
        attributes: label.attributes.map((attr) => ({
            name: attr.name,
            input_type: attr.inputType,
            values: [...attr.values],
        })),
        sublabels: (label.structure?.sublabels || []).map((sublabel) => ({
            name: sublabel.name,
            type: sublabel.type,
            color: sublabel.color,
            attributes: sublabel.attributes.map((attr) => ({
                name: attr.name,
                input_type: attr.inputType,
                values: [...attr.values],
            })),
        })),
    }));
}

export function convertModelLabels(model: { labels: any[] }): LabelInterface[] {
    return model.labels;
}

export function convertMappingToServer(mapping: FullMapping): ServerMapping {
    return mapping.reduce<ServerMapping>((acc, [modelLabel, taskLabel, attributesMapping, subMapping]) => (
        {
            ...acc,
            [modelLabel.name]: {
                name: taskLabel.name,
                attributes: attributesMapping.reduce<Record<string, string>>((attrAcc, val) => {
                    if (val[0]?.name && val[1]?.name) {
                        attrAcc[val[0].name] = val[1].name;
                    }
                    return attrAcc;
                }, {}),
                ...(subMapping.length ? { sublabels: convertMappingToServer(subMapping) } : {}),
            },
        }
    ), {});
}

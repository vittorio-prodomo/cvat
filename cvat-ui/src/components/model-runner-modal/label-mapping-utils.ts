// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import { Label, LabelType } from 'cvat-core-wrapper';
import { LabelInterface, FullMapping } from './labels-mapper';

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

export function labelsCompatible(modelLabel: LabelInterface, jobLabel: LabelInterface): boolean {
    const { type: modelLabelType } = modelLabel;
    const { type: jobLabelType } = jobLabel;
    const compatibleTypes = [[LabelType.MASK, LabelType.POLYGON]];

    return modelLabelType === jobLabelType ||
        (jobLabelType === LabelType.ANY && modelLabelType !== LabelType.SKELETON) ||
        (modelLabelType === LabelType.ANY && jobLabelType !== LabelType.SKELETON) ||
        compatibleTypes.some((compatible) => compatible.includes(jobLabelType) && compatible.includes(modelLabelType));
}

export function computeLabelsAutoMapping(
    modelLabels: LabelInterface[],
    taskLabels: LabelInterface[],
): [LabelInterface, LabelInterface][] {
    const autoMapping: [LabelInterface, LabelInterface][] = [];

    for (let i = 0; i < modelLabels.length; i++) {
        for (let j = 0; j < taskLabels.length; j++) {
            const modelLabel = modelLabels[i];
            const taskLabel = taskLabels[j];

            if (modelLabel.name === taskLabel.name && labelsCompatible(modelLabel, taskLabel)) {
                autoMapping.push([modelLabel, taskLabel]);
            }
        }
    }

    return autoMapping;
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

export function computeAutoServerMapping(model: { labels: any[] }, labels: Label[]): ServerMapping {
    return convertMappingToServer(computeLabelsAutoMapping(
        convertModelLabels(model),
        convertTaskLabels(labels),
    ).map(([modelLabel, taskLabel]) => [modelLabel, taskLabel, [], []]));
}

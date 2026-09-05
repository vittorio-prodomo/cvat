// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import type {
    AttributeInterface, FullMapping, LabelInterface, Md2JobAttributesMapping,
} from './label-mapping-types';

type PairLabels = (
    model: LabelInterface[], task: LabelInterface[],
) => [LabelInterface, LabelInterface][];

export function computeAttributesAutoMapping(
    modelAttributes: AttributeInterface[] = [],
    taskAttributes: AttributeInterface[] = [],
): Md2JobAttributesMapping {
    return modelAttributes.flatMap((modelAttribute) => taskAttributes
        .filter((taskAttribute) => modelAttribute.name === taskAttribute.name)
        .map((taskAttribute): Md2JobAttributesMapping[0] => [modelAttribute, taskAttribute]));
}

export function buildAutoMappingEntry(
    modelLabel: LabelInterface,
    taskLabel: LabelInterface,
    pairLabels: PairLabels,
): FullMapping[0] {
    const sublabels = modelLabel.type === 'skeleton' && taskLabel.type === 'skeleton' ?
        pairLabels(modelLabel.sublabels ?? [], taskLabel.sublabels ?? []).map(
            ([modelSublabel, taskSublabel]) => buildAutoMappingEntry(
                modelSublabel, taskSublabel, pairLabels,
            ),
        ) : [];
    return [
        modelLabel,
        taskLabel,
        computeAttributesAutoMapping(modelLabel.attributes, taskLabel.attributes),
        sublabels,
    ];
}

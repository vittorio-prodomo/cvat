// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import { LabelType } from 'cvat-core-wrapper';

interface AutoMappingLabel {
    name: string;
    type: LabelType;
}

export function labelsCompatible(modelLabel: AutoMappingLabel, taskLabel: AutoMappingLabel): boolean {
    const { type: modelLabelType } = modelLabel;
    const { type: taskLabelType } = taskLabel;
    const compatibleTypes = [[LabelType.MASK, LabelType.POLYGON]];
    return modelLabelType === taskLabelType ||
        (taskLabelType === LabelType.ANY && modelLabelType !== LabelType.SKELETON) ||
        (modelLabelType === LabelType.ANY && taskLabelType !== LabelType.SKELETON) ||
        compatibleTypes.some((compatible) => compatible.includes(taskLabelType) && compatible.includes(modelLabelType));
}

export function computeLabelsAutoMapping<
    ModelLabel extends AutoMappingLabel,
    TaskLabel extends AutoMappingLabel,
>(modelLabels: ModelLabel[], taskLabels: TaskLabel[]): [ModelLabel, TaskLabel][] {
    const autoMapping: [ModelLabel, TaskLabel][] = [];

    for (const modelLabel of modelLabels) {
        const exactMatches = taskLabels.filter((taskLabel) => (
            modelLabel.name === taskLabel.name && labelsCompatible(modelLabel, taskLabel)
        ));

        if (exactMatches.length) {
            autoMapping.push(...exactMatches.map((taskLabel): [ModelLabel, TaskLabel] => [modelLabel, taskLabel]));
            continue;
        }

        if (/^C\d+$/.test(modelLabel.name)) {
            const fallbackMatches = taskLabels.filter((taskLabel) => (
                taskLabel.name.startsWith(`${modelLabel.name}_`) && labelsCompatible(modelLabel, taskLabel)
            ));

            if (fallbackMatches.length === 1) {
                autoMapping.push([modelLabel, fallbackMatches[0]]);
            }
        }
    }

    return autoMapping;
}

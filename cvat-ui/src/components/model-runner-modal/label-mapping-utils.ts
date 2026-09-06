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
                        return {
                            ...attrAcc,
                            [val[0].name]: val[1].name,
                        };
                    }
                    return attrAcc;
                }, {}),
                ...(subMapping.length ? { sublabels: convertMappingToServer(subMapping) } : {}),
            },
        }
    ), {});
}

export function resolvePostprocessingLabelGroups(
    modelGroups: string[][],
    mapping: FullMapping,
    taskLabels: Pick<Label, 'id' | 'name'>[],
): number[][] {
    const mappedTaskNameByModelName = new Map(
        mapping.map(([modelLabel, taskLabel]) => [modelLabel.name, taskLabel.name]),
    );
    const taskIDByName = new Map(taskLabels.map(({ id, name }) => [name, id]));

    const resolvedGroups = modelGroups.reduce<number[][]>((groups, group) => {
        const taskLabelIDs = Array.from(new Set(group.flatMap((modelLabelName) => {
            const taskLabelName = mappedTaskNameByModelName.get(modelLabelName);
            if (!taskLabelName) return [];
            const taskLabelID = taskIDByName.get(taskLabelName);
            return Number.isSafeInteger(taskLabelID) ? [taskLabelID] : [];
        })));
        if (taskLabelIDs.length > 1) {
            groups.push(taskLabelIDs);
        }
        return groups;
    }, []);

    const parents = new Map<number, number>();
    const find = (labelID: number): number => {
        const parent = parents.get(labelID) ?? labelID;
        if (parent === labelID) return labelID;
        const root = find(parent);
        parents.set(labelID, root);
        return root;
    };
    for (const group of resolvedGroups) {
        for (const labelID of group) parents.set(labelID, parents.get(labelID) ?? labelID);
        const groupRoot = find(group[0]);
        for (const labelID of group.slice(1)) parents.set(find(labelID), groupRoot);
    }

    const components = new Map<number, number[]>();
    for (const labelID of resolvedGroups.flat()) {
        const root = find(labelID);
        const component = components.get(root) ?? [];
        if (!component.includes(labelID)) component.push(labelID);
        components.set(root, component);
    }
    return Array.from(components.values());
}

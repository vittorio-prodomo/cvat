// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import type { Attribute, Label } from 'cvat-core-wrapper';

export type Md2JobAttributesMapping = [AttributeInterface | null, AttributeInterface | null][];
export type Md2JobLabelsMapping = [LabelInterface, LabelInterface][];

// The latest tuple element is child mapping (e.g. for skeleton points)
export type FullMapping = [LabelInterface, LabelInterface, Md2JobAttributesMapping, FullMapping][];

export interface AttributeInterface {
    name: Attribute['name'];
    values: Attribute['values'];
    input_type: Attribute['inputType'];
}

export interface LabelInterface {
    name: Label['name'];
    type: Label['type'];
    color?: Label['color'];
    attributes?: AttributeInterface[];
    sublabels?: Omit<LabelInterface, 'sublabels'>[];
}

// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import Text from 'antd/lib/typography/Text';
import { ArrowRightOutlined } from '@ant-design/icons';
import Tag from 'antd/lib/tag';

import { Label, MLModel } from 'cvat-core-wrapper';
import LabelsMapperComponent, { FullMapping } from '../../../model-runner-modal/labels-mapper';
import {
    convertTaskLabels,
    convertModelLabels,
    ServerMapping,
    convertMappingToServer,
} from '../../../model-runner-modal/label-mapping-utils';

interface Props {
    interactor: MLModel;
    labels: Label[];
    onMappingChange: (mapping: ServerMapping) => void;
}

function InteractorLabelMapper(props: Props): JSX.Element | null {
    const { interactor, labels, onMappingChange } = props;
    const modelLabels = convertModelLabels(interactor);
    const taskLabels = convertTaskLabels(labels);

    // Only show mapper if interactor has labels_v2
    if (!modelLabels || modelLabels.length === 0) {
        return null;
    }

    return (
        <div className='cvat-interactor-label-mapper-wrapper'>
            <div className='cvat-interactor-label-mapper-header'>
                <div>
                    <Text strong>Setup label mapping</Text>
                </div>
                <div>
                    <Tag>Model Labels</Tag>
                    <ArrowRightOutlined />
                    <Tag>Task Labels</Tag>
                </div>
            </div>
            <LabelsMapperComponent
                key={interactor.id}
                onUpdateMapping={(mapping: FullMapping) => {
                    const serverMapping = convertMappingToServer(mapping);
                    onMappingChange(serverMapping);
                }}
                modelLabels={modelLabels}
                taskLabels={taskLabels}
            />
        </div>
    );
}

export default React.memo(InteractorLabelMapper);

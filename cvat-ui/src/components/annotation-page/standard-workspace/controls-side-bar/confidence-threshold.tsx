// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import ReactDOM from 'react-dom';
import Text from 'antd/lib/typography/Text';
import Slider from 'antd/lib/slider';
import { Col, Row } from 'antd/lib/grid';

interface Props {
    thresholdValue: number;
    children?: React.ReactNode;
    onChange(value: number): void;
}

export const MIN_THRESHOLD = 0.2;
export const MAX_THRESHOLD = 0.9;

function ConfidenceThreshold(props: Props): React.ReactPortal | null {
    const { thresholdValue, onChange, children } = props;
    const target = window.document.getElementsByClassName('cvat-canvas-container')[0];

    return target ?
        ReactDOM.createPortal(
            <Row
                align='middle'
                className={`cvat-interactor-threshold-wrapper${children ? ' cvat-interactor-with-morphology' : ''}`}
            >
                <Col span={24}>
                    <Slider
                        value={thresholdValue}
                        min={MIN_THRESHOLD}
                        max={MAX_THRESHOLD}
                        step={0.01}
                        tooltip={{
                            open: false,
                        }}
                        onChange={onChange}
                    />
                </Col>
                <Text type='secondary'>minimum confidence filter</Text>
                {children && <Col span={24}>{children}</Col>}
            </Row>,
            target,
        ) :
        null;
}

export default React.memo(ConfidenceThreshold);

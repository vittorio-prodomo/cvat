// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT

import React from 'react';
import Button from 'antd/lib/button';
import Slider from 'antd/lib/slider';
import Text from 'antd/lib/typography/Text';
import './mask-morphology-control.scss';

interface Props {
    value: number;
    disabled: boolean;
    pending: boolean;
    onChange(value: number): void;
}

function MaskMorphologyControl({
    value, disabled, pending, onChange,
}: Props): JSX.Element {
    let status = pending ? 'Updating mask…' : 'Applied to the selected mask';
    if (disabled) status = 'Select a mask to adjust';
    // AntD forwards this rc-slider property, but omits it from its public types.
    const accessibility = { ariaLabelForHandle: 'Mask erosion or dilation in pixels' };
    return (
        <div className='cvat-mask-morphology-control'>
            <div className='cvat-mask-morphology-heading'>
                <Text>Mask adjustment</Text>
                <Text>{`${value > 0 ? '+' : ''}${value} px`}</Text>
                <Button size='small' disabled={disabled || value === 0} onClick={() => onChange(0)}>Reset</Button>
            </div>
            <Slider
                {...accessibility}
                min={-20}
                max={20}
                step={1}
                value={value}
                disabled={disabled}
                included={false}
                marks={{ '-20': 'Erode', 0: '0', 20: 'Dilate' }}
                tooltip={{ formatter: (radius) => `${radius && radius > 0 ? '+' : ''}${radius} px` }}
                onChange={onChange}
            />
            <Text type='secondary' role='status' className='cvat-mask-morphology-status'>
                {status}
            </Text>
        </div>
    );
}

export default React.memo(MaskMorphologyControl);

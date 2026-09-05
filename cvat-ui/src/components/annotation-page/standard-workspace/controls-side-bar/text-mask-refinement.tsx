// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT

import React from 'react';
import ReactDOM from 'react-dom';
import Button from 'antd/lib/button';
import Select from 'antd/lib/select';
import Text from 'antd/lib/typography/Text';
import './text-mask-refinement.scss';

interface Props {
    masks: number[];
    selected: number | null;
    fetching: boolean;
    adjusting?: boolean;
    onSelect(index: number): void;
    onBack(): void;
    onDone(): void;
}

function TextMaskRefinement(props: Props): React.ReactPortal | null {
    const {
        masks, selected, fetching, adjusting = false, onSelect, onBack, onDone,
    } = props;
    const target = window.document.getElementsByClassName('cvat-canvas-container')[0];
    if (!target) return null;

    return ReactDOM.createPortal(
        <div className='cvat-text-mask-refinement'>
            <Text strong>{selected === null ? 'Refine text results' : `Refining mask ${selected + 1}`}</Text>
            <Select
                aria-label='Mask to refine'
                placeholder='Click a mask or select one'
                value={selected ?? undefined}
                options={masks.map((index) => ({ value: index, label: `Mask ${index + 1}` }))}
                onChange={onSelect}
            />
            <Text type='secondary'>
                {selected === null ? 'Choose a mask to adjust its boundary.' : 'Left click: include · Right click: exclude'}
            </Text>
            {fetching && <Text role='status'>Updating mask…</Text>}
            <div className='cvat-text-mask-refinement-actions'>
                {selected !== null && <Button onClick={onBack}>Back to masks</Button>}
                <Button type='primary' disabled={adjusting} onClick={onDone}>Done</Button>
            </div>
        </div>,
        target,
    );
}

export default React.memo(TextMaskRefinement);

// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import ReactDOM from 'react-dom';
import Button from 'antd/lib/button';
import Slider from 'antd/lib/slider';
import Text from 'antd/lib/typography/Text';

interface Props {
    rawCount: number;
    visibleCount: number;
    confidence: number;
    processing: boolean;
    error: string | null;
    onConfidenceChange(value: number): void;
    onRetry(): void;
    onCancel(): void;
    onDone(): void;
}

function DetectorPreview({
    rawCount,
    visibleCount,
    confidence,
    processing,
    error,
    onConfidenceChange,
    onRetry,
    onCancel,
    onDone,
}: Props): React.ReactPortal | null {
    const target = window.document.getElementsByClassName('cvat-canvas-container')[0];
    if (!target) return null;

    // AntD forwards this rc-slider property, but omits it from its public types.
    const accessibility = { ariaLabelForHandle: 'Minimum detector confidence' };
    return ReactDOM.createPortal(
        <div className='cvat-detector-preview-wrapper'>
            <div className='cvat-detector-preview-header'>
                <Text>{`${visibleCount} / ${rawCount} results`}</Text>
                <Text>{confidence.toFixed(2)}</Text>
            </div>
            <div className='cvat-detector-preview-slider'>
                <Slider
                    {...accessibility}
                    min={0.1}
                    max={1}
                    step={0.01}
                    value={confidence}
                    tooltip={{ open: false }}
                    onChange={onConfidenceChange}
                />
            </div>
            {error && (
                <Text className='cvat-detector-preview-error' type='danger' role='alert'>
                    {error}
                </Text>
            )}
            <div className='cvat-detector-preview-actions'>
                {error && (
                    <Button
                        className='cvat-detector-preview-retry'
                        disabled={processing}
                        onClick={onRetry}
                    >
                        Retry
                    </Button>
                )}
                <Button className='cvat-detector-preview-cancel' onClick={onCancel}>Cancel</Button>
                <Button
                    className='cvat-detector-preview-done'
                    type='primary'
                    disabled={processing || error !== null}
                    onClick={onDone}
                >
                    Done
                </Button>
            </div>
        </div>,
        target,
    );
}

export default React.memo(DetectorPreview);

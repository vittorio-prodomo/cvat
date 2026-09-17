// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { EyeInvisibleOutlined } from '@ant-design/icons';
import Button from 'antd/lib/button';
import notification from 'antd/lib/notification';
import { DimensionType } from 'cvat-core-wrapper';
import { Canvas } from 'cvat-canvas-wrapper';

import { CombinedState } from 'reducers';
import { registerComponentShortcuts } from 'actions/shortcuts-actions';
import { switchCleanImageMode } from 'actions/annotation-actions';
import CVATTooltip from 'components/common/cvat-tooltip';
import GlobalHotKeys, { KeyMap } from 'utils/mousetrap-react';
import { ShortcutScope } from 'utils/enums';
import { subKeyMap } from 'utils/component-subkeymap';
import { canEnterCleanImageMode } from 'utils/clean-image-mode';
import { shallowEqual } from 'utils/redux';

const CLEAN_IMAGE_MODE_OPERATION_WARNING_KEY = 'clean-image-mode-operation-warning';

export const cleanImageModeShortcuts = {
    TOGGLE_CLEAN_IMAGE_MODE: {
        name: 'Toggle clean image mode',
        description: 'Temporarily show only the source image and hide annotation and review overlays',
        sequences: ['shift+h'],
        scope: ShortcutScope.ANNOTATION_PAGE,
    },
};

registerComponentShortcuts(cleanImageModeShortcuts);

export function CleanImageModeControl(): JSX.Element | null {
    const dispatch = useDispatch();
    const {
        keyMap,
        normalizedKeyMap,
        cleanImageMode,
        detectorInferencePending,
        activeControl,
        canvasInstance,
        objectState,
        jobInstance,
    } = useSelector((state: CombinedState) => ({
        keyMap: state.shortcuts.keyMap,
        normalizedKeyMap: state.shortcuts.normalizedKeyMap,
        cleanImageMode: state.annotation.canvas.cleanImageMode,
        detectorInferencePending: state.annotation.canvas.detectorInferencePending,
        activeControl: state.annotation.canvas.activeControl,
        canvasInstance: state.annotation.canvas.instance,
        objectState: state.annotation.editing.objectState,
        jobInstance: state.annotation.job.instance,
    }), shallowEqual);

    const is2DImageJob = jobInstance?.dimension === DimensionType.DIMENSION_2D && jobInstance.mediaType !== 'audio';

    if (!is2DImageJob) {
        return null;
    }

    const toggleCleanImageMode = (): void => {
        if (cleanImageMode) {
            dispatch(switchCleanImageMode(false));
            return;
        }

        if (
            !(canvasInstance instanceof Canvas) ||
            !canEnterCleanImageMode(
                activeControl, canvasInstance.mode(), Boolean(objectState), detectorInferencePending,
            )
        ) {
            notification.warning({
                key: CLEAN_IMAGE_MODE_OPERATION_WARNING_KEY,
                message: 'Finish or cancel the current canvas operation before entering clean-image mode.',
            });
            return;
        }

        dispatch(switchCleanImageMode(true));
    };

    const handlers: Record<keyof typeof cleanImageModeShortcuts, (event?: KeyboardEvent) => void> = {
        TOGGLE_CLEAN_IMAGE_MODE: (event: KeyboardEvent | undefined) => {
            if (event?.repeat) {
                return;
            }
            event?.preventDefault();
            toggleCleanImageMode();
        },
    };

    const restoreAction = normalizedKeyMap.TOGGLE_CLEAN_IMAGE_MODE ?
        `${normalizedKeyMap.TOGGLE_CLEAN_IMAGE_MODE} to restore` : 'Click to restore';
    const restoreTooltip = [
        'Annotations and review overlays are temporarily hidden · ',
        restoreAction,
    ].join('');

    return (
        <>
            <GlobalHotKeys keyMap={subKeyMap(cleanImageModeShortcuts, keyMap as KeyMap)} handlers={handlers} />
            {cleanImageMode && (
                <CVATTooltip overlay={restoreTooltip}>
                    <Button
                        type='link'
                        aria-pressed
                        className='cvat-clean-image-mode-indicator cvat-annotation-header-button cvat-button-active'
                        onClick={toggleCleanImageMode}
                    >
                        <EyeInvisibleOutlined />
                        Clean
                    </Button>
                </CVATTooltip>
            )}
        </>
    );
}

export default React.memo(CleanImageModeControl);

// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT

import { CanvasMode } from 'cvat-canvas-wrapper';
import { ActiveControl } from 'reducers';

const SAFE_ACTIVE_CONTROLS = new Set<ActiveControl>([
    ActiveControl.CURSOR,
    ActiveControl.DRAG_CANVAS,
    ActiveControl.ZOOM_CANVAS,
]);

const SAFE_CANVAS_MODES = new Set<CanvasMode>([
    CanvasMode.IDLE,
    CanvasMode.DRAG_CANVAS,
    CanvasMode.ZOOM_CANVAS,
]);

export function isSafeCleanImageActiveControl(activeControl: ActiveControl): boolean {
    return SAFE_ACTIVE_CONTROLS.has(activeControl);
}

export function shouldKeepCleanImageMode(
    currentEnabled: boolean,
    activeControl: ActiveControl,
    startsAnnotation: boolean,
): boolean {
    return currentEnabled && !startsAnnotation && isSafeCleanImageActiveControl(activeControl);
}

export function canEnterCleanImageMode(
    activeControl: ActiveControl,
    canvasMode: CanvasMode,
    hasEditedObject: boolean,
    detectorInferencePending: boolean,
): boolean {
    return !hasEditedObject && !detectorInferencePending &&
        isSafeCleanImageActiveControl(activeControl) &&
        SAFE_CANVAS_MODES.has(canvasMode);
}

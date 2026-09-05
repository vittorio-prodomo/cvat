// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import { processDetectorShapes } from './detector-postprocessing.ts';
import type {
    DetectorProcessingRequest,
    DetectorProcessingResponse,
} from './detector-postprocessing-client';

// eslint-disable-next-line no-restricted-globals -- This module runs only in a Web Worker.
const scope = self as unknown as {
    onmessage: (event: MessageEvent<DetectorProcessingRequest>) => void;
    postMessage: (response: DetectorProcessingResponse) => void;
};

scope.onmessage = ({ data }): void => {
    const id = Number.isSafeInteger(data?.id) ? data.id : -1;
    let response: DetectorProcessingResponse;
    try {
        if (id < 1) throw new Error('Invalid detector postprocessing request ID');
        response = {
            id,
            shapes: processDetectorShapes(data.shapes, data.frame, data.options),
        };
    } catch (error: unknown) {
        response = {
            id,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    scope.postMessage(response);
};

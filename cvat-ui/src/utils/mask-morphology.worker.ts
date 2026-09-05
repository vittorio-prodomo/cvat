// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import { MaskMorphologyEngine } from './mask-morphology';
import type { MorphologyRequest, MorphologyResponse } from './mask-morphology-client';

const engine = new MaskMorphologyEngine();
// eslint-disable-next-line no-restricted-globals -- This module runs only in a Web Worker.
const scope = self as unknown as {
    onmessage: (event: MessageEvent<MorphologyRequest>) => void;
    postMessage: (message: MorphologyResponse, transfer?: ArrayBuffer[]) => void;
};

scope.onmessage = ({ data }): void => {
    const id = Number.isSafeInteger(data?.id) ? data.id : -1;
    try {
        if (id < 0) throw new Error('Invalid mask morphology request ID');
        const rle = engine.apply(data.rle, data.radius, data.bounds);
        scope.postMessage({ id, rle }, [rle.buffer as ArrayBuffer]);
    } catch (error: unknown) {
        scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
};

// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import type { MaskBounds } from './mask-morphology';

export interface MorphologyRequest {
    id: number;
    rle: Int32Array;
    radius: number;
    bounds: MaskBounds;
}

export interface MorphologyResponse {
    id: number;
    rle?: Int32Array;
    error?: string;
}

interface PendingRequest extends MorphologyRequest {
    source: Int32Array;
    resolve: (result: Int32Array | null) => void;
    reject: (error: Error) => void;
}

export default class MaskMorphologyClient {
    private worker: Worker | null = null;
    private active: PendingRequest | null = null;
    private pending = new Map<Int32Array, PendingRequest>();
    private nextID = 0;
    private disposed = false;

    public constructor() {
        try {
            this.startWorker();
        } catch {
            // apply() retries startup and reports persistent failures through
            // its promise, allowing the UI's normal retry/error path to run.
            this.worker = null;
        }
    }

    private startWorker(): void {
        const worker = new Worker(new URL('./mask-morphology.worker.ts', import.meta.url));
        this.worker = worker;
        worker.onmessage = (event: MessageEvent<MorphologyResponse>): void => {
            if (this.worker !== worker || this.disposed) return;
            const request = this.active;
            const response = event.data;
            if (!request || !response || response.id !== request.id ||
                (typeof response.error !== 'string' && !(response.rle instanceof Int32Array))) {
                this.failWorker(new Error('Invalid mask morphology worker response'));
                return;
            }
            this.active = null;
            if (typeof response.error === 'string') request.reject(new Error(response.error));
            else request.resolve(response.rle!);
            this.dispatch();
        };
        worker.onerror = (event): void => {
            if (this.worker !== worker) return;
            event.preventDefault();
            this.failWorker(new Error(event.message || 'Mask morphology worker failed'));
        };
        worker.onmessageerror = (): void => {
            if (this.worker === worker) this.failWorker(new Error('Unable to read mask morphology worker response'));
        };
    }

    private stopWorker(): void {
        if (this.worker) {
            this.worker.onmessage = null;
            this.worker.onerror = null;
            this.worker.onmessageerror = null;
            this.worker.terminate();
            this.worker = null;
        }
    }

    private failWorker(error: Error): void {
        this.stopWorker();
        this.active?.reject(error);
        this.active = null;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
    }

    private dispatch(): void {
        if (this.disposed || this.active || !this.pending.size) return;
        const request = this.pending.values().next().value!;
        this.pending.delete(request.source);
        this.active = request;
        try {
            if (!this.worker) this.startWorker();
            const {
                id, rle, radius, bounds,
            } = request;
            this.worker!.postMessage({
                id, rle, radius, bounds,
            }, [rle.buffer as ArrayBuffer]);
        } catch (error: unknown) {
            this.failWorker(error instanceof Error ? error : new Error(String(error)));
        }
    }

    public apply(rle: Int32Array, radius: number, bounds: MaskBounds): Promise<Int32Array | null> {
        if (this.disposed) return Promise.resolve(null);
        return new Promise((resolve, reject) => {
            if (!(rle instanceof Int32Array)) {
                reject(new Error('Mask must be an Int32Array'));
                return;
            }
            const request: PendingRequest = {
                id: ++this.nextID,
                source: rle,
                rle: rle.slice(),
                radius,
                bounds: [...bounds],
                resolve,
                reject,
            };
            if (this.active?.source === rle) this.active.resolve(null);
            this.pending.get(rle)?.resolve(null);
            this.pending.set(rle, request);
            this.dispatch();
        });
    }

    public dispose(): void {
        this.disposed = true;
        this.stopWorker();
        this.active?.resolve(null);
        this.active = null;
        for (const request of this.pending.values()) request.resolve(null);
        this.pending.clear();
    }
}

// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import type {
    DetectorShape,
    FrameSize,
    ProcessingOptions,
} from './detector-postprocessing';
import { LatestRequestGate } from './latest-request-gate.ts';

export interface DetectorProcessingRequest {
    id: number;
    shapes: DetectorShape[];
    frame: FrameSize;
    options: ProcessingOptions;
}

export type DetectorProcessingResponse =
    | { id: number; shapes: DetectorShape[] }
    | { id: number; error: string };

export interface DetectorWorkerPort {
    postMessage: (request: DetectorProcessingRequest) => void;
    terminate: () => void;
    onmessage: ((event: MessageEvent<DetectorProcessingResponse>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    onmessageerror: ((event: MessageEvent) => void) | null;
}

type DetectorProcessingInput = Omit<DetectorProcessingRequest, 'id'>;

interface PendingRequest {
    id: number;
    resolve: (shapes: DetectorShape[] | null) => void;
    reject: (error: Error) => void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export class DetectorPostprocessingClient {
    private readonly workerFactory: () => DetectorWorkerPort;
    private readonly gate = new LatestRequestGate();
    private worker: DetectorWorkerPort | null = null;
    private pending: PendingRequest | null = null;
    private retainedInput: DetectorProcessingInput | null = null;
    private failed = false;
    private disposed = false;

    public constructor(workerFactory: () => DetectorWorkerPort = () => (
        new Worker(new URL('./detector-postprocessing.worker.ts', import.meta.url))
    )) {
        this.workerFactory = workerFactory;
    }

    private startWorker(): void {
        const worker = this.workerFactory();
        this.worker = worker;
        worker.onmessage = (event): void => {
            if (this.worker !== worker || this.disposed) return;
            if (!this.pending) return;
            const response: unknown = event.data;
            if (!isRecord(response) || !Number.isSafeInteger(response.id)) {
                this.failCurrent(new Error('Invalid detector postprocessing worker response'));
                return;
            }
            const id = response.id as number;
            if (!this.gate.isCurrent(id) || id !== this.pending.id) return;

            const isErrorResponse = typeof response.error === 'string' && !('shapes' in response);
            const isSuccessResponse = Array.isArray(response.shapes) && !('error' in response);
            if (!isErrorResponse && !isSuccessResponse) {
                this.failCurrent(new Error('Invalid detector postprocessing worker response'));
                return;
            }
            if (isErrorResponse) {
                this.failCurrent(new Error(`Detector postprocessing failed: ${response.error}`));
                return;
            }

            const { resolve } = this.pending;
            this.pending = null;
            this.failed = false;
            resolve(response.shapes as DetectorShape[]);
        };
        worker.onerror = (event): void => {
            if (this.worker !== worker || this.disposed) return;
            this.failCurrent(new Error(
                `Detector postprocessing worker failed: ${event.message || 'unknown worker error'}`,
            ));
        };
        worker.onmessageerror = (): void => {
            if (this.worker !== worker || this.disposed) return;
            this.failCurrent(new Error('Unable to read detector postprocessing worker response'));
        };
    }

    private stopWorker(): void {
        if (!this.worker) return;
        this.worker.onmessage = null;
        this.worker.onerror = null;
        this.worker.onmessageerror = null;
        this.worker.terminate();
        this.worker = null;
    }

    private failCurrent(error: Error): void {
        this.stopWorker();
        const { pending } = this;
        this.pending = null;
        this.failed = pending !== null && this.retainedInput !== null;
        pending?.reject(error);
    }

    private submit(input: DetectorProcessingInput): Promise<DetectorShape[] | null> {
        this.pending?.resolve(null);
        this.pending = null;
        this.retainedInput = input;
        this.failed = false;

        return new Promise((resolve, reject) => {
            const id = this.gate.issue();
            this.pending = { id, resolve, reject };
            try {
                if (!this.worker) this.startWorker();
            } catch (error: unknown) {
                this.failCurrent(new Error(
                    `Unable to start detector postprocessing worker: ${errorMessage(error)}`,
                ));
                return;
            }
            try {
                this.worker!.postMessage({ id, ...input });
            } catch (error: unknown) {
                this.failCurrent(new Error(
                    `Unable to send detector postprocessing request: ${errorMessage(error)}`,
                ));
            }
        });
    }

    public process(
        shapes: DetectorShape[],
        frame: FrameSize,
        options: ProcessingOptions,
    ): Promise<DetectorShape[] | null> {
        if (this.disposed) return Promise.resolve(null);
        return this.submit({ shapes, frame, options });
    }

    public retry(): Promise<DetectorShape[] | null> {
        if (this.disposed) return Promise.resolve(null);
        if (!this.failed || !this.retainedInput) {
            return Promise.reject(new Error('No failed detector postprocessing request to retry'));
        }
        this.stopWorker();
        const { retainedInput } = this;
        return this.submit(retainedInput);
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.gate.dispose();
        this.stopWorker();
        this.pending?.resolve(null);
        this.pending = null;
        this.retainedInput = null;
        this.failed = false;
    }
}

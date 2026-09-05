// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

export class LatestRequestGate {
    private current = 0;
    private disposed = false;

    public issue(): number {
        if (this.disposed) throw new Error('Request gate is disposed');
        this.current += 1;
        return this.current;
    }

    public isCurrent(id: number): boolean {
        return !this.disposed && id === this.current;
    }

    public dispose(): void {
        this.disposed = true;
        this.current += 1;
    }
}

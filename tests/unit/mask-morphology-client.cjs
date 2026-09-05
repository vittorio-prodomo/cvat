// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function fixture(startupFailures = 0) {
    const workers = [];
    class FakeWorker {
        constructor() {
            if (startupFailures > 0) {
                startupFailures--;
                throw new Error('worker startup failed');
            }
            this.messages = []; this.terminated = false; workers.push(this);
        }
        postMessage(message, transfer) {
            this.messages.push(structuredClone(message, { transfer }));
        }
        terminate() { this.terminated = true; }
        finish(index = this.messages.length - 1, rle = new Int32Array([0, 1, 0, 0, 0, 0])) {
            this.onmessage({ data: { id: this.messages[index].id, rle } });
        }
    }
    const filename = path.resolve(__dirname, '../../cvat-ui/src/utils/mask-morphology-client.ts');
    const source = fs.readFileSync(filename, 'utf8').replace(/import\.meta\.url/g, JSON.stringify(`file://${filename}`));
    const output = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const mod = { exports: {} };
    vm.runInNewContext(output, { exports: mod.exports, module: mod, Worker: FakeWorker, URL, Int32Array });
    const client = new mod.exports.default();
    return { client, worker: workers[0], workers };
}

const mask = () => new Int32Array([0, 1, 0, 0, 0, 0]);
const bounds = [0, 0, 100, 100];

test('transfers a copy and leaves the caller source and bounds immutable', async () => {
    const { client, worker } = fixture(); const source = mask(); const region = [...bounds];
    const promise = client.apply(source, 2, region);
    assert.deepEqual(source, mask());
    assert.notEqual(worker.messages[0].rle.buffer, source.buffer);
    source[1] = 0; region[2] = 50;
    assert.equal(worker.messages[0].rle[1], 1);
    assert.equal(worker.messages[0].bounds[2], 100);
    worker.finish();
    assert.deepEqual(await promise, mask());
    client.dispose();
});

test('coalesces changes to one source while retaining other masks pending adjustments', async () => {
    const { client, worker } = fixture(); const sourceA = mask(); const sourceB = mask();
    const a1 = client.apply(sourceA, 1, bounds);
    const b1 = client.apply(sourceB, -1, bounds);
    const a2 = client.apply(sourceA, 2, bounds);
    const a3 = client.apply(sourceA, 3, bounds);
    assert.equal(await a1, null);
    assert.equal(await a2, null);
    assert.equal(worker.messages.length, 1);
    worker.finish();
    assert.equal(worker.messages[1].radius, -1);
    worker.finish();
    assert.deepEqual(await b1, mask());
    assert.equal(worker.messages[2].radius, 3);
    worker.finish();
    assert.deepEqual(await a3, mask());
    client.dispose();
});

test('switching masks never supersedes another masks active request', async () => {
    const { client, worker } = fixture();
    const first = client.apply(mask(), 1, bounds); const second = client.apply(mask(), 2, bounds);
    worker.finish();
    assert.deepEqual(await first, mask());
    worker.finish();
    assert.deepEqual(await second, mask());
    client.dispose();
});

test('dispose resolves active and queued promises and later calls as null', async () => {
    const { client, worker } = fixture();
    const first = client.apply(mask(), 1, bounds); const second = client.apply(mask(), 2, bounds);
    client.dispose(); client.dispose();
    assert.equal(await first, null); assert.equal(await second, null);
    assert.equal(await client.apply(mask(), 3, bounds), null);
    assert.equal(worker.terminated, true);
});

test('worker-reported validation errors reject only that request and continue the queue', async () => {
    const { client, worker } = fixture();
    const first = client.apply(mask(), 99, bounds); const second = client.apply(mask(), 2, bounds);
    const rejected = assert.rejects(first, /invalid radius/);
    worker.onmessage({ data: { id: worker.messages[0].id, error: 'invalid radius' } });
    await rejected;
    worker.finish(); assert.deepEqual(await second, mask());
    client.dispose();
});

for (const eventName of ['onerror', 'onmessageerror']) {
    test(`${eventName} rejects active and queued requests without hanging`, async () => {
        const { client, worker, workers } = fixture();
        const first = client.apply(mask(), 1, bounds); const second = client.apply(mask(), 2, bounds);
        const rejected = Promise.all([assert.rejects(first), assert.rejects(second)]);
        worker[eventName]({ message: 'worker failed', preventDefault() {} });
        await rejected;
        assert.equal(worker.terminated, true);
        const retry = client.apply(mask(), 1, bounds);
        assert.equal(workers.length, 2);
        workers[1].finish();
        assert.deepEqual(await retry, mask());
        client.dispose();
    });
}

test('synchronous postMessage errors also settle every request', async () => {
    const { client, worker, workers } = fixture();
    worker.postMessage = () => { throw new Error('transfer failed'); };
    await assert.rejects(client.apply(mask(), 1, bounds), /transfer failed/);
    assert.equal(worker.terminated, true);
    const retry = client.apply(mask(), 1, bounds);
    workers[1].finish();
    assert.deepEqual(await retry, mask());
    client.dispose();
});

test('startup failures reject through apply and a later attempt recreates the worker', async () => {
    const { client, workers } = fixture(2);
    assert.equal(workers.length, 0);
    await assert.rejects(client.apply(mask(), 1, bounds), /worker startup failed/);
    const retry = client.apply(mask(), 1, bounds);
    assert.equal(workers.length, 1);
    workers[0].finish();
    assert.deepEqual(await retry, mask());
    client.dispose();
});

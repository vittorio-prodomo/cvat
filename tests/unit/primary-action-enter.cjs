// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
// Run with: node tests/unit/primary-action-enter.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
// Keyboard DOM tests do not need jsdom's optional native canvas renderer.
const canvasPath = require.resolve('canvas');
const previousCanvas = require.cache[canvasPath];
require.cache[canvasPath] = { id: canvasPath, filename: canvasPath, loaded: true, exports: {} };
const { JSDOM } = require('jsdom');
if (previousCanvas) require.cache[canvasPath] = previousCanvas;
else delete require.cache[canvasPath];

const filename = path.resolve(__dirname, '../../cvat-ui/src/utils/primary-action-enter.ts');
function fixture() {
    const dom = new JSDOM('<div id="scope"><input><button data-primary-action="true">Run</button><button id="secondary">Clear</button></div>');
    const { document } = dom.window;
    const scheduled = [];
    dom.window.setTimeout = (callback) => scheduled.push(callback);
    dom.window.HTMLElement.prototype.getClientRects = function () {
        for (let node = this; node; node = node.parentElement) {
            if (node.style.display === 'none') return [];
        }
        return [{}];
    };
    const mod = { exports: {} };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, { module: mod, exports: mod.exports, window: dom.window, HTMLElement: dom.window.HTMLElement });
    const scope = document.querySelector('#scope');
    const input = scope.querySelector('input');
    const button = scope.querySelector('[data-primary-action]');
    let clicks = 0;
    button.onclick = () => clicks++;
    const event = (overrides = {}) => ({
        key: 'Enter', target: input, currentTarget: scope, nativeEvent: {},
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; },
        ...overrides,
    });
    return { scope, input, button, document, event, run: mod.exports.default,
        flush: () => { while (scheduled.length) scheduled.shift()(); }, clicks: () => clicks };
}

test('Enter commits a field on blur before the primary click and consumes the event once', () => {
    const f = fixture();
    const order = [];
    f.input.focus();
    f.input.onblur = () => order.push('commit');
    f.button.addEventListener('click', () => order.push('run'));
    const event = f.event();
    f.run(event);
    f.run(event); // The same event reaching an outer form must not submit twice.
    assert.equal(f.clicks(), 0);
    f.flush();
    assert.deepEqual(order, ['commit', 'run']);
    assert.equal(f.clicks(), 1);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true);
});

for (const properties of [{ key: 'Escape' }, { ctrlKey: true }, { altKey: true }, { shiftKey: true },
    { metaKey: true }, { repeat: true }, { nativeEvent: { isComposing: true } },
    { nativeEvent: { keyCode: 229 } }, { defaultPrevented: true }]) {
    test(`keeps keyboard behavior for ${JSON.stringify(properties)}`, () => {
        const f = fixture();
        f.run(f.event(properties));
        f.flush();
        assert.equal(f.clicks(), 0);
    });
}

test('select input, secondary buttons, switches, radios, and outside fields keep their behavior', () => {
    const f = fixture();
    for (const markup of ['<div class="ant-select"><input role="combobox" aria-expanded="true"></div>',
        '<button>Clear</button>', '<input type="checkbox">', '<input type="radio">', '<button role="switch">Toggle</button>']) {
        const host = f.document.createElement('div');
        host.innerHTML = markup;
        f.scope.append(host);
        f.run(f.event({ target: host.querySelector('input,button') }));
    }
    const outside = f.document.createElement('input');
    f.document.body.append(outside);
    f.run(f.event({ target: outside }));
    f.flush();
    assert.equal(f.clicks(), 0);
});

for (const state of ['disabled', 'loading', 'hidden-panel', 'closed-popover', 'closing-popover']) {
    test(`does not submit ${state}`, () => {
        const f = fixture();
        if (state === 'disabled') f.button.disabled = true;
        if (state === 'loading') f.button.classList.add('ant-btn-loading');
        if (state === 'hidden-panel') f.scope.classList.add('ant-tabs-tabpane-hidden');
        if (state === 'closed-popover') f.scope.style.display = 'none';
        if (state === 'closing-popover') {
            f.input.style.pointerEvents = 'none';
            f.button.style.pointerEvents = 'none';
        }
        f.run(f.event());
        f.flush();
        assert.equal(f.clicks(), 0);
    });
}

test('rechecks visibility and busy state after the field commit, and coalesces queued Enter', () => {
    const f = fixture();
    f.run(f.event());
    f.run(f.event());
    f.button.disabled = true;
    f.flush();
    assert.equal(f.clicks(), 0);
    f.button.disabled = false;
    f.run(f.event());
    f.run(f.event());
    f.flush();
    assert.equal(f.clicks(), 1);
});

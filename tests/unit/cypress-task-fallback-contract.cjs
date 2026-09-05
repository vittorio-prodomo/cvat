const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const specPath = path.join(
    __dirname,
    '../cypress/e2e/features2/crop_instance_segmentation_interactor.js',
);

function chain(value) {
    return {
        then(callback) {
            return chain(callback(value));
        },
        should(assertion, expected) {
            if (assertion === 'eq') {
                assert.equal(value, expected);
            }
            return this;
        },
    };
}

test('fallback uses the shared task response contract without task API writes', () => {
    const hooks = { before: [], after: [], tests: [] };
    const visits = [];
    const intercepts = [];
    const gets = [];
    const overwrittenCommands = new Map();
    const cy = {
        get(selector) {
            gets.push(selector);
            return chain(null);
        },
        headlessCreateTask() {
            return overwrittenCommands.get('headlessCreateTask')(() => {
                throw new Error('The real task creator must not run');
            });
        },
        headlessDeleteTask(taskId) {
            return overwrittenCommands.get('headlessDeleteTask')(() => {
                throw new Error('The real task deleter must not run');
            }, taskId);
        },
        headlessLogin() {
            return chain(null);
        },
        headlessLogout() {
            return chain(null);
        },
        intercept(method, url) {
            intercepts.push({ method, url });
            return { as() { return chain(null); } };
        },
        location(part) {
            assert.equal(part, 'pathname');
            return chain(visits.at(-1));
        },
        visit(url) {
            visits.push(url);
            return chain(null);
        },
        wrap(value) {
            return chain(value);
        },
    };
    const skip = () => undefined;
    const describe = () => undefined;
    describe.skip = skip;
    const sandbox = {
        Cypress: {
            Commands: {
                overwrite(name, callback) {
                    overwrittenCommands.set(name, callback);
                },
            },
            env(name) {
                return name === 'fallbackContractOnly' ? true : undefined;
            },
        },
        after(callback) {
            hooks.after.push(callback);
        },
        before(callback) {
            hooks.before.push(callback);
        },
        context(_name, callback) {
            callback();
        },
        cy,
        describe,
        expect(actual, label) {
            return {
                to: {
                    equal(expected) {
                        assert.equal(actual, expected, label);
                    },
                },
            };
        },
        it(_name, callback) {
            hooks.tests.push(callback);
        },
    };

    vm.runInNewContext(fs.readFileSync(specPath, 'utf8'), sandbox, { filename: specPath });
    hooks.before.forEach((callback) => callback());

    assert.equal(visits.at(-1), '/tasks/166/jobs/182');
    assert.ok(gets.includes('.cvat-canvas-container'));
    assert.deepEqual(intercepts.map(({ method }) => method), ['POST', 'DELETE']);

    hooks.tests.forEach((callback) => callback());
    hooks.after.forEach((callback) => callback());
});

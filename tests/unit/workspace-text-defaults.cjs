// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
// Run with node tests/unit/workspace-text-defaults.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../cvat-ui/src');
const expected = 'label,descriptions,dimensions';

function fixture(saved) {
    const data = new Map(saved ? [['clientSettings', JSON.stringify(saved)]] : []);
    const localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
    const cache = {};
    const dependencies = {
        lodash: require('lodash'),
        'actions/auth-actions': { AuthActionTypes: { LOGOUT_SUCCESS: 'LOGOUT_SUCCESS' } },
        'actions/annotation-actions': { AnnotationActionTypes: {} },
        'cvat-canvas3d-wrapper': { OrientationVisibility: {} },
        'utils/image-processing': { ImageFilterAlias: { GAMMA_CORRECTION: 'gamma' } },
        'utils/fabric-wrapper/gamma-correction': class {
            constructor(params) { this.params = params; }
            toJSON() { return { alias: 'gamma', params: this.params }; }
        },
        'utils/conflict-detector': { resolveConflicts: keyMap => keyMap },
        'actions/shortcuts-actions': { shortcutsActions: {
            setDefaultShortcuts: shortcuts => ({ type: 'SET_DEFAULT_SHORTCUTS', payload: { shortcuts } }),
            registerShortcuts: shortcuts => ({ type: 'REGISTER_SHORTCUTS', payload: { shortcuts } }),
        } },
    };
    const typesSource = fs.readFileSync(path.join(root, 'reducers/index.ts'), 'utf8');
    const typesAST = ts.createSourceFile('index.ts', typesSource, ts.ScriptTarget.Latest, true);
    const enums = typesAST.statements.filter(n => ts.isEnumDeclaration(n) && ['GridColor', 'FrameSpeed', 'ColorBy'].includes(n.name.text)).map(n => n.getText(typesAST)).join('\n');
    function evaluate(source, filename) {
        const mod = { exports: {} };
        const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
        vm.compileFunction(code, ['require', 'module', 'exports', 'localStorage'], { filename })(
            name => {
                if (name === './shortcuts-actions') return dependencies['actions/shortcuts-actions'];
                if (dependencies[name]) return dependencies[name];
                if (name.startsWith('actions/') || name.startsWith('utils/')) return load(name + '.ts');
                throw Error('Unexpected import: ' + name);
            }, mod, mod.exports, localStorage,
        );
        return mod.exports;
    }
    function load(file) {
        if (!cache[file]) cache[file] = evaluate(fs.readFileSync(path.join(root, file), 'utf8'), file);
        return cache[file];
    }
    dependencies.reducers = evaluate(enums, 'enums.ts');
    const actions = load('actions/settings-actions.ts');
    const reducer = load('reducers/settings-reducer.ts').default;
    let state = { settings: reducer(undefined, { type: '@@INIT' }), shortcuts: { keyMap: {}, defaultState: {} } };
    const dispatch = action => {
        if (typeof action === 'function') return action(dispatch, () => state);
        state = { ...state, settings: reducer(state.settings, action) };
        if (action.type === 'SET_DEFAULT_SHORTCUTS') state.shortcuts.defaultState = action.payload.shortcuts;
    };
    return {
        restore: () => dispatch(actions.restoreSettingsAsync()),
        save: () => actions.updateCachedSettings(state.settings, state.shortcuts),
        select: values => dispatch(actions.switchTextContent(values)),
        logout: () => dispatch({ type: 'LOGOUT_SUCCESS' }),
        state: () => state.settings,
        saved: () => JSON.parse(localStorage.getItem('clientSettings')),
    };
}

test('new browsers start with only Label, Descriptions and Dimensions', async () => {
    const f = fixture();
    await f.restore();
    assert.equal(f.state().workspace.textContent, expected);
    f.save();
    assert.equal(f.saved().workspace.textContent, expected);
});

test('existing browsers migrate once and preserve unrelated settings and cached data', async () => {
    const original = {
        workspace: { textContent: 'id,source,attributes', autoSave: true, textFontSize: 19 },
        player: { frameStep: 37, brightnessLevel: 116 },
        shortcuts: { keyMap: {} }, imageFilters: [{ alias: 'gamma', params: { gamma: [1, 2, 3] } }],
        unrelatedMetadata: { keep: true },
    };
    const f = fixture(original);
    await f.restore();
    assert.equal(f.state().workspace.textContent, expected);
    assert.equal(f.state().workspace.autoSave, true);
    assert.equal(f.state().workspace.textFontSize, 19);
    assert.equal(f.state().player.frameStep, 37);
    assert.equal(f.state().player.brightnessLevel, 116);
    const migrated = f.saved();
    assert.equal(migrated.workspace.textContent, expected);
    assert.deepEqual(migrated.unrelatedMetadata, original.unrelatedMetadata);
    assert.deepEqual(migrated.imageFilters, original.imageFilters);
    assert.deepEqual(migrated.shortcuts, original.shortcuts);
});

for (const selection of [['id', 'layer'], []]) {
    test(`subsequent custom choices survive reload and logout: ${JSON.stringify(selection)}`, async () => {
        const f = fixture({ workspace: { textContent: 'source' } });
        await f.restore();
        assert.equal(f.state().workspace.textContent, expected);
        f.select(selection);
        f.save();
        f.logout();
        await f.restore();
        assert.equal(f.state().workspace.textContent, selection.join(','));
        const next = fixture(f.saved());
        await next.restore();
        assert.equal(next.state().workspace.textContent, selection.join(','));
    });
}

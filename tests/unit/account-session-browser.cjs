// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
// Browser regression fixture: real logout, auth/shortcut reducers, thunks and hotkeys.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: true });
for (const [source, target] of [
    ['react/umd/react.development.js', 'react.js'],
    ['react-dom/umd/react-dom.development.js', 'react-dom.js'],
    ['redux/dist/redux.js', 'redux.js'], ['react-redux/dist/react-redux.js', 'react-redux.js'],
    ['react-router-dom/umd/react-router-dom.js', 'router.js'],
    ['mousetrap/mousetrap.js', 'mousetrap.js'], ['lodash/lodash.js', 'lodash.js'],
]) fs.copyFileSync(path.join(root, 'node_modules', source), path.join(output, target));
const read = file => fs.readFileSync(path.join(root, 'cvat-ui/src', file), 'utf8');
const parse = file => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(node, predicate) {
    if (predicate(node)) return node;
    return ts.forEachChild(node, child => find(child, predicate));
}
function declaration(file, name) {
    const ast = parse(file);
    const node = find(ast, n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    if (!node) throw Error('Missing function ' + name);
    return node.getText(ast);
}
const sources = {};
for (const [name, file] of Object.entries({
    logout: 'components/logout-component.tsx', auth: 'actions/auth-actions.ts',
    authReducer: 'reducers/auth-reducer.ts', shortcuts: 'actions/shortcuts-actions.ts',
    shortcutReducer: 'reducers/shortcuts-reducer.ts', conflict: 'utils/conflict-detector.ts',
    enums: 'utils/enums.tsx', redux: 'utils/redux.ts', subkeymap: 'utils/component-subkeymap.ts',
    hotkeys: 'utils/mousetrap-react.tsx',
    textDefaults: 'utils/workspace-text-content-default.ts',
})) sources[name] = read(file);
sources.coreEnums = fs.readFileSync(path.join(root, 'cvat-core/src/enums.ts'), 'utf8');
sources.logs = `import logger from 'cvat-logger';
const AnnotationActionTypes = { SAVE_LOGS_SUCCESS: 'SAVE_LOGS_SUCCESS', SAVE_LOGS_FAILED: 'SAVE_LOGS_FAILED' };
${declaration('actions/annotation-actions.ts', 'saveLogsAsync')}`;
sources.settings = `import _ from 'lodash';
import { DEFAULT_WORKSPACE_TEXT_CONTENT, WORKSPACE_TEXT_CONTENT_DEFAULTS_VERSION } from 'utils/workspace-text-content-default';
import { shortcutsActions } from 'actions/shortcuts-actions';
import { resolveConflicts } from 'utils/conflict-detector';
const setSettings = settings => ({ type: 'SET_SETTINGS', payload: { settings } });
${declaration('actions/settings-actions.ts', 'restoreSettingsAsync')}`;
const controlsFile = 'components/annotation-page/standard-workspace/controls-side-bar/controls-side-bar.tsx';
const controlsAST = parse(controlsFile);
sources.controls = `import { ShortcutScope } from 'utils/enums';
import { registerComponentShortcuts } from 'actions/shortcuts-actions';
${controlsAST.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(controlsAST) === 'componentShortcuts')).map(n => n.getText(controlsAST)).join('\n')}
registerComponentShortcuts(componentShortcuts);
export { componentShortcuts };`;
const labelsFile = 'components/annotation-page/standard-workspace/objects-side-bar/labels-list.tsx';
const labelsAST = parse(labelsFile);
const labelsEffect = find(labelsAST, node => ts.isCallExpression(node) && node.expression.getText(labelsAST) === 'useEffect');
sources.labels = `import { ShortcutScope } from 'utils/enums';
import { registerComponentShortcuts } from 'actions/shortcuts-actions';
${labelsAST.statements.filter(node => ts.isForOfStatement(node) || (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ['componentShortcuts', 'makeKey'].includes(d.name.getText(labelsAST))))).map(n => n.getText(labelsAST)).join('\n')}
registerComponentShortcuts(componentShortcuts);
export function mountLabels(keyMap, labels, keyToLabelMapping) { (${labelsEffect.arguments[0].getText(labelsAST)})(); }`;
const pageAST = parse('components/annotation-page/annotation-page.tsx');
const pageEffect = find(pageAST, node => ts.isCallExpression(node) && node.expression.getText(pageAST) === 'useEffect');
sources.jobLifecycle = `export function jobLifecycle(saveLogs, closeJob, EventRecorder) {
return (${pageEffect.arguments[0].getText(pageAST)})(); }`;
let bundle = 'window.modules = {};\n';
for (const [name, source] of Object.entries(sources)) {
    const result = ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React, esModuleInterop: true,
    } });
    bundle += `window.modules[${JSON.stringify(name)}] = function(require, module, exports) {\n${result.outputText}\n};\n`;
}
fs.writeFileSync(path.join(output, 'source.js'), bundle);
fs.writeFileSync(path.join(output, 'harness.js'), `
window.events = []; window.draws = 0; window.jobMounts = 0;
let authenticated = true;
window.failLogout = false;
window.failLogs = false;
const core = {
    organizations: { deactivate: async () => { window.events.push('deactivate'); } },
    server: { logout: async () => {
        window.events.push('logout');
        if (window.failLogout) throw Error('Logout unavailable');
        authenticated = false;
    } },
    logger: { save: async () => {
        window.events.push(authenticated ? 'logs:authenticated' : 'logs:anonymous');
        if (window.delayLogs) await new Promise((resolve, reject) => {
            window.finishLogs = () => reject(Error('Authentication credentials were not provided.'));
        });
        if (!authenticated || window.failLogs) throw Error('Authentication credentials were not provided.');
    } },
};
const cache = {};
function load(name) {
    if (cache[name]) return cache[name].exports;
    const module = { exports: {} }; cache[name] = module;
    window.modules[name](lookup, module, module.exports);
    return module.exports;
}
function lookup(name) {
    const aliases = { 'utils/redux': 'redux', 'actions/auth-actions': 'auth',
        'actions/annotation-actions': 'logs', 'actions/shortcuts-actions': 'shortcuts',
        './shortcuts-actions': 'shortcuts', 'utils/conflict-detector': 'conflict',
        'utils/enums': 'enums', './enums': 'enums', 'cvat-core/src/enums': 'coreEnums',
        'utils/workspace-text-content-default': 'textDefaults' };
    if (aliases[name]) return load(aliases[name]);
    if (name === 'react') return React;
    if (name === 'react-redux') return ReactRedux;
    if (name === 'react-router') return ReactRouterDOM;
    if (name === 'lodash') return _;
    if (name === 'mousetrap') return Mousetrap;
    if (name === 'antd/lib/spin') return () => React.createElement('span', null, 'Logging out');
    if (name === 'cvat-store') return { getCVATStore: () => store };
    if (name === 'cvat-core-wrapper') return { getCore: () => core };
    if (name === 'cvat-logger') return core.logger;
    if (name === 'utils/error-handling') return { ensureError: error => error };
    if (name === 'utils/pagination') return {};
    if (name === 'actions/boundaries-actions') return { BoundariesActionTypes: { RESET_AFTER_ERROR: 'RESET_AFTER_ERROR' } };
    throw Error('Unexpected import: ' + name);
}
const auth = load('auth');
const authReducer = load('authReducer').default;
const shortcutReducer = load('shortcutReducer').default;
const thunk = store => next => action => {
    if (typeof action === 'function') return action(store.dispatch, store.getState);
    window.events.push(action.type);
    return next(action);
};
const store = Redux.createStore(Redux.combineReducers({ auth: authReducer, shortcuts: shortcutReducer,
    settings: (state = { player: {}, workspace: {}, imageFilters: [] }) => state,
}), Redux.applyMiddleware(thunk));
window.store = store;
store.dispatch(auth.authActions.authenticatedSuccess({ id: 1, username: 'admin' }));
const { componentShortcuts } = load('controls');
const { mountLabels } = load('labels');
const { restoreSettingsAsync } = load('settings');
const { shortcutsActions } = load('shortcuts');
window.shortcutsActions = shortcutsActions;
window.restoreSettings = () => store.dispatch(restoreSettingsAsync());
window.restoreSettings();
const { subKeyMap } = load('subkeymap');
const HotKeys = load('hotkeys').default;
const Logout = load('logout').default;
window.saveLogs = () => store.dispatch(load('logs').saveLogsAsync());
window.logBackIn = (id = 2) => { authenticated = true; store.dispatch(auth.authActions.loginSuccess({ id, username: 'worker' })); };
window.finishSession = () => { authenticated = false; store.dispatch(auth.authActions.logoutSuccess()); };
function Job() {
    const { keyMap } = ReactRedux.useSelector(state => state.shortcuts);
    React.useEffect(() => {
        window.jobMounts += 1;
        mountLabels(store.getState().shortcuts.keyMap, [{ id: 17, name: 'Worker label' }], { 1: 17 });
        return load('jobLifecycle').jobLifecycle(window.saveLogs, () => {}, {});
    }, []);
    return React.createElement(React.Fragment, null,
        React.createElement('h1', null, 'Job'),
        React.createElement(HotKeys, { keyMap: subKeyMap(componentShortcuts, keyMap),
            handlers: { SWITCH_DRAW_MODE_STANDARD_CONTROLS: () => { window.draws++; } } }));
}
function Routes() {
    const user = ReactRedux.useSelector(state => state.auth.user);
    const location = ReactRouterDOM.useLocation();
    const history = ReactRouterDOM.useHistory();
    window.appHistory = history; window.currentLocation = location;
    // These route branches reproduce CVATApp's authenticated/anonymous switches.
    return user ? React.createElement(ReactRouterDOM.Switch, null,
        React.createElement(ReactRouterDOM.Route, { exact: true, path: '/auth/logout', component: Logout }),
        React.createElement(ReactRouterDOM.Route, { path: '/tasks/305/jobs/364', component: Job }),
        React.createElement(ReactRouterDOM.Route, { path: '/tasks', render: () => React.createElement('h1', null, 'Tasks') }),
        React.createElement(ReactRouterDOM.Redirect, { to: '/tasks' })) :
        React.createElement(ReactRouterDOM.Switch, null,
            React.createElement(ReactRouterDOM.Route, { path: '/auth/login', render: () => React.createElement('h1', null, 'Sign in') }),
            React.createElement(ReactRouterDOM.Redirect, { to: location.pathname.length > 1 ? '/auth/login?next=' + location.pathname : '/auth/login' }));
}
const directLogout = window.location.search.includes('direct-logout');
if (directLogout) window.failLogout = true;
ReactDOM.createRoot(document.getElementById('root')).render(
    React.createElement(ReactRedux.Provider, { store },
        React.createElement(ReactRouterDOM.MemoryRouter, { initialEntries: directLogout ? ['/auth/logout'] : ['/tasks', '/tasks/305/jobs/364'], initialIndex: directLogout ? 0 : 1 }, React.createElement(Routes))));
`);
fs.writeFileSync(path.join(output, 'index.html'), `<!doctype html><html><head><link rel="icon" href="data:,"></head>
<body><div id="root"></div><script src="react.js"></script><script src="react-dom.js"></script>
<script src="redux.js"></script><script src="react-redux.js"></script><script src="router.js"></script>
<script src="mousetrap.js"></script><script src="lodash.js"></script><script src="source.js"></script><script src="harness.js"></script></body></html>`);
console.log(output);

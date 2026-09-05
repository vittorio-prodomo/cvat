// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
// Build a fixture using the real reset page/form/thunk, React Redux and React Router.
// node tests/unit/password-reset-browser.cjs /tmp/cvat-password-reset-browser
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: true });
for (const [source, target] of [
    ['react/umd/react.development.js', 'react.js'],
    ['react-dom/umd/react-dom.development.js', 'react-dom.js'],
    ['dayjs/dayjs.min.js', 'dayjs.js'], ['antd/dist/antd.js', 'antd.js'],
    ['antd/dist/reset.css', 'reset.css'], ['redux/dist/redux.js', 'redux.js'],
    ['react-redux/dist/react-redux.js', 'react-redux.js'],
    ['react-router-dom/umd/react-router-dom.js', 'router.js'],
]) fs.copyFileSync(path.join(root, 'node_modules', source), path.join(output, target));
const sources = {};
for (const [name, file] of Object.entries({
    page: 'components/reset-password-confirm-page/reset-password-confirm-page.tsx',
    form: 'components/reset-password-confirm-page/reset-password-confirm-form.tsx',
    actions: 'actions/auth-actions.ts', reducer: 'reducers/auth-reducer.ts',
    redux: 'utils/redux.ts', patterns: 'utils/validation-patterns.ts',
})) sources[name] = fs.readFileSync(path.join(root, 'cvat-ui/src', file), 'utf8');
const register = ts.createSourceFile('register.tsx', fs.readFileSync(path.join(root, 'cvat-ui/src/components/register-page/register-form.tsx'), 'utf8'), ts.ScriptTarget.Latest, true);
sources.validators = `import patterns from 'utils/validation-patterns';\n` + register.statements.filter((node) =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some((decl) =>
        ['validatePassword', 'validateConfirmation'].includes(decl.name.getText(register)))).map((node) => node.getText(register)).join('\n');
const notifications = fs.readFileSync(path.join(root, 'cvat-ui/src/reducers/notifications-reducer.ts'), 'utf8');
const successMessage = notifications.match(/resetPasswordDone:\s*\{\s*message: '([^']+)'/)[1];
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
window.requests = [];
window.actions = [];
const core = { server: { resetPassword: (...args) => new Promise((resolve, reject) => {
    window.requests.push({ uid: args[2], token: args[3] });
    window.settleReset = (success) => success ? resolve() : reject(new Error('Expired reset link'));
}) } };
const cache = {};
function load(name) {
    if (cache[name]) return cache[name].exports;
    const module = { exports: {} }; cache[name] = module;
    window.modules[name](lookup, module, module.exports);
    return module.exports;
}
function lookup(name) {
    if (name === 'react') return React;
    if (name === 'react-redux') return ReactRedux;
    if (name === 'react-router' || name === 'react-router-dom') return ReactRouterDOM;
    if (name === 'antd/lib/typography/Title') return antd.Typography.Title;
    if (name === 'antd/lib/grid') return { Row: antd.Row, Col: antd.Col };
    if (name.startsWith('antd/lib/')) return antd[name.slice(9,10).toUpperCase() + name.slice(10)];
    if (name === '@ant-design/icons') return { LockOutlined: () => null };
    if (name === 'cvat-core-wrapper') return { getCore: () => core };
    if (name === 'utils/error-handling') return { ensureError: error => error };
    if (name === 'utils/pagination') return {};
    if (name === 'actions/boundaries-actions') return { BoundariesActionTypes: { RESET_AFTER_ERROR: 'RESET_AFTER_ERROR' } };
    const aliases = { 'utils/redux': 'redux', 'utils/validation-patterns': 'patterns',
        'actions/auth-actions': 'actions', 'components/register-page/register-form': 'validators',
        './reset-password-confirm-form': 'form' };
    if (aliases[name]) return load(aliases[name]);
    throw Error('Unexpected import: ' + name);
}
const auth = load('actions');
const reducer = load('reducer').default;
const thunk = store => next => action => {
    if (typeof action === 'function') return action(store.dispatch, store.getState);
    window.actions.push(action.type);
    const result = next(action);
    if (action.type === auth.AuthActionTypes.RESET_PASSWORD_SUCCESS) antd.notification.info({ message: ${JSON.stringify(successMessage)}, duration: 0 });
    if (action.type === auth.AuthActionTypes.RESET_PASSWORD_FAILED) antd.notification.error({ message: 'Could not set new password on the server.', duration: 0 });
    return result;
};
const store = Redux.createStore(Redux.combineReducers({ auth: reducer }), Redux.applyMiddleware(thunk));
const ResetPage = load('page').default;
function Routes() {
    const history = ReactRouterDOM.useHistory();
    const location = ReactRouterDOM.useLocation();
    window.appHistory = history;
    window.currentLocation = location;
    return React.createElement(ReactRouterDOM.Switch, null,
        React.createElement(ReactRouterDOM.Route, { path: '/auth/password/reset/confirm', component: ResetPage }),
        React.createElement(ReactRouterDOM.Route, { path: '/auth/login', render: () => React.createElement('h1', null, 'Sign in') }),
        React.createElement(ReactRouterDOM.Route, { render: () => React.createElement('h1', null, 'Previous page') }));
}
const query = location.search.includes('missing-token') ? '?uid=test-user' : '?uid=test-user&token=test-token';
ReactDOM.createRoot(document.getElementById('root')).render(
    React.createElement(ReactRedux.Provider, { store },
        React.createElement(ReactRouterDOM.MemoryRouter, { initialEntries: ['/previous', '/auth/password/reset/confirm' + query], initialIndex: 1 }, React.createElement(Routes))));
`);
fs.writeFileSync(path.join(output, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="icon" href="data:,"><link rel="stylesheet" href="reset.css"><style>html,body,#root,.ant-layout,.ant-layout-content{height:100%}</style>
</head><body><div id="root"></div><script src="react.js"></script><script src="react-dom.js"></script><script src="dayjs.js"></script>
<script src="antd.js"></script><script src="redux.js"></script><script src="react-redux.js"></script><script src="router.js"></script>
<script src="source.js"></script><script src="harness.js"></script></body></html>`);
console.log(output);

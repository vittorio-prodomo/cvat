// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT
// Build a browser fixture with the real selector, React, and Ant Design.
// node tests/unit/user-selector-browser.cjs /tmp/cvat-user-selector-browser
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: true });
for (const [source, target] of [
    ['react/umd/react.development.js', 'react.js'],
    ['react-dom/umd/react-dom.development.js', 'react-dom.js'],
    ['dayjs/dayjs.min.js', 'dayjs.js'],
    ['antd/dist/antd.js', 'antd.js'],
    ['antd/dist/reset.css', 'reset.css'],
    ['lodash/lodash.js', 'lodash.js'],
]) {
    fs.copyFileSync(path.join(root, 'node_modules', source), path.join(output, target));
}
const sources = {
    selector: fs.readFileSync(path.join(root, 'cvat-ui/src/components/task-page/user-selector.tsx'), 'utf8'),
    dropdown: fs.readFileSync(path.join(root, 'cvat-ui/src/utils/dropdown-utils.ts'), 'utf8'),
};
const hooks = ts.createSourceFile('hooks.ts', fs.readFileSync(path.join(root, 'cvat-ui/src/utils/hooks.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const updateEffect = hooks.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'useUpdateEffect');
sources.hooks = `import { useRef, useEffect } from 'react';\n${updateEffect.getText(hooks)}`;
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
const people = [{ id: 2, username: 'baldus' }, { id: 3, username: 'alice' }];
const core = { users: { get: async (query) => people.filter(user =>
    (!query.id || user.id === query.id) && (!query.search || user.username.includes(query.search))) } };
const cache = {};
function load(name) {
    if (cache[name]) return cache[name].exports;
    const module = { exports: {} };
    cache[name] = module;
    window.modules[name](lookup, module, module.exports);
    return module.exports;
}
function lookup(name) {
    if (name === 'react') return React;
    if (name === 'antd/lib/auto-complete') return antd.AutoComplete;
    if (name === 'antd/lib/input') return antd.Input;
    if (name === 'lodash/debounce') return _.debounce;
    if (name === 'cvat-core-wrapper') return { getCore: () => core, ServerError: class extends Error {} };
    if (name === 'cvat-store') return { getCVATStore: () => ({ getState: () => ({ auth: { user: people[0] }, organizations: {} }) }) };
    if (name === 'utils/dropdown-utils') return load('dropdown');
    if (name === 'utils/hooks') return load('hooks');
    throw Error('Unexpected import: ' + name);
}
const UserSelector = load('selector').default;
window.changes = [];
function App() {
    const [value, setValue] = React.useState(location.search.includes('bulk') ? null : people[0]);
    return React.createElement('main', null,
        React.createElement('h1', null, 'Assignee'),
        React.createElement(UserSelector, { value, onSelect: (user) => {
            window.changes.push(user ? user.id : null);
            setValue(user);
        } }),
        React.createElement('button', { id: 'outside' }, 'Outside'),
        React.createElement('output', null, value?.username || 'unassigned'));
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
`);
fs.writeFileSync(path.join(output, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="icon" href="data:,"><link rel="stylesheet" href="reset.css">
<style>body{padding:32px}main{width:360px}h1{margin-bottom:16px}.ant-select{width:100%}button,output{display:block;margin-top:20px}</style>
</head><body><div id="root"></div>
<script src="react.js"></script><script src="react-dom.js"></script><script src="dayjs.js"></script>
<script src="antd.js"></script><script src="lodash.js"></script><script src="source.js"></script><script src="harness.js"></script>
</body></html>`);
console.log(output);

/* Smoke: mount the REAL Sidebar (sidebar.jsx + icons.jsx) and exercise the
   project membership gestures — expand a project to see its docs, remove a doc
   from a project, open a document's file-into-project menu and toggle it,
   create a project from a document, drag a document onto a project, and rename
   a project. Runs the client component through jsdom, like eomri-render.smoke.js.
   Run with `node tests/sidebar-projects.smoke.js`. */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const babel = require('@babel/core');

const ROOT = path.resolve(__dirname, '..');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://example.com/' });
const { window } = dom;
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);

const React = require('react');
const ReactDOMClient = require('react-dom/client');
const TestUtils = require('react-dom/test-utils');
window.React = React;
global.window = window; global.document = window.document;
try { Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true }); } catch (_) {}
global.React = React;
global.setTimeout = setTimeout; global.clearTimeout = clearTimeout;
global.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom's focus event dispatch throws on React 18's autoFocus commit (an
// `activeElement.attachEvent` quirk unrelated to the component); the rename
// input uses autoFocus, so neutralise focus() in this headless environment.
try { Object.defineProperty(window.HTMLElement.prototype, 'focus', { value() {}, configurable: true }); } catch (_) {}
const origErr = console.error;
console.error = (...a) => { const s = a.map(x => (x && x.stack) || String(x)).join(' '); if (/act\(|deprecated/.test(s)) return; origErr.apply(console, a); };

function run(file) {
  let code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (file.endsWith('.jsx')) code = babel.transform(code, { presets: [require('@babel/preset-react')], filename: file }).code;
  (0, eval)(code);
}
for (const f of ['icons.jsx', 'sidebar.jsx']) run(f);
const W = window;

let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } };
const Simulate = TestUtils.Simulate;
const act = TestUtils.act;

// ---- world: three docs, two projects (p1 has doc-1; p2 has doc-1 & doc-2) ----
const docs = [
  { id: 'doc-1', name: 'Alpha.txt', kind: 'prose' },
  { id: 'doc-2', name: 'Beta.csv', kind: 'table' },
  { id: 'doc-3', name: 'Gamma.md', kind: 'prose' },
];
let projects = [
  { id: 'p1', name: 'Research', docIds: ['doc-1'] },
  { id: 'p2', name: 'Drafts', docIds: ['doc-1', 'doc-2'] },
];
const calls = [];
const rec = (k) => (...a) => calls.push([k, ...a]);

const props = {
  collapsed: false, onToggle() {}, docs, openTabs: [], activeDoc: null,
  onOpenDoc: rec('open'), onUpload() {}, chats: [], activeChat: 'new',
  onNewChat() {}, onSelectChat() {}, model: { name: 'test', provider: 'local' },
  onModelClick() {}, onRulesClick() {}, onSettingsClick() {}, enabledRules: 3, modelStatus: 'ready',
  projects, activeProject: null,
  onSelectProject: rec('select'), onNewProject: rec('newproj'),
  onDeleteProject: rec('delete'), onClearProject: rec('clear'),
  onRenameProject: rec('rename'), onNewProjectWithDoc: rec('newWithDoc'),
  onAddDocToProject: rec('add'), onRemoveDocFromProject: rec('remove'),
  onToggleDocInProject: rec('toggle'),
  sourceIds: new Set(['doc-1']), onToggleSource: rec('source'),
};

const container = W.document.getElementById('root');
const root = ReactDOMClient.createRoot(container);
const render = () => act(() => { root.render(React.createElement(W.Sidebar, props)); });

let threw = null;
try { render(); } catch (e) { threw = e; }
ok(!threw, 'Sidebar mounts without throwing' + (threw ? ' — ' + threw.message : ''));

const txt = () => container.textContent || '';
const $ = (sel) => container.querySelector(sel);
const $$ = (sel) => [...container.querySelectorAll(sel)];

ok(/Research/.test(txt()) && /Drafts/.test(txt()), 'both project names render');
ok(/Alpha\.txt/.test(txt()) && /Beta\.csv/.test(txt()), 'document names render');

const projRows = $$('.sb-proj > .sb-item');
ok(projRows.length === 2, 'two project rows rendered');
// each project shows its member count
ok($$('.sb-proj > .sb-item .count').map(n => n.textContent).join(',') === '1,2', 'project counts reflect docIds (1, 2)');

// ---- expand a project to reveal its members, then remove one (move OUT) ----
const caret1 = projRows[0].querySelector('.sb-caret');
act(() => Simulate.click(caret1));
let members = $$('.sb-proj')[0].querySelectorAll('.sb-item.member');
ok(members.length === 1, 'expanding "Research" reveals its single member');
ok(/Alpha\.txt/.test(members[0].textContent), 'the member is the doc that was filed (Alpha.txt)');

// clicking the caret should NOT have selected the project
ok(!calls.some(c => c[0] === 'select'), 'clicking the caret expands without selecting the project');

act(() => Simulate.click(members[0].querySelector('.sb-x')));
ok(calls.some(c => c[0] === 'remove' && c[1] === 'doc-1' && c[2] === 'p1'), 'removing a member calls onRemoveDocFromProject(doc-1, p1)');

// ---- a document's file-into-project menu: toggle membership (move IN/OUT) ----
const docRows = $$('.sb-docrow');
ok(docRows.length === 3, 'three document rows rendered');
// doc-3 (Gamma) is filed in no project, so its folder button is not tinted "on"
const gammaFolder = docRows[2].querySelector('.sb-src.proj');
ok(gammaFolder && !/\bon\b/.test(gammaFolder.className), 'an unfiled document\'s folder button is not tinted');
// doc-1 (Alpha) is filed in p1 & p2, so its folder button IS tinted
ok(/\bon\b/.test(docRows[0].querySelector('.sb-src.proj').className), 'a filed document\'s folder button is tinted on');

act(() => Simulate.click(gammaFolder));
const menu = $('.sb-addmenu');
ok(menu, 'clicking the folder button opens the file-into-project menu');
const menuRows = menu.querySelectorAll('.sb-addmenu-row');
ok(menuRows.length === 3, 'the menu lists both projects plus a "New project…" row');
ok(/New project/.test(menuRows[2].textContent), 'the last row is "New project…"');

act(() => Simulate.click(menuRows[0]));   // file Gamma into "Research"
ok(calls.some(c => c[0] === 'toggle' && c[1] === 'doc-3' && c[2] === 'p1'), 'a menu row toggles the doc into that project (doc-3 → p1)');

act(() => Simulate.click(menuRows[2]));   // New project… seeded with Gamma
ok(calls.some(c => c[0] === 'newWithDoc' && c[1] === 'doc-3'), '"New project…" creates a project seeded with the document');

// ---- drag a document onto a project (move IN) ----
const alphaRow = docRows[0].querySelector('.sb-item');
const fakeDT = { _d: {}, types: [], setData(t, v) { this._d[t] = v; this.types = Object.keys(this._d); }, getData(t) { return this._d[t] || ''; }, dropEffect: '', effectAllowed: '' };
act(() => Simulate.dragStart(alphaRow, { dataTransfer: fakeDT }));
const draftsRow = projRows[1];   // "Drafts"
act(() => Simulate.dragOver(draftsRow, { dataTransfer: fakeDT }));
act(() => Simulate.drop(draftsRow, { dataTransfer: fakeDT }));
ok(calls.some(c => c[0] === 'add' && c[1] === 'doc-1' && c[2] === 'p2'), 'dropping a document on a project calls onAddDocToProject(doc-1, p2)');

// ---- rename a project inline ----
const nameSpan = projRows[1].querySelector('.tl');
act(() => Simulate.doubleClick(nameSpan));
const input = $('.sb-rename');
ok(input, 'double-clicking a project name opens an inline rename input');
input.value = 'Renamed';
act(() => { Simulate.change(input); Simulate.keyDown(input, { key: 'Enter' }); });
ok(calls.some(c => c[0] === 'rename' && c[1] === 'p2' && c[2] === 'Renamed'), 'Enter in the rename input calls onRenameProject(p2, "Renamed")');

// ---- the source toggle still works (unchanged behaviour) ----
act(() => Simulate.click(docRows[1].querySelector('.sb-src:not(.proj)')));
ok(calls.some(c => c[0] === 'source' && c[1] === 'doc-2'), 'the source +/✓ toggle still calls onToggleSource(doc-2)');

// ---- with NO projects, a document can still start one via its folder menu ----
props.projects = []; props.activeProject = null;
render();
const folder0 = $$('.sb-docrow')[0].querySelector('.sb-src.proj');
ok(folder0, 'the folder button is present even when there are no projects');
act(() => Simulate.click(folder0));
const menu0 = $('.sb-addmenu');
ok(menu0 && menu0.querySelectorAll('.sb-addmenu-row').length === 1 && /New project/.test(menu0.textContent),
   'with no projects the menu offers only "New project…"');

act(() => root.unmount());

// ---- the new-project modal (replaces window.prompt): name, preview, confirm ----
const docsById = { 'doc-1': docs[0], 'doc-2': docs[1], 'doc-3': docs[2] };
const mContainer = W.document.createElement('div'); W.document.body.appendChild(mContainer);
const mRoot = ReactDOMClient.createRoot(mContainer);
const created = [];
act(() => mRoot.render(React.createElement(W.ProjectModal, {
  seed: { ids: ['doc-1', 'doc-2'], activate: true, fallback: 'Project 3' },
  docsById, onCreate: (n) => created.push(n), onClose() {},
})));
const mtxt = () => mContainer.textContent || '';
ok(/New project/.test(mtxt()), 'the project modal renders with a title');
const pinput = mContainer.querySelector('.proj-input');
ok(pinput && pinput.value === 'Project 3', 'the name field is pre-filled with the suggested name');
ok(/Starts with 2 sources/.test(mtxt()) && /Alpha\.txt/.test(mtxt()) && /Beta\.csv/.test(mtxt()),
   'the modal previews the seed documents');
pinput.value = 'My Project';
act(() => Simulate.change(pinput));                                   // flush the controlled-input update
act(() => Simulate.click(mContainer.querySelector('.btn-primary'))); // then Create
ok(created.length === 1 && created[0] === 'My Project', 'Create commits the typed name via onCreate');
act(() => mRoot.unmount());

// empty seed → "starts empty" hint; Enter submits the unchanged fallback name
const m2 = W.document.createElement('div'); W.document.body.appendChild(m2);
const m2Root = ReactDOMClient.createRoot(m2);
const created2 = [];
act(() => m2Root.render(React.createElement(W.ProjectModal, {
  seed: { ids: [], activate: false, fallback: 'Project 1' },
  docsById, onCreate: (n) => created2.push(n), onClose() {},
})));
ok(/Starts empty/.test(m2.textContent || ''), 'with no seed the modal shows the "starts empty" hint');
act(() => Simulate.keyDown(m2.querySelector('.proj-input'), { key: 'Enter' }));
ok(created2.length === 1 && created2[0] === 'Project 1', 'Enter submits the fallback name when left unchanged');
act(() => m2Root.unmount());

console.log(`\nsidebar-projects: ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFAILURES:\n - ' + fails.join('\n - ')); process.exit(1); }
process.exit(0);

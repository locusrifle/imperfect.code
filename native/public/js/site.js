import { grid, bindHarnessKeys, registerKeyBinding } from './pi-card.js';
import { mountGueyPi } from './harness.js';

const byId = id => document.getElementById(id);
const entry = byId('terminal-entry');
const input = byId('entry-input');
const reach = byId('harness-reach');

function resizeGrid() {
  grid();
  dispatchEvent(new CustomEvent('imperfect:gridchange'));
}

function isOpen() {
  return entry.classList.contains('open');
}

function openHarness() {
  entry.classList.add('open');
  reach.hidden = true;
  input.focus();
}

function closeHarness() {
  entry.classList.remove('open');
  reach.hidden = false;
  input.blur();
}

function toggleHarness() {
  isOpen() ? closeHarness() : openHarness();
}

function lineHeight(node) {
  const style = getComputedStyle(node);
  const value = Number.parseFloat(style.lineHeight);
  return Number.isFinite(value) ? value : (Number.parseFloat(style.fontSize) || 16) * 1.2;
}

function growComposer() {
  input.style.height = 'auto';
  const line = lineHeight(input);
  input.style.height = `${Math.min(Math.max(input.scrollHeight, line), Math.floor(innerHeight * 0.3))}px`;
}

resizeGrid();

const harness = mountGueyPi({
  elements: {
    output: byId('entry-output'),
    input,
    dialog: byId('entry-dialog'),
    widgets: byId('entry-widgets'),
    slashMenu: byId('slash-menu'),
    modelStatus: byId('entry-model-status'),
    modelName: byId('entry-pi-label'),
    spend: byId('entry-spend'),
    thinking: byId('entry-thinking'),
    permission: byId('entry-permission'),
    sessionTitle: byId('entry-session-name'),
    sessionSource: byId('entry-source'),
    sessionCwd: byId('entry-cwd'),
    context: byId('entry-context'),
    screen: document.querySelector('.entry-screen'),
  },
  hooks: {
    onDraftChange: growComposer,
    onReveal: openHarness,
    canFocus: isOpen,
    onEscapeIdle: closeHarness,
  },
});

function openTabs() {
  if (!isOpen()) openHarness();
  harness.openTabs();
}

function toggleTabs() {
  if (isOpen() && harness.tabsOpen()) {
    harness.closeTabs();
    closeHarness();
    return;
  }
  openTabs();
}

bindHarnessKeys({ onHarness: toggleHarness, onTabs: toggleTabs });
registerKeyBinding({
  label: 'Alt+←', description: 'previous tab', code: 'ArrowLeft', alt: true,
  when: () => (harness.guiSnapshot().tabs ?? []).length > 1,
  handler: () => harness.cycleTab(-1),
});
registerKeyBinding({
  label: 'Alt+→', description: 'next tab', code: 'ArrowRight', alt: true,
  when: () => (harness.guiSnapshot().tabs ?? []).length > 1,
  handler: () => harness.cycleTab(1),
});
registerKeyBinding({
  label: 'Alt+Shift+←', description: 'move tab previous', code: 'ArrowLeft', alt: true, shift: true,
  when: () => (harness.guiSnapshot().tabs ?? []).length > 1,
  handler: () => harness.moveTab(-1),
});
registerKeyBinding({
  label: 'Alt+Shift+→', description: 'move tab next', code: 'ArrowRight', alt: true, shift: true,
  when: () => (harness.guiSnapshot().tabs ?? []).length > 1,
  handler: () => harness.moveTab(1),
});
registerKeyBinding({
  label: 'Alt+Enter', description: 'new tab', code: 'Enter', alt: true,
  when: () => document.activeElement !== input || !input.value.trim(),
  handler: () => harness.newTab().catch(() => {}),
});
registerKeyBinding({
  label: 'Alt+Esc', description: 'close focused tab', code: 'Escape', alt: true,
  handler: () => {
    const tabs = harness.guiSnapshot().tabs ?? [];
    if (tabs.length <= 1) return;
    const focused = tabs.find(tab => tab.focused);
    if (focused) harness.closeTab(focused.id).catch(() => {});
  },
});

reach.addEventListener('click', openHarness);
input.addEventListener('input', growComposer);
addEventListener('resize', resizeGrid);
growComposer();
openHarness();

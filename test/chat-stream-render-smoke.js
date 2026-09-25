'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const chatPath = path.join(root, 'renderer', 'tools', 'chat', 'chat.js');
let source = fs.readFileSync(chatPath, 'utf8');

const testHook = `
window.__chatStreamingTest = {
  configure(state) {
    cancelStreamingRender();
    pendingTurn = state.pendingTurn;
    streamingText = state.streamingText || '';
    isGenerating = state.isGenerating !== false;
    isStopping = false;
    isDownloading = false;
    isImporting = false;
    isFollowingOutput = state.isFollowingOutput !== false;
    ws = state.ws || null;
    log = () => {};
    clearLog = () => {};
    models = [];
    selectedModel = '';
    chatMessages = state.chatMessages;
    chatJumpBtn = state.chatJumpBtn;
    statusText = state.statusText;
    chatSendBtn = state.controls.chatSendBtn;
    chatStopBtn = state.controls.chatStopBtn;
    chatClearBtn = state.controls.chatClearBtn;
    chatInput = state.controls.chatInput;
    modelSelect = state.controls.modelSelect;
    executionSelect = state.controls.executionSelect;
    profileSelect = state.controls.profileSelect;
    styleSelect = state.controls.styleSelect;
    lengthSelect = state.controls.lengthSelect;
    importModelBtn = state.controls.importModelBtn;
    downloadModelBtn = state.controls.downloadModelBtn;
  },
  handleWSMessage,
  completeGeneration,
  completeCancellation,
  failCurrentTurn,
  deactivate,
  hasPendingFrame: () => streamingRenderFrameId !== null,
  streamingText: () => streamingText,
  turns: () => turns.slice(),
};
`;

source = source.replace(/\n\}\)\(\);\s*$/, `${testHook}\n})();`);
assert(source.includes('window.__chatStreamingTest'), 'Could not install the chat test hook');

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : !!force;
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

class FakeTextNode {
  constructor(value = '') {
    this.nodeType = 3;
    this._nodeValue = String(value);
    this.writeCount = 0;
  }
  get nodeValue() { return this._nodeValue; }
  set nodeValue(value) {
    this._nodeValue = String(value);
    this.writeCount += 1;
  }
  get textContent() { return this._nodeValue; }
  set textContent(value) { this.nodeValue = value; }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.childNodes = [];
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.isConnected = true;
    this.scrollHeight = 800;
    this.clientHeight = 300;
    this._scrollTop = 0;
    this.scrollWriteCount = 0;
  }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get childElementCount() { return this.children.length; }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(new FakeTextNode(value)); }
  get scrollTop() { return this._scrollTop; }
  set scrollTop(value) {
    this._scrollTop = value;
    this.scrollWriteCount += 1;
  }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node) { this.childNodes.push(node); return node; }
  replaceChildren(...nodes) { this.childNodes = nodes; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  focus() { this.focused = true; }
  remove() { this.removed = true; }
  querySelectorAll() { return []; }
}

function createMessage(text = 'Thinking') {
  const wrap = new FakeElement();
  const bubble = new FakeElement();
  bubble.textContent = text;
  const footer = new FakeElement();
  const actions = new FakeElement();
  const meta = new FakeElement('span');
  return { role: 'assistant', wrap, bubble, footer, actions, meta, rawText: text };
}

function createControls() {
  const controls = {};
  for (const name of [
    'chatSendBtn', 'chatStopBtn', 'chatClearBtn', 'chatInput',
    'modelSelect', 'executionSelect', 'profileSelect', 'styleSelect',
    'lengthSelect', 'importModelBtn', 'downloadModelBtn',
  ]) controls[name] = new FakeElement(name.includes('Select') ? 'select' : 'button');
  controls.chatInput.focus = function focus() { this.focused = true; };
  return controls;
}

let nextFrameId = 1;
const animationFrames = new Map();
const windowObject = {
  requestAnimationFrame(callback) {
    const id = nextFrameId++;
    animationFrames.set(id, callback);
    return id;
  },
  cancelAnimationFrame(id) { animationFrames.delete(id); },
  registerTool() {},
  isToolActive: () => true,
};

const documentObject = {
  body: new FakeElement('body'),
  createElement: tag => new FakeElement(tag),
  createTextNode: value => new FakeTextNode(value),
  getElementById: () => null,
};

const context = vm.createContext({
  window: windowObject,
  document: documentObject,
  navigator: {},
  Node: { TEXT_NODE: 3 },
  WebSocket: { OPEN: 1 },
  console,
  setTimeout,
  clearTimeout,
});
vm.runInContext(source, context, { filename: chatPath });

const chat = windowObject.__chatStreamingTest;
assert(chat, 'Chat streaming test API was not initialized');

function configure(text = 'Thinking', options = {}) {
  const assistant = createMessage(text);
  const user = createMessage('Prompt');
  const chatMessages = new FakeElement();
  const chatJumpBtn = new FakeElement('button');
  chatJumpBtn.hidden = true;
  const statusText = new FakeElement('span');
  const controls = createControls();
  chat.configure({
    pendingTurn: { text: 'Prompt', user, assistant },
    chatMessages,
    chatJumpBtn,
    statusText,
    controls,
    isFollowingOutput: options.isFollowingOutput,
  });
  return { assistant, chatMessages, chatJumpBtn, statusText, controls };
}

function runAnimationFrame() {
  const callbacks = Array.from(animationFrames.values());
  animationFrames.clear();
  callbacks.forEach(callback => callback(0));
  return callbacks.length;
}

// A burst of tokens should cause one text mutation and one scroll at the next
// paint, regardless of how many WebSocket messages arrived first.
let state = configure();
const initialTextNode = state.assistant.bubble.firstChild;
for (const token of ['one', ' ', 'two', ' ', 'three']) {
  chat.handleWSMessage({ type: 'token', text: token });
}
assert.strictEqual(animationFrames.size, 1, 'Token bursts must share one animation frame');
assert.strictEqual(initialTextNode.writeCount, 0, 'Tokens must not mutate text before the frame');
assert.strictEqual(state.chatMessages.scrollWriteCount, 0, 'Tokens must not scroll before the frame');
assert.strictEqual(runAnimationFrame(), 1, 'Exactly one streaming frame should run');
assert.strictEqual(initialTextNode.nodeValue, 'one two three');
assert.strictEqual(initialTextNode.writeCount, 1, 'The burst should produce one text mutation');
assert.strictEqual(state.chatMessages.scrollWriteCount, 1, 'The burst should produce one scroll');

// Users reading above the live output must stay put; the batched commit should
// still update the polite live region and expose the existing jump control.
state = configure('Thinking', { isFollowingOutput: false });
chat.handleWSMessage({ type: 'token', text: 'new text' });
runAnimationFrame();
assert.strictEqual(state.assistant.bubble.textContent, 'new text');
assert.strictEqual(state.chatMessages.scrollWriteCount, 0);
assert.strictEqual(state.chatJumpBtn.hidden, false);

// Deactivation happens before app.js detaches the cached tool DOM. It must
// synchronously flush received tokens and cancel the queued frame.
state = configure();
const deactivateTextNode = state.assistant.bubble.firstChild;
chat.handleWSMessage({ type: 'token', text: 'cached reply' });
assert(chat.hasPendingFrame());
chat.deactivate();
assert.strictEqual(animationFrames.size, 0, 'Deactivation must cancel the queued frame');
assert.strictEqual(deactivateTextNode.nodeValue, 'cached reply');
assert.strictEqual(deactivateTextNode.writeCount, 1);
assert.strictEqual(state.chatMessages.scrollWriteCount, 1);

// A flush with no buffered token work must not erase the initial thinking
// placeholder merely because the user navigated away quickly.
state = configure();
const untouchedTextNode = state.assistant.bubble.firstChild;
chat.deactivate();
assert.strictEqual(untouchedTextNode.nodeValue, 'Thinking');
assert.strictEqual(untouchedTextNode.writeCount, 0);
assert.strictEqual(state.chatMessages.scrollWriteCount, 0);

// Completion must include tokens which have not reached a paint yet, cancel
// stale frame work, render the final message once, and retain model context.
state = configure();
chat.handleWSMessage({ type: 'token', text: 'final ' });
chat.handleWSMessage({ type: 'token', text: 'answer' });
chat.handleWSMessage({ type: 'done', stats: { elapsed_seconds: 1.2 } });
assert.strictEqual(animationFrames.size, 0, 'Completion must cancel the queued frame');
assert.strictEqual(state.assistant.bubble.textContent, 'final answer');
assert.strictEqual(state.assistant.rawText, 'final answer');
assert.strictEqual(state.chatMessages.scrollWriteCount, 1);
assert.match(state.statusText.textContent, /^Ready/);
assert.strictEqual(chat.turns().at(-1).user, 'Prompt');
assert.strictEqual(chat.turns().at(-1).assistant, 'final answer');

// Cancellation keeps an unpainted partial response; errors replace it and in
// both cases no stale RAF callback may overwrite the terminal presentation.
state = configure();
chat.handleWSMessage({ type: 'token', text: 'partial response' });
chat.handleWSMessage({ type: 'cancelled' });
assert.strictEqual(animationFrames.size, 0);
assert.strictEqual(state.assistant.bubble.textContent, 'partial response');
assert(state.assistant.bubble.classList.contains('partial'));
assert.strictEqual(state.chatMessages.scrollWriteCount, 1);
assert.match(state.statusText.textContent, /^Stopped/);

state = configure();
chat.handleWSMessage({ type: 'token', text: 'must not survive' });
chat.handleWSMessage({ type: 'error', error: 'generation failed' });
assert.strictEqual(animationFrames.size, 0);
assert.strictEqual(state.assistant.bubble.textContent, 'generation failed');
assert(state.assistant.bubble.classList.contains('error'));
assert.strictEqual(state.chatMessages.scrollWriteCount, 1);
assert.strictEqual(state.statusText.textContent, 'generation failed');

console.log('Chat stream render smoke test passed');

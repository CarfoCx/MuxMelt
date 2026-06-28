// ============================================================================
// Local Chat Tool (WebSocket-based, fully offline LLM)
// ============================================================================

(function() {

let ws = null;
let pythonPort = null;
let pythonToken = null;
let log = null;

let reconnectDelay = 1000;
let reconnectAttempts = 0;
let reconnectTimerId = null;
const MAX_RECONNECT_DELAY = 30000;

let models = [];          // [{id, name, approx_mb, downloaded}]
let selectedModel = '';
let engineAvailable = true;

let messages = [];        // [{role:'user'|'assistant', content}]
let isGenerating = false;
let isDownloading = false;
let streamingText = '';
let currentBubble = null; // the assistant bubble being streamed into

let modelSelect, styleSelect, modelStatus, downloadModelBtn, chatDownload, chatDownloadLabel, chatDownloadFill;
let chatMessages, chatEmpty, chatInput, chatSendBtn, chatClearBtn, statusText;

function init(ctx) {
  pythonPort = ctx.pythonPort;
  pythonToken = ctx.pythonToken;
  log = ctx.log;

  modelSelect = document.getElementById('modelSelect');
  styleSelect = document.getElementById('styleSelect');
  modelStatus = document.getElementById('modelStatus');
  downloadModelBtn = document.getElementById('downloadModelBtn');
  chatDownload = document.getElementById('chatDownload');
  chatDownloadLabel = document.getElementById('chatDownloadLabel');
  chatDownloadFill = document.getElementById('chatDownloadFill');
  chatMessages = document.getElementById('chatMessages');
  chatEmpty = document.getElementById('chatEmpty');
  chatInput = document.getElementById('chatInput');
  chatSendBtn = document.getElementById('chatSendBtn');
  chatClearBtn = document.getElementById('chatClearBtn');
  statusText = document.getElementById('statusText');

  bindEvents();
  connectWebSocket(pythonPort);
}

function cleanup() {
  if (reconnectTimerId) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

// ---- WebSocket ----
function connectWebSocket(port) {
  ws = new WebSocket(`ws://127.0.0.1:${port}/chat/ws?token=${encodeURIComponent(pythonToken || '')}`);
  ws.onopen = () => {
    reconnectDelay = 1000; reconnectAttempts = 0;
    ws.send(JSON.stringify({ action: 'list_models' }));
  };
  ws.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); }
    catch { return; } // ignore malformed frames rather than throwing in the socket loop
    handleWSMessage(data);
  };
  ws.onclose = () => {
    if (!statusText) return;
    statusText.textContent = 'Disconnected — reconnecting…';
    reconnectAttempts++;
    const delay = Math.min(reconnectDelay * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    reconnectTimerId = setTimeout(() => connectWebSocket(port), delay);
  };
  ws.onerror = () => { if (statusText) statusText.textContent = 'Connection error'; };
}

function handleWSMessage(data) {
  switch (data.type) {
    case 'models':
      models = data.models || [];
      engineAvailable = data.engine !== false;
      populateModels(data.default);
      break;
    case 'status':
      if (currentBubble) setBubbleText(currentBubble, data.message + '…');
      if (statusText) statusText.textContent = data.message;
      break;
    case 'start':
      if (currentBubble) { streamingText = ''; setBubbleText(currentBubble, ''); }
      if (statusText) statusText.textContent = 'Generating…';
      break;
    case 'token':
      streamingText += data.text;
      if (currentBubble) setBubbleText(currentBubble, streamingText);
      scrollToBottom();
      break;
    case 'done':
      finishGeneration();
      break;
    case 'need_download':
      if (currentBubble) currentBubble.closest('.chat-msg')?.remove();
      finishGeneration(true);
      if (statusText) statusText.textContent = 'Model needs to be downloaded first';
      promptDownload();
      break;
    case 'error':
      if (currentBubble) {
        currentBubble.classList.add('error');
        setBubbleText(currentBubble, `Error: ${data.error}`);
      } else {
        addMessageEl('assistant', `Error: ${data.error}`, true);
      }
      log(`Chat error: ${data.error}`, 'error');
      finishGeneration(true);
      break;
    case 'download_start':
      isDownloading = true;
      chatDownload.style.display = '';
      chatDownloadFill.style.width = '0%';
      chatDownloadLabel.textContent = 'Starting download…';
      updateControls();
      break;
    case 'download_progress': {
      const pct = Math.round((data.progress || 0) * 100);
      chatDownloadFill.style.width = `${pct}%`;
      const mb = (n) => `${(n / (1024 * 1024)).toFixed(0)} MB`;
      chatDownloadLabel.textContent = data.total
        ? `Downloading model — ${mb(data.downloaded)} / ${mb(data.total)} (${pct}%)`
        : `Downloading model — ${mb(data.downloaded)}`;
      break;
    }
    case 'download_complete':
      isDownloading = false;
      chatDownload.style.display = 'none';
      markDownloaded(data.model, true);
      log('Model downloaded — ready to chat', 'success');
      updateModelStatus();
      updateControls();
      break;
    case 'download_error':
      isDownloading = false;
      chatDownload.style.display = 'none';
      log(`Model download failed: ${data.error}`, 'error');
      if (statusText) statusText.textContent = `Download failed: ${data.error}`;
      updateControls();
      break;
  }
}

// ---- Models ----
function populateModels(defaultId) {
  modelSelect.innerHTML = '';
  if (!engineAvailable) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Chat engine not installed';
    modelSelect.appendChild(opt);
    modelStatus.textContent = 'The local chat engine is not installed in this build.';
    downloadModelBtn.style.display = 'none';
    chatSendBtn.disabled = true;
    return;
  }
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name + (m.downloaded ? '  ✓' : '');
    modelSelect.appendChild(opt);
  });
  // Prefer a model that's already downloaded, else the backend default.
  const downloaded = models.find(m => m.downloaded);
  selectedModel = (downloaded && downloaded.id) || defaultId || (models[0] && models[0].id) || '';
  modelSelect.value = selectedModel;
  updateModelStatus();
  updateControls();
}

function currentModel() {
  return models.find(m => m.id === selectedModel) || null;
}

function markDownloaded(modelId, val) {
  const m = models.find(x => x.id === modelId);
  if (m) m.downloaded = val;
  // refresh the ✓ in the dropdown
  Array.from(modelSelect.options).forEach(o => {
    const mm = models.find(x => x.id === o.value);
    if (mm) o.textContent = mm.name + (mm.downloaded ? '  ✓' : '');
  });
}

function updateModelStatus() {
  const m = currentModel();
  if (!m) { modelStatus.textContent = ''; return; }
  if (m.downloaded) {
    modelStatus.textContent = 'Ready · runs offline on your machine';
    downloadModelBtn.style.display = 'none';
  } else {
    modelStatus.textContent = `Not downloaded · ~${m.approx_mb} MB, one-time`;
    downloadModelBtn.style.display = '';
  }
}

function promptDownload() {
  const m = currentModel();
  if (m && !m.downloaded) downloadModelBtn.style.display = '';
}

function downloadModel() {
  if (isDownloading || !selectedModel) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) { log('Not connected to backend', 'error'); return; }
  ws.send(JSON.stringify({ action: 'download', model: selectedModel }));
}

// ---- Sending ----
function send() {
  if (isGenerating) {           // acts as a Stop button mid-generation
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'cancel' }));
    return;
  }
  const text = (chatInput.value || '').trim();
  if (!text) return;
  if (!engineAvailable) { log('The local chat engine is not installed.', 'error'); return; }
  if (!selectedModel) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) { log('Not connected to backend', 'error'); return; }

  const m = currentModel();
  if (m && !m.downloaded) { promptDownload(); if (statusText) statusText.textContent = 'Download the model first'; return; }

  messages.push({ role: 'user', content: text });
  addMessageEl('user', text);
  chatInput.value = '';
  autoGrow();

  // Create the assistant bubble up front so the user sees it "thinking".
  currentBubble = addMessageEl('assistant', '');
  setBubbleText(currentBubble, 'Thinking…');
  streamingText = '';

  isGenerating = true;
  updateControls();
  const style = (styleSelect && styleSelect.value) || 'balanced';
  ws.send(JSON.stringify({ action: 'chat', model: selectedModel, messages, style }));
}

function finishGeneration(failed = false) {
  if (!failed && currentBubble && streamingText) {
    messages.push({ role: 'assistant', content: streamingText });
  } else if (!failed && currentBubble && !streamingText) {
    // Empty reply — drop the empty bubble.
    currentBubble.closest('.chat-msg')?.remove();
  }
  currentBubble = null;
  streamingText = '';
  isGenerating = false;
  if (statusText && !failed) statusText.textContent = 'Ready';
  updateControls();
}

function updateControls() {
  chatSendBtn.textContent = isGenerating ? 'Stop' : 'Send';
  chatSendBtn.classList.toggle('btn-cancel', isGenerating);
  chatSendBtn.disabled = (!engineAvailable && !isGenerating) || isDownloading;
  modelSelect.disabled = isGenerating || isDownloading;
  downloadModelBtn.disabled = isDownloading;
  downloadModelBtn.textContent = isDownloading ? 'Downloading…' : 'Download model';
}

// ---- Rendering ----
function addMessageEl(role, text, isError) {
  if (chatEmpty) chatEmpty.style.display = 'none';
  const wrap = document.createElement('div');
  wrap.className = `chat-msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble' + (isError ? ' error' : '');
  bubble.textContent = text;
  wrap.appendChild(bubble);
  chatMessages.appendChild(wrap);
  scrollToBottom();
  return bubble;
}

// textContent (never innerHTML) so model output can't inject markup; CSS
// white-space: pre-wrap preserves the model's own line breaks.
function setBubbleText(bubble, text) {
  bubble.textContent = text;
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function clearChat() {
  if (isGenerating) return;
  messages = [];
  chatMessages.innerHTML = '<div class="chat-empty" id="chatEmpty">Pick a model and say hello. Everything stays on your machine.</div>';
  chatEmpty = document.getElementById('chatEmpty');
  if (statusText) statusText.textContent = 'Local Chat';
  if (window.clearLog) window.clearLog();
}

function autoGrow() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
}

// ---- Events ----
function bindEvents() {
  chatSendBtn.addEventListener('click', send);
  chatClearBtn.addEventListener('click', clearChat);
  downloadModelBtn.addEventListener('click', downloadModel);

  modelSelect.addEventListener('change', () => {
    selectedModel = modelSelect.value;
    updateModelStatus();
    updateControls();
  });

  chatInput.addEventListener('input', autoGrow);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
}

window.registerTool('chat', { init, cleanup });

})();

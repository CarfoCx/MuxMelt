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
let preferredModel = '';
let _saveTimer = null;

let messages = [];        // [{role:'user'|'assistant', content}]
let isGenerating = false;
let isDownloading = false;
let isCancellingDownload = false;
let streamingText = '';
let currentBubble = null; // the assistant bubble being streamed into
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 8000;

let modelSelect, styleSelect, modelStatus, downloadModelBtn, chatDownload, chatDownloadLabel, chatDownloadFill;
let chatMessages, chatEmpty, chatInput, chatSendBtn, chatClearBtn, statusText;

async function init(ctx) {
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

  await loadToolSettings();
  bindEvents();
  connectWebSocket(pythonPort);
  updateControls();
}

function cleanup() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (reconnectTimerId) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

// ---- WebSocket ----
function connectWebSocket(port) {
  ws = new WebSocket(`ws://127.0.0.1:${port}/chat/ws?token=${encodeURIComponent(pythonToken || '')}`);
  ws.onopen = () => {
    reconnectDelay = 1000; reconnectAttempts = 0;
    reconnectTimerId = null;
    if (statusText) statusText.textContent = 'Loading models...';
    ws.send(JSON.stringify({ action: 'list_models' }));
    updateControls();
  };
  ws.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); }
    catch { return; } // ignore malformed frames rather than throwing in the socket loop
    handleWSMessage(data);
  };
  ws.onclose = () => {
    if (!statusText) return;
    if (isDownloading) {
      isDownloading = false;
      isCancellingDownload = false;
      chatDownload.style.display = 'none';
      chatDownloadFill.style.width = '0%';
      log('Model download interrupted by backend disconnect', 'warn');
    }
    if (isGenerating) {
      if (currentBubble) {
        currentBubble.classList.add('error');
        setBubbleText(currentBubble, 'Generation interrupted by backend disconnect');
      }
      restorePendingUserTurn();
      finishGeneration(true);
    }
    statusText.textContent = 'Disconnected — reconnecting…';
    reconnectAttempts++;
    const delay = Math.min(reconnectDelay * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    reconnectTimerId = setTimeout(() => connectWebSocket(port), delay);
    updateControls();
  };
  ws.onerror = () => { if (statusText) statusText.textContent = 'Connection error'; };
}

function handleWSMessage(data) {
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
  switch (data.type) {
    case 'models':
      models = Array.isArray(data.models)
        ? data.models.filter(model => model && typeof model.id === 'string' && typeof model.name === 'string')
        : [];
      engineAvailable = data.engine !== false;
      populateModels(data.default);
      break;
    case 'status':
      if (typeof data.message !== 'string') return;
      if (currentBubble) setBubbleText(currentBubble, data.message + '…');
      if (statusText) statusText.textContent = data.message;
      break;
    case 'start':
      if (currentBubble) { streamingText = ''; setBubbleText(currentBubble, ''); }
      if (statusText) statusText.textContent = 'Generating…';
      break;
    case 'token':
      if (typeof data.text !== 'string') return;
      streamingText += data.text;
      if (currentBubble) setBubbleText(currentBubble, streamingText);
      scrollToBottom();
      break;
    case 'done':
      finishGeneration();
      break;
    case 'cancelled':
      // Keep any partial answer already streamed, but always leave the Stop /
      // Thinking state even when cancellation happened during cold loading.
      finishGeneration();
      if (statusText) statusText.textContent = 'Stopped';
      break;
    case 'need_download':
      if (currentBubble) {
        const assistantMessage = currentBubble.closest('.chat-msg');
        const userMessage = assistantMessage?.previousElementSibling;
        assistantMessage?.remove();
        if (messages[messages.length - 1]?.role === 'user') {
          chatInput.value = messages.pop().content;
          autoGrow();
          userMessage?.remove();
        }
      }
      finishGeneration(true);
      if (statusText) statusText.textContent = 'Model needs to be downloaded first';
      promptDownload();
      break;
    case 'error':
      restorePendingUserTurn();
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
      const progress = Math.max(0, Math.min(1, Number(data.progress) || 0));
      const pct = Math.round(progress * 100);
      chatDownloadFill.style.width = `${pct}%`;
      const mb = (n) => `${(Math.max(0, Number(n) || 0) / (1024 * 1024)).toFixed(0)} MB`;
      chatDownloadLabel.textContent = data.total
        ? `Downloading model — ${mb(data.downloaded)} / ${mb(data.total)} (${pct}%)`
        : `Downloading model — ${mb(data.downloaded)}`;
      break;
    }
    case 'download_complete':
      isDownloading = false;
      isCancellingDownload = false;
      chatDownload.style.display = 'none';
      markDownloaded(data.model, true);
      log('Model downloaded — ready to chat', 'success');
      updateModelStatus();
      updateControls();
      break;
    case 'download_error': {
      const wasCancelled = isCancellingDownload || /cancel/i.test(String(data.error || ''));
      isDownloading = false;
      isCancellingDownload = false;
      chatDownload.style.display = 'none';
      chatDownloadFill.style.width = '0%';
      if (wasCancelled) {
        log('Model download cancelled', 'warn');
        if (statusText) statusText.textContent = 'Model download cancelled';
      } else {
        log(`Model download failed: ${data.error}`, 'error');
        if (statusText) statusText.textContent = `Download failed: ${data.error}`;
      }
      updateControls();
      break;
    }
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
    statusText.textContent = 'Chat engine unavailable';
    return;
  }
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name + (m.downloaded ? '  ✓' : '');
    modelSelect.appendChild(opt);
  });
  // Prefer a model that's already downloaded, else the backend default.
  const preferred = models.find(m => m.id === preferredModel);
  const downloaded = models.find(m => m.downloaded);
  selectedModel = (preferred && preferred.id) || (downloaded && downloaded.id) || defaultId || (models[0] && models[0].id) || '';
  modelSelect.value = selectedModel;
  updateModelStatus();
  updateControls();
  statusText.textContent = models.length > 0 ? 'Ready' : 'No chat models available';
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
  if (isDownloading) {
    if (isCancellingDownload || !ws || ws.readyState !== WebSocket.OPEN) return;
    isCancellingDownload = true;
    chatDownloadLabel.textContent = 'Cancelling download…';
    updateControls();
    try { ws.send(JSON.stringify({ action: 'cancel' })); }
    catch (err) {
      isCancellingDownload = false;
      updateControls();
      log(`Could not cancel model download: ${err.message}`, 'error');
    }
    return;
  }
  if (!selectedModel) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) { log('Not connected to backend', 'error'); return; }
  // Enter the pending state before sending. Waiting for download_start leaves
  // a double-click window that can enqueue two multi-gigabyte requests.
  isDownloading = true;
  isCancellingDownload = false;
  chatDownload.style.display = '';
  chatDownloadFill.style.width = '0%';
  chatDownloadLabel.textContent = 'Starting download…';
  updateControls();
  try {
    ws.send(JSON.stringify({ action: 'download', model: selectedModel }));
  } catch (err) {
    isDownloading = false;
    isCancellingDownload = false;
    chatDownload.style.display = 'none';
    chatDownloadFill.style.width = '0%';
    updateControls();
    log(`Could not start model download: ${err.message}`, 'error');
  }
}

// ---- Sending ----
function recentMessageWindow() {
  const retained = [];
  let chars = 0;
  for (let index = messages.length - 1; index >= 0 && retained.length < MAX_HISTORY_MESSAGES; index--) {
    const message = messages[index];
    if (!message || typeof message.content !== 'string') continue;
    if (chars + message.content.length > MAX_HISTORY_CHARS) break;
    retained.unshift(message);
    chars += message.content.length;
  }
  return retained;
}

function restorePendingUserTurn() {
  if (messages[messages.length - 1]?.role !== 'user') return;
  const text = messages.pop().content;
  if (!chatInput.value) chatInput.value = text;
  const assistantMessage = currentBubble?.closest('.chat-msg');
  assistantMessage?.previousElementSibling?.remove();
  autoGrow();
}

function send() {
  if (isGenerating) {           // acts as a Stop button mid-generation
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ action: 'cancel' })); }
      catch (err) { log(`Could not stop generation: ${err.message}`, 'error'); }
    }
    return;
  }
  const text = (chatInput.value || '').trim();
  if (!text) return;
  if (text.length > MAX_HISTORY_CHARS) {
    statusText.textContent = `Message is too long (maximum ${MAX_HISTORY_CHARS.toLocaleString()} characters)`;
    return;
  }
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
  try {
    ws.send(JSON.stringify({ action: 'chat', model: selectedModel, messages: recentMessageWindow(), style }));
  } catch (err) {
    restorePendingUserTurn();
    setBubbleText(currentBubble, `Could not start generation: ${err.message}`);
    currentBubble.classList.add('error');
    finishGeneration(true);
  }
}

function finishGeneration(failed = false) {
  if (!failed && currentBubble && streamingText) {
    messages.push({ role: 'assistant', content: streamingText });
    messages = messages.slice(-MAX_HISTORY_MESSAGES);
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
  const connected = !!ws && ws.readyState === WebSocket.OPEN;
  chatSendBtn.disabled = ((!engineAvailable || !selectedModel || !connected) && !isGenerating) || isDownloading;
  modelSelect.disabled = isGenerating || isDownloading;
  downloadModelBtn.disabled = !connected || isCancellingDownload;
  downloadModelBtn.textContent = isCancellingDownload
    ? 'Cancelling…'
    : (isDownloading ? 'Cancel download' : 'Download model');
  downloadModelBtn.classList.toggle('btn-cancel', isDownloading);
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

async function loadToolSettings() {
  try {
    const all = await window.loadAllSettings();
    const settings = all.chat || {};
    preferredModel = typeof settings.model === 'string' ? settings.model : '';
    if (['precise', 'balanced', 'creative'].includes(settings.style)) {
      styleSelect.value = settings.style;
    }
  } catch (err) {
    log(`Could not load chat settings: ${err.message}`, 'warn');
  }
}

function saveToolSettings() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    window.updateSettings(all => {
      all.chat = { model: selectedModel || preferredModel, style: styleSelect.value };
    }).catch(err => log(`Could not save chat settings: ${err.message}`, 'warn'));
  }, 250);
}

// ---- Events ----
function bindEvents() {
  chatSendBtn.addEventListener('click', send);
  chatClearBtn.addEventListener('click', clearChat);
  downloadModelBtn.addEventListener('click', downloadModel);

  modelSelect.addEventListener('change', () => {
    selectedModel = modelSelect.value;
    preferredModel = selectedModel;
    updateModelStatus();
    updateControls();
    saveToolSettings();
  });

  styleSelect.addEventListener('change', saveToolSettings);

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

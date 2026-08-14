// ============================================================================
// Local Chat Tool (WebSocket-based, local-only inference)
// ============================================================================

(function() {

let ws = null;
let getPythonPort = () => null;
let connectedPythonPort = null;
let pythonToken = null;
let log = null;
let clearLog = null;
let shouldReconnect = true;

let reconnectAttempts = 0;
let reconnectTimerId = null;
const MAX_RECONNECT_DELAY = 30000;

let models = [];
let hardware = null;
let selectedModel = '';
let preferredModel = '';
let engineAvailable = true;
let modelListLoaded = false;
let importPreviousModelIds = null;
let _saveTimer = null;

// Only completed user/assistant pairs enter model context. Failed and empty
// generations remain visible in the UI but can never create a dangling role.
let turns = []; // [{ user: string, assistant: string }]
let pendingTurn = null;
let isGenerating = false;
let isStopping = false;
let isDownloading = false;
let isCancellingDownload = false;
let isImporting = false;
let streamingText = '';
let isFollowingOutput = true;

const MAX_HISTORY_MESSAGES = 24;
const MAX_HISTORY_CHARS = 60000;
const MAX_MESSAGE_CHARS = 16000;
const MAX_RETAINED_TURNS = 20;
const copyFeedbackTimers = new Set();

let modelSelect, executionSelect, profileSelect, styleSelect, lengthSelect;
let modelStatus, modelQualityBadge, modelFitBadge, modelMeta, modelDescription, professionalMinimumNotice;
let hardwareSummary, hardwareBackend, hardwareGpu, hardwareMemory, hardwareCpu;
let downloadModelBtn, importModelBtn, chatDownload, chatDownloadLabel, chatDownloadProgress, chatDownloadFill;
let chatMessages, chatEmpty, chatJumpBtn, chatInput, chatCharCount;
let chatSendBtn, chatStopBtn, chatClearBtn, statusText;

async function init(ctx) {
  getPythonPort = typeof ctx.getPythonPort === 'function' ? ctx.getPythonPort : () => ctx.pythonPort;
  pythonToken = ctx.pythonToken;
  log = ctx.log;
  clearLog = ctx.clearLog;
  shouldReconnect = true;

  modelSelect = document.getElementById('modelSelect');
  executionSelect = document.getElementById('executionSelect');
  profileSelect = document.getElementById('profileSelect');
  styleSelect = document.getElementById('styleSelect');
  lengthSelect = document.getElementById('lengthSelect');
  modelStatus = document.getElementById('modelStatus');
  modelQualityBadge = document.getElementById('modelQualityBadge');
  modelFitBadge = document.getElementById('modelFitBadge');
  modelMeta = document.getElementById('modelMeta');
  modelDescription = document.getElementById('modelDescription');
  professionalMinimumNotice = document.getElementById('professionalMinimumNotice');
  hardwareSummary = document.getElementById('hardwareSummary');
  hardwareBackend = document.getElementById('hardwareBackend');
  hardwareGpu = document.getElementById('hardwareGpu');
  hardwareMemory = document.getElementById('hardwareMemory');
  hardwareCpu = document.getElementById('hardwareCpu');
  downloadModelBtn = document.getElementById('downloadModelBtn');
  importModelBtn = document.getElementById('importModelBtn');
  chatDownload = document.getElementById('chatDownload');
  chatDownloadLabel = document.getElementById('chatDownloadLabel');
  chatDownloadProgress = document.getElementById('chatDownloadProgress');
  chatDownloadFill = document.getElementById('chatDownloadFill');
  chatMessages = document.getElementById('chatMessages');
  chatEmpty = document.getElementById('chatEmpty');
  chatJumpBtn = document.getElementById('chatJumpBtn');
  chatInput = document.getElementById('chatInput');
  chatCharCount = document.getElementById('chatCharCount');
  chatSendBtn = document.getElementById('chatSendBtn');
  chatStopBtn = document.getElementById('chatStopBtn');
  chatClearBtn = document.getElementById('chatClearBtn');
  statusText = document.getElementById('statusText');

  await loadToolSettings();
  bindEvents();
  updateCharacterCount();
  updateControls();
  connectWebSocket();
}

function cleanup() {
  shouldReconnect = false;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (reconnectTimerId) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
  for (const timer of copyFeedbackTimers) clearTimeout(timer);
  copyFeedbackTimers.clear();
  if (ws) {
    const socket = ws;
    ws = null;
    socket.onclose = null;
    socket.close();
  }
  connectedPythonPort = null;
}

function deactivate() {
  if (!isSocketOpen()) return;
  try {
    ws.send(JSON.stringify({ action: 'unload' }));
  } catch (err) {
    log(`Could not release the local chat model: ${err.message}`, 'warn');
  }
}

// ---- WebSocket ----
function connectWebSocket() {
  const port = getPythonPort();
  if (!shouldReconnect || !Number.isInteger(port) || port < 1 || port > 65535) return;
  connectedPythonPort = port;
  modelListLoaded = false;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat/ws?token=${encodeURIComponent(pythonToken || '')}`);
  ws = socket;
  setStatus('Connecting to the local chat engine…');
  modelStatus.textContent = 'Connecting to the local engine…';
  updateControls();

  socket.onopen = () => {
    if (ws !== socket) return;
    reconnectAttempts = 0;
    reconnectTimerId = null;
    setStatus('Loading local models…');
    modelStatus.textContent = 'Reading models stored on this computer…';
    try {
      socket.send(JSON.stringify({ action: 'list_models' }));
    } catch (err) {
      setStatus(`Could not list local models: ${err.message}`);
    }
    updateControls();
  };

  socket.onmessage = (event) => {
    if (ws !== socket) return;
    let data;
    try { data = JSON.parse(event.data); }
    catch { return; }
    handleWSMessage(data);
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    connectedPythonPort = null;

    if (isDownloading) {
      isDownloading = false;
      isCancellingDownload = false;
      hideModelProgress();
      log('Model download interrupted by local backend disconnect', 'warn');
    }
    if (isImporting) {
      isImporting = false;
      importPreviousModelIds = null;
      hideModelProgress();
      log('Model import interrupted by local backend disconnect', 'warn');
    }
    if (isGenerating) {
      failCurrentTurn('The local chat engine disconnected before the reply finished.');
    }

    modelStatus.textContent = 'Local engine disconnected; reconnecting…';
    setStatus('Local engine disconnected — reconnecting…');
    updateControls();
    if (!shouldReconnect) return;

    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    reconnectTimerId = setTimeout(connectWebSocket, delay);
  };

  socket.onerror = () => {
    if (ws !== socket) return;
    setStatus('Local engine connection error');
  };
}

function onBackendStatus(status = {}) {
  const nextPort = status.port;
  if (status.state !== 'ready' || !Number.isInteger(nextPort) || nextPort === connectedPythonPort) return;
  if (reconnectTimerId) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
  if (ws) ws.close();
  else connectWebSocket();
}

function handleWSMessage(data) {
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

  switch (data.type) {
    case 'models': {
      const wasImporting = isImporting;
      const previousIds = importPreviousModelIds;
      models = Array.isArray(data.models) ? data.models.map(normalizeModel).filter(Boolean) : [];
      hardware = normalizeHardware(data.hardware);
      engineAvailable = data.engine !== false;
      modelListLoaded = true;

      if (wasImporting) {
        const selectedImport = typeof data.selected === 'string'
          ? models.find(model => model.id === data.selected)
          : null;
        const imported = selectedImport || (previousIds && models.find(model => !previousIds.has(model.id)));
        if (imported) {
          selectedModel = imported.id;
          preferredModel = imported.id;
        }
      }
      isImporting = false;
      importPreviousModelIds = null;
      hideModelProgress();
      populateModels(data.default);
      renderHardware();

      if (wasImporting) {
        setStatus('GGUF model imported — ready for local use');
        log('GGUF model imported successfully', 'success');
        saveToolSettings();
      }
      break;
    }

    case 'status': {
      if (typeof data.message !== 'string') return;
      if (pendingTurn) setPlainMessage(pendingTurn.assistant, `${data.message}…`);
      setStatus(data.message);
      break;
    }

    case 'start':
      if (pendingTurn) setPlainMessage(pendingTurn.assistant, '');
      streamingText = '';
      setStatus('Generating locally…');
      break;

    case 'token':
      if (!pendingTurn || typeof data.text !== 'string') return;
      streamingText += data.text;
      setPlainMessage(pendingTurn.assistant, streamingText);
      scrollToBottom();
      break;

    case 'done':
      completeGeneration(data.stats);
      break;

    case 'cancelled':
      completeCancellation();
      break;

    case 'context_trimmed': {
      const message = typeof data.message === 'string' && data.message.trim()
        ? data.message.trim()
        : 'Earlier turns were left out so this reply fits the model context.';
      addConversationNotice(message);
      setStatus(message);
      break;
    }

    case 'need_download':
      restorePendingTurnToComposer();
      resetGenerationState();
      setStatus('Install or import the selected model before sending');
      updateModelStatus();
      updateControls();
      break;

    case 'error': {
      const error = normalizeError(data.error, 'The local model could not generate a reply.');
      if (isGenerating && pendingTurn) failCurrentTurn(error);
      else addConversationNotice(`Local chat error: ${error}`, true);
      log(`Chat error: ${error}`, 'error');
      break;
    }

    case 'download_start':
      isDownloading = true;
      isCancellingDownload = false;
      showModelProgress('Starting the explicit model download…', 0);
      updateControls();
      break;

    case 'download_progress': {
      const progress = Math.max(0, Math.min(1, Number(data.progress) || 0));
      const pct = Math.round(progress * 100);
      const mb = value => `${(Math.max(0, Number(value) || 0) / (1024 * 1024)).toFixed(0)} MB`;
      const label = Number(data.total) > 0
        ? `Downloading model — ${mb(data.downloaded)} / ${mb(data.total)} (${pct}%)`
        : `Downloading model — ${mb(data.downloaded)}`;
      showModelProgress(label, Number(data.total) > 0 ? pct : null);
      break;
    }

    case 'download_complete':
      isDownloading = false;
      isCancellingDownload = false;
      hideModelProgress();
      markDownloaded(data.model, true);
      updateModelStatus();
      updateControls();
      setStatus('Model installed — prompts and replies remain local');
      log('Model downloaded — ready for private local chat', 'success');
      break;

    case 'download_error': {
      const error = normalizeError(data.error, 'The model download failed.');
      const wasCancelled = isCancellingDownload || /cancel/i.test(error);
      isDownloading = false;
      isCancellingDownload = false;
      hideModelProgress();
      setStatus(wasCancelled ? 'Model download cancelled' : `Download failed: ${error}`);
      log(wasCancelled ? 'Model download cancelled' : `Model download failed: ${error}`, wasCancelled ? 'warn' : 'error');
      updateModelStatus();
      updateControls();
      break;
    }

    case 'import_error': {
      const error = normalizeError(data.error, 'The GGUF model could not be imported.');
      isImporting = false;
      importPreviousModelIds = null;
      hideModelProgress();
      setStatus(`Import failed: ${error}`);
      log(`GGUF import failed: ${error}`, 'error');
      updateModelStatus();
      updateControls();
      break;
    }

    case 'unloaded':
      setStatus('Local model released from memory · it will reload with the next reply');
      break;
  }
}

function normalizeError(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.trim().slice(0, 1200);
}

// ---- Models and hardware ----
const TIER_LABELS = {
  recommended: 'Hardware: good fit',
  possible: 'Hardware: may be slower',
  'not-recommended': 'Hardware: may exceed memory',
  other: 'Hardware fit unknown',
};

const QUALITY_ORDER = ['recommended', 'expert', 'advanced', 'standard', 'unverified'];

const QUALITY_LABELS = {
  recommended: 'Quality: professional default',
  expert: 'Quality: expert',
  advanced: 'Quality: advanced',
  standard: 'Quality: professional minimum',
  unverified: 'Quality: unverified',
};

const QUALITY_OPTION_LABELS = {
  recommended: 'Professional default',
  expert: 'Expert quality',
  advanced: 'Advanced quality',
  standard: 'Professional minimum',
  unverified: 'Quality unverified',
};

const QUALITY_GROUP_LABELS = {
  recommended: 'Recommended professional models',
  expert: 'Expert models',
  advanced: 'Advanced models',
  standard: 'Professional minimum',
  unverified: 'Imported models - quality unverified',
};

function normalizeModel(model) {
  if (!model || typeof model !== 'object' || typeof model.id !== 'string' || typeof model.name !== 'string') {
    return null;
  }
  const size = Number(model.approx_mb);
  const rank = Number(model.quality_rank);
  const source = typeof model.source === 'string' ? model.source : '';
  const imported = isImportedModelSource(source);
  const fit = typeof model.fit === 'string' ? model.fit : model.tier;
  const quality = ['standard', 'recommended', 'advanced', 'expert', 'unverified'].includes(model.quality_tier)
    ? model.quality_tier
    : 'unverified';
  return {
    id: model.id,
    name: model.name,
    approx_mb: Number.isFinite(size) && size >= 0 ? size : null,
    downloaded: model.downloaded === true,
    tier: ['recommended', 'possible', 'not-recommended'].includes(fit) ? fit : 'other',
    quality_tier: imported ? 'unverified' : quality,
    quality_rank: Number.isFinite(rank) ? rank : null,
    source,
    can_download: model.can_download !== false,
    description: typeof model.description === 'string' ? model.description.trim() : '',
  };
}

function isImportedModelSource(source) {
  const normalized = String(source || '').trim().toLowerCase();
  return normalized === 'local' || normalized.includes('import');
}

function normalizeHardware(value) {
  if (typeof value === 'string') return { summary: value };
  if (!value || typeof value !== 'object') return null;
  const numberOrNull = input => {
    const number = Number(input);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  return {
    summary: typeof value.summary === 'string' ? value.summary : '',
    backend: typeof value.backend === 'string' ? value.backend : '',
    gpu_name: typeof value.gpu_name === 'string' ? value.gpu_name : '',
    vram_mb: numberOrNull(value.vram_mb),
    ram_mb: numberOrNull(value.ram_mb),
    cpu_cores: numberOrNull(value.cpu_cores),
    gpu_available: value.gpu_available === true,
  };
}

function optionLabel(model) {
  const fit = model.tier === 'recommended'
    ? 'Good hardware fit'
    : model.tier === 'possible'
      ? 'May run slowly'
      : model.tier === 'not-recommended' ? 'May exceed memory' : 'Hardware fit unknown';
  const quality = QUALITY_OPTION_LABELS[model.quality_tier] || 'Quality unverified';
  return [model.name, quality, fit, model.downloaded ? 'Installed' : ''].filter(Boolean).join(' · ');
}

function compareModelQuality(a, b) {
  if (Number.isFinite(a.quality_rank) && Number.isFinite(b.quality_rank) && a.quality_rank !== b.quality_rank) {
    return b.quality_rank - a.quality_rank;
  }
  if (Number.isFinite(a.quality_rank) !== Number.isFinite(b.quality_rank)) {
    return Number.isFinite(a.quality_rank) ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

function updateProfessionalMinimumNotice() {
  if (!professionalMinimumNotice) return;
  const hasProfessionalFit = models.some(model =>
    model.quality_tier !== 'unverified' && model.tier === 'recommended');
  professionalMinimumNotice.hidden = !engineAvailable || !modelListLoaded || models.length === 0 || hasProfessionalFit;
}

function populateModels(defaultId) {
  modelSelect.replaceChildren();

  if (!engineAvailable) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Local chat engine unavailable';
    modelSelect.appendChild(option);
    selectedModel = '';
    updateProfessionalMinimumNotice();
    updateModelStatus();
    updateControls();
    setStatus('Local chat engine unavailable');
    return;
  }

  if (models.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No models found — import a GGUF model';
    modelSelect.appendChild(option);
    selectedModel = '';
    updateProfessionalMinimumNotice();
    updateModelStatus();
    updateControls();
    setStatus('Import a GGUF model to begin');
    return;
  }

  for (const quality of QUALITY_ORDER) {
    const matching = models.filter(model => model.quality_tier === quality).sort(compareModelQuality);
    if (matching.length === 0) continue;
    const group = document.createElement('optgroup');
    group.label = QUALITY_GROUP_LABELS[quality];
    for (const model of matching) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = optionLabel(model);
      group.appendChild(option);
    }
    modelSelect.appendChild(group);
  }

  const current = models.find(model => model.id === selectedModel);
  const preferred = models.find(model => model.id === preferredModel);
  const downloaded = models.find(model => model.downloaded && model.tier === 'recommended')
    || models.find(model => model.downloaded);
  const backendDefault = models.find(model => model.id === defaultId);
  selectedModel = (current || preferred || downloaded || backendDefault || models[0]).id;
  preferredModel = selectedModel;
  modelSelect.value = selectedModel;
  updateProfessionalMinimumNotice();
  updateModelStatus();
  updateControls();
}

function currentModel() {
  return models.find(model => model.id === selectedModel) || null;
}

function markDownloaded(modelId, value) {
  const model = models.find(item => item.id === modelId);
  if (model) model.downloaded = value;
  for (const option of Array.from(modelSelect.options)) {
    const matching = models.find(item => item.id === option.value);
    if (matching) option.textContent = optionLabel(matching);
  }
}

function updateModelStatus() {
  const model = currentModel();
  downloadModelBtn.hidden = true;

  if (!engineAvailable) {
    modelStatus.textContent = 'The local chat engine is not installed in this build.';
    renderModelDetails(null, 'Engine unavailable');
    return;
  }
  if (!model) {
    modelStatus.textContent = 'Import a local GGUF model to get started.';
    renderModelDetails(null, 'No model selected');
    return;
  }

  renderModelDetails(model);
  if (model.downloaded) {
    modelStatus.textContent = 'Installed and ready · inference stays on this computer';
  } else if (model.can_download) {
    modelStatus.textContent = `Not installed · ${formatModelSize(model.approx_mb)} · download only starts when you click`;
    downloadModelBtn.hidden = false;
  } else {
    modelStatus.textContent = 'Model file not found · import its GGUF file to use it locally';
  }

  if (isDownloading) downloadModelBtn.hidden = false;
}

function renderModelDetails(model, fallback) {
  modelQualityBadge.className = 'chat-quality-badge neutral';
  modelFitBadge.className = 'chat-fit-badge neutral';
  modelQualityBadge.removeAttribute('title');
  modelFitBadge.removeAttribute('title');
  if (!model) {
    modelQualityBadge.textContent = 'Quality unavailable';
    modelFitBadge.textContent = fallback || 'No model';
    modelMeta.textContent = '';
    modelDescription.textContent = 'Choose or import a GGUF model to see its local resource requirements.';
    return;
  }

  modelQualityBadge.className = `chat-quality-badge quality-${model.quality_tier}`;
  modelQualityBadge.textContent = QUALITY_LABELS[model.quality_tier] || QUALITY_LABELS.unverified;
  modelQualityBadge.title = model.quality_tier === 'unverified'
    ? 'Imported GGUF models have not been evaluated by MuxMelt.'
    : 'Quality categories are relative guidance, not a guarantee for every answer.';
  modelFitBadge.className = `chat-fit-badge ${model.tier}`;
  modelFitBadge.textContent = TIER_LABELS[model.tier] || TIER_LABELS.other;
  modelFitBadge.title = 'Estimated from detected memory, processor, graphics hardware, and model size.';
  const source = describeModelSource(model.source);
  modelMeta.textContent = [formatModelSize(model.approx_mb), model.downloaded ? 'Installed' : 'Not installed', source]
    .filter(Boolean).join(' · ');
  if (model.quality_tier === 'unverified') {
    modelDescription.textContent = 'This imported model has not been quality-evaluated by MuxMelt. Hardware fit is estimated from its file size.';
  } else {
    modelDescription.textContent = model.description
      || (model.tier === 'recommended'
        ? 'This quality category should fit comfortably on the detected hardware.'
        : model.tier === 'possible'
          ? 'This model meets a built-in quality category, but replies may take longer on this computer.'
          : 'This model meets a built-in quality category, but may use more memory than this computer has available.');
  }
}

function describeModelSource(source) {
  const normalized = String(source || '').toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('import') || normalized.includes('local')) return 'Local GGUF';
  if (normalized.includes('catalog') || normalized.includes('remote') || /^https?:/.test(normalized)) return 'Model catalog';
  return source.slice(0, 60);
}

function formatModelSize(megabytes) {
  if (!Number.isFinite(megabytes)) return 'Size unknown';
  if (megabytes >= 1000) {
    const digits = megabytes >= 10000 ? 0 : 1;
    return `${(megabytes / 1000).toFixed(digits)} GB`;
  }
  return `${Math.round(megabytes)} MB`;
}

function renderHardware() {
  if (!hardware) {
    hardwareSummary.textContent = 'Hardware details unavailable';
    hardwareBackend.textContent = '-';
    hardwareGpu.textContent = '-';
    hardwareMemory.textContent = '-';
    hardwareCpu.textContent = '-';
    return;
  }

  const gpuLabel = hardware.gpu_name
    ? `${hardware.gpu_name}${Number.isFinite(hardware.vram_mb) && hardware.vram_mb > 0 ? ` · ${formatBinaryMemory(hardware.vram_mb)} VRAM` : ''}`
    : hardware.gpu_available ? 'GPU available' : 'No compatible GPU detected';
  const fallbackSummary = hardware.gpu_available
    ? `GPU acceleration · ${hardware.gpu_name || 'available'}`
    : 'CPU inference available';

  hardwareSummary.textContent = hardware.summary || fallbackSummary;
  hardwareBackend.textContent = hardware.backend ? hardware.backend.toUpperCase() : 'Automatic';
  hardwareGpu.textContent = gpuLabel;
  hardwareMemory.textContent = Number.isFinite(hardware.ram_mb) && hardware.ram_mb > 0
    ? `${formatBinaryMemory(hardware.ram_mb)} system RAM`
    : 'Unknown';
  hardwareCpu.textContent = Number.isFinite(hardware.cpu_cores) && hardware.cpu_cores > 0
    ? `${Math.round(hardware.cpu_cores)} logical cores detected`
    : 'CPU available';

  const gpuOption = executionSelect.querySelector('option[value="gpu"]');
  if (gpuOption) gpuOption.textContent = hardware.gpu_available ? 'GPU only' : 'GPU only (not detected)';
}

function formatBinaryMemory(megabytes) {
  const gib = megabytes / 1024;
  return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GB`;
}

function promptDownload() {
  const model = currentModel();
  if (model && !model.downloaded && model.can_download) downloadModelBtn.hidden = false;
}

function showModelProgress(label, percent) {
  chatDownload.hidden = false;
  chatDownloadLabel.textContent = label;
  const determinate = Number.isFinite(percent);
  chatDownloadProgress.classList.toggle('indeterminate', !determinate);
  if (determinate) {
    const bounded = Math.max(0, Math.min(100, Math.round(percent)));
    chatDownloadProgress.setAttribute('aria-valuenow', String(bounded));
    chatDownloadProgress.setAttribute('aria-valuetext', `${bounded}%`);
    chatDownloadFill.style.width = `${bounded}%`;
  } else {
    chatDownloadProgress.removeAttribute('aria-valuenow');
    chatDownloadProgress.setAttribute('aria-valuetext', label);
    chatDownloadFill.style.width = '35%';
  }
}

function hideModelProgress() {
  chatDownload.hidden = true;
  chatDownloadProgress.classList.remove('indeterminate');
  chatDownloadProgress.setAttribute('aria-valuenow', '0');
  chatDownloadProgress.setAttribute('aria-valuetext', 'Not downloading');
  chatDownloadFill.style.width = '0%';
}

function downloadModel() {
  if (isDownloading) {
    if (isCancellingDownload || !isSocketOpen()) return;
    isCancellingDownload = true;
    showModelProgress('Cancelling model download…', null);
    updateControls();
    try { ws.send(JSON.stringify({ action: 'cancel' })); }
    catch (err) {
      isCancellingDownload = false;
      setStatus(`Could not cancel download: ${err.message}`);
      updateControls();
    }
    return;
  }

  const model = currentModel();
  if (!model || model.downloaded || !model.can_download) return;
  if (!isSocketOpen()) {
    setStatus('The local engine is not connected');
    return;
  }

  isDownloading = true;
  isCancellingDownload = false;
  showModelProgress('Starting the explicit model download…', 0);
  updateModelStatus();
  updateControls();
  try {
    ws.send(JSON.stringify({ action: 'download', model: selectedModel }));
  } catch (err) {
    isDownloading = false;
    hideModelProgress();
    setStatus(`Could not start model download: ${err.message}`);
    updateModelStatus();
    updateControls();
  }
}

async function importModel() {
  if (isGenerating || isDownloading || isImporting) return;
  if (!isSocketOpen()) {
    setStatus('The local engine must be connected before importing a model');
    return;
  }

  let selected;
  try {
    selected = await window.api.system.selectFiles({
      properties: ['openFile'],
      filters: [{ name: 'GGUF models', extensions: ['gguf'] }],
    });
  } catch (err) {
    setStatus(`Could not open the model picker: ${err.message}`);
    return;
  }

  const filePath = Array.isArray(selected) ? selected[0] : '';
  if (!filePath) return;
  if (!/\.gguf$/i.test(filePath)) {
    setStatus('Choose a model file ending in .gguf');
    return;
  }

  isImporting = true;
  importPreviousModelIds = new Set(models.map(model => model.id));
  showModelProgress('Registering local GGUF model… Keep the file in its current location.', null);
  setStatus('Registering a local GGUF model…');
  updateControls();
  try {
    ws.send(JSON.stringify({ action: 'import_model', path: filePath }));
  } catch (err) {
    isImporting = false;
    importPreviousModelIds = null;
    hideModelProgress();
    setStatus(`Could not start model import: ${err.message}`);
    updateControls();
  }
}

// ---- Sending and context ----
function recentMessageWindow(pendingUserText) {
  const retained = [{ role: 'user', content: pendingUserText }];
  let chars = pendingUserText.length;

  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (!turn || typeof turn.user !== 'string' || typeof turn.assistant !== 'string') continue;
    const turnChars = turn.user.length + turn.assistant.length;
    if (retained.length + 2 > MAX_HISTORY_MESSAGES || chars + turnChars > MAX_HISTORY_CHARS) break;
    retained.unshift(
      { role: 'user', content: turn.user },
      { role: 'assistant', content: turn.assistant },
    );
    chars += turnChars;
  }
  return retained;
}

function send() {
  if (isGenerating || isDownloading || isImporting) return;
  const text = (chatInput.value || '').trim();
  if (!text) return;
  if (text.length > MAX_MESSAGE_CHARS) {
    setStatus(`Message is too long (maximum ${MAX_MESSAGE_CHARS.toLocaleString()} characters)`);
    return;
  }
  if (!engineAvailable) {
    setStatus('The local chat engine is unavailable');
    return;
  }
  if (!isSocketOpen()) {
    setStatus('The local chat engine is not connected');
    return;
  }

  const model = currentModel();
  if (!model) {
    setStatus('Choose or import a local model first');
    return;
  }
  if (!model.downloaded) {
    promptDownload();
    setStatus(model.can_download ? 'Download or import the selected model first' : 'Import the selected GGUF model first');
    return;
  }

  isFollowingOutput = true;
  chatJumpBtn.hidden = true;
  const userMessage = addMessageEl('user', text);
  const assistantMessage = addMessageEl('assistant', 'Thinking…');
  pendingTurn = { text, user: userMessage, assistant: assistantMessage };
  streamingText = '';
  isGenerating = true;
  isStopping = false;
  chatInput.value = '';
  autoGrow();
  updateCharacterCount();
  updateControls();
  scrollToBottom(true);

  const payload = {
    action: 'chat',
    model: selectedModel,
    messages: recentMessageWindow(text),
    style: styleSelect.value,
    execution: executionSelect.value,
    profile: profileSelect.value,
    length: lengthSelect.value,
  };

  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    failCurrentTurn(`The reply could not be started: ${err.message}`);
  }
}

function stopGeneration() {
  if (!isGenerating || isStopping) return;
  if (!isSocketOpen()) {
    failCurrentTurn('The local engine disconnected before it could stop cleanly.');
    return;
  }
  isStopping = true;
  setStatus('Stopping generation…');
  updateControls();
  try { ws.send(JSON.stringify({ action: 'cancel' })); }
  catch (err) { failCurrentTurn(`Could not stop generation: ${err.message}`); }
}

function completeGeneration(stats) {
  if (!pendingTurn) {
    resetGenerationState();
    return;
  }
  if (!streamingText) {
    failCurrentTurn('The model returned an empty response.');
    return;
  }

  const generation = describeGenerationStats(stats);
  if (generation.limitReached) pendingTurn.assistant.bubble.classList.add('partial');
  finalizeAssistantMessage(pendingTurn.assistant, streamingText, {
    copy: true,
    meta: generation.meta,
  });
  commitPendingTurn();
  setStatus(generation.status);
  resetGenerationState();
  scrollToBottom();
}

function completeCancellation() {
  if (!pendingTurn) {
    resetGenerationState();
    setStatus('Stopped');
    return;
  }

  if (streamingText) {
    pendingTurn.assistant.bubble.classList.add('partial');
    finalizeAssistantMessage(pendingTurn.assistant, streamingText, {
      copy: true,
      meta: 'Stopped · partial reply kept locally',
    });
    commitPendingTurn();
    setStatus('Stopped · partial reply kept');
  } else {
    const retryText = pendingTurn.text;
    const userWrap = pendingTurn.user.wrap;
    const assistantWrap = pendingTurn.assistant.wrap;
    finalizeAssistantMessage(pendingTurn.assistant, 'Generation stopped before a reply was produced.', {
      retry: () => retryFailedTurn(retryText, userWrap, assistantWrap),
      meta: 'Stopped',
    });
    pendingTurn = null;
    setStatus('Stopped before a reply was produced');
  }
  resetGenerationState();
}

function failCurrentTurn(message) {
  if (!pendingTurn) {
    resetGenerationState();
    addConversationNotice(message, true);
    setStatus(message);
    return;
  }

  const retryText = pendingTurn.text;
  const userWrap = pendingTurn.user.wrap;
  const assistantWrap = pendingTurn.assistant.wrap;
  pendingTurn.assistant.bubble.classList.add('error');
  finalizeAssistantMessage(pendingTurn.assistant, message, {
    retry: () => retryFailedTurn(retryText, userWrap, assistantWrap),
    meta: 'Reply not added to conversation context',
  });
  pendingTurn = null;
  resetGenerationState();
  setStatus(message);
}

function restorePendingTurnToComposer() {
  if (!pendingTurn) return;
  const text = pendingTurn.text;
  pendingTurn.user.wrap.remove();
  pendingTurn.assistant.wrap.remove();
  if (!chatInput.value) chatInput.value = text;
  pendingTurn = null;
  autoGrow();
  updateCharacterCount();
  restoreEmptyStateIfNeeded();
}

function retryFailedTurn(text, userWrap, assistantWrap) {
  if (isGenerating || isDownloading || isImporting) return;
  userWrap.remove();
  assistantWrap.remove();
  chatInput.value = text;
  autoGrow();
  updateCharacterCount();
  restoreEmptyStateIfNeeded();
  send();
}

function commitPendingTurn() {
  if (!pendingTurn || !streamingText) return;
  turns.push({ user: pendingTurn.text, assistant: streamingText });
  if (turns.length > MAX_RETAINED_TURNS) turns = turns.slice(-MAX_RETAINED_TURNS);
  pendingTurn = null;
}

function resetGenerationState() {
  pendingTurn = null;
  streamingText = '';
  isGenerating = false;
  isStopping = false;
  updateControls();
  if (!chatInput.disabled && (!window.isToolActive || window.isToolActive('chat'))) chatInput.focus();
}

function formatElapsed(stats) {
  const seconds = Number(stats && stats.elapsed_seconds);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 1) return `${Math.max(0.1, seconds).toFixed(1)}s`;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

function describeGenerationStats(stats) {
  const elapsed = formatElapsed(stats);
  const tokensPerSecond = Number(stats && stats.tokens_per_second);
  const speed = Number.isFinite(tokensPerSecond) && tokensPerSecond > 0
    ? `${tokensPerSecond < 10 ? tokensPerSecond.toFixed(1) : Math.round(tokensPerSecond)} tok/s`
    : '';
  const limitReached = !!(stats && stats.finish_reason === 'length');
  const details = [
    limitReached ? 'Response limit reached' : 'Generated locally',
    elapsed ? `in ${elapsed}` : '',
    speed,
  ].filter(Boolean);
  return {
    limitReached,
    meta: details.join(' · '),
    status: limitReached
      ? 'Response limit reached · ask the assistant to continue if needed'
      : (elapsed ? `Ready · generated locally in ${elapsed}` : 'Ready · generated locally'),
  };
}

function isSocketOpen() {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

function updateControls() {
  const connected = isSocketOpen();
  const model = currentModel();
  const operationBusy = isGenerating || isDownloading || isImporting;

  chatSendBtn.disabled = operationBusy || !connected || !engineAvailable || !model || !model.downloaded;
  chatStopBtn.hidden = !isGenerating;
  chatStopBtn.disabled = !connected || isStopping;
  chatStopBtn.textContent = isStopping ? 'Stopping…' : 'Stop';
  chatInput.disabled = isGenerating;
  chatClearBtn.disabled = isGenerating;

  for (const control of [modelSelect, executionSelect, profileSelect, styleSelect, lengthSelect]) {
    control.disabled = operationBusy;
  }

  importModelBtn.disabled = operationBusy || !connected || !engineAvailable || !modelListLoaded;
  importModelBtn.textContent = isImporting ? 'Importing…' : 'Import GGUF';
  downloadModelBtn.disabled = !connected || isCancellingDownload || isImporting || isGenerating;
  downloadModelBtn.textContent = isCancellingDownload
    ? 'Cancelling…'
    : (isDownloading ? 'Cancel download' : 'Download model');
  downloadModelBtn.classList.toggle('btn-cancel', isDownloading);
  if (isDownloading) downloadModelBtn.hidden = false;
}

// ---- Safe rendering ----
function addMessageEl(role, text, isError = false) {
  hideEmptyState();
  const wrap = document.createElement('div');
  wrap.className = `chat-msg ${role}`;
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', role === 'user' ? 'You' : 'Local assistant');

  const stack = document.createElement('div');
  stack.className = 'chat-msg-stack';
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble${isError ? ' error' : ''}`;
  bubble.textContent = text;

  const footer = document.createElement('div');
  footer.className = 'chat-message-footer';
  footer.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'chat-message-actions';
  const meta = document.createElement('span');
  meta.className = 'chat-message-meta';
  footer.append(actions, meta);
  stack.append(bubble, footer);
  wrap.appendChild(stack);
  chatMessages.appendChild(wrap);

  const message = { role, wrap, bubble, footer, actions, meta, rawText: text };
  scrollToBottom();
  return message;
}

function setPlainMessage(message, text) {
  if (!message) return;
  message.rawText = text;
  if (message.bubble.childNodes.length === 1 && message.bubble.firstChild.nodeType === Node.TEXT_NODE) {
    message.bubble.firstChild.nodeValue = text;
  } else {
    message.bubble.replaceChildren(document.createTextNode(text));
  }
  message.actions.replaceChildren();
  message.meta.textContent = '';
  message.footer.hidden = true;
}

function finalizeAssistantMessage(message, text, options = {}) {
  if (!message) return;
  message.rawText = text;
  renderSafeRichText(message.bubble, text);
  message.actions.replaceChildren();
  message.meta.textContent = options.meta || '';

  if (options.copy) {
    const copyButton = makeMessageAction('Copy response', () => copyWithFeedback(text, copyButton));
    message.actions.appendChild(copyButton);
  }
  if (typeof options.retry === 'function') {
    message.actions.appendChild(makeMessageAction('Retry', options.retry));
  }
  message.footer.hidden = message.actions.childElementCount === 0 && !message.meta.textContent;
}

// Fenced code gets a local presentation and copy button. Every character is
// still assigned through textContent/createTextNode; model output is never HTML.
function renderSafeRichText(container, text) {
  container.replaceChildren();
  const fence = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;
  let cursor = 0;
  let match;

  while ((match = fence.exec(text)) !== null) {
    appendTextSegment(container, text.slice(cursor, match.index));
    const language = match[1].trim().slice(0, 40) || 'Code';
    const codeText = match[2];

    const block = document.createElement('div');
    block.className = 'chat-code-block';
    const header = document.createElement('div');
    header.className = 'chat-code-header';
    const label = document.createElement('span');
    label.textContent = language;
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'chat-code-copy';
    copyButton.textContent = 'Copy code';
    copyButton.addEventListener('click', () => copyWithFeedback(codeText, copyButton));
    header.append(label, copyButton);

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = codeText;
    pre.appendChild(code);
    block.append(header, pre);
    container.appendChild(block);
    cursor = fence.lastIndex;
  }
  appendTextSegment(container, text.slice(cursor));
}

function appendTextSegment(container, text) {
  if (!text) return;
  const span = document.createElement('span');
  span.className = 'chat-text-segment';
  span.textContent = text;
  container.appendChild(span);
}

function makeMessageAction(label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-message-action';
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

async function copyWithFeedback(text, button) {
  const original = button.textContent;
  try {
    await writeClipboard(text);
    button.textContent = 'Copied';
  } catch (err) {
    button.textContent = 'Copy failed';
    log(`Could not copy chat text: ${err.message}`, 'warn');
  }

  const timer = setTimeout(() => {
    copyFeedbackTimers.delete(timer);
    if (button.isConnected) button.textContent = original;
  }, 1600);
  copyFeedbackTimers.add(timer);
}

async function writeClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('Clipboard access is unavailable');
}

function addConversationNotice(text, isError = false) {
  hideEmptyState();
  const notice = document.createElement('div');
  notice.className = `chat-notice${isError ? ' error' : ''}`;
  notice.setAttribute('role', 'status');
  notice.textContent = text;
  chatMessages.appendChild(notice);
  scrollToBottom();
}

function hideEmptyState() {
  if (chatEmpty) chatEmpty.hidden = true;
}

function restoreEmptyStateIfNeeded() {
  if (!chatEmpty) return;
  const hasMessages = Array.from(chatMessages.children).some(child => child !== chatEmpty);
  chatEmpty.hidden = hasMessages;
}

function renderEmptyState() {
  const empty = document.createElement('div');
  empty.className = 'chat-empty';
  empty.id = 'chatEmpty';
  const heading = document.createElement('strong');
  heading.textContent = 'Start a private conversation';
  const detail = document.createElement('span');
  detail.textContent = 'Choose a model that fits this computer, then ask anything.';
  empty.append(heading, detail);
  chatMessages.replaceChildren(empty);
  chatEmpty = empty;
}

function isNearBottom() {
  return chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight <= 72;
}

function scrollToBottom(force = false) {
  if (!force && !isFollowingOutput) {
    chatJumpBtn.hidden = false;
    return;
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
  isFollowingOutput = true;
  chatJumpBtn.hidden = true;
}

function clearChat() {
  if (isGenerating) return;
  turns = [];
  pendingTurn = null;
  renderEmptyState();
  isFollowingOutput = true;
  chatJumpBtn.hidden = true;
  setStatus('Local Chat · conversation cleared from memory');
  if (typeof clearLog === 'function') clearLog();
}

function autoGrow() {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 160)}px`;
}

function updateCharacterCount() {
  const length = (chatInput.value || '').length;
  chatCharCount.textContent = `${length.toLocaleString()} / ${MAX_MESSAGE_CHARS.toLocaleString()}`;
  chatCharCount.classList.toggle('near-limit', length >= MAX_MESSAGE_CHARS * 0.9);
}

function setStatus(message) {
  if (statusText) statusText.textContent = message;
}

// ---- Settings ----
function setSelectValue(select, value, allowed, fallback) {
  select.value = allowed.includes(value) ? value : fallback;
}

async function loadToolSettings() {
  try {
    const all = await window.loadAllSettings();
    const settings = all.chat && typeof all.chat === 'object' && !Array.isArray(all.chat) ? all.chat : {};
    preferredModel = typeof settings.model === 'string' ? settings.model : '';
    setSelectValue(styleSelect, settings.style, ['precise', 'balanced', 'creative'], 'balanced');
    setSelectValue(executionSelect, settings.execution, ['auto', 'gpu', 'cpu'], 'auto');
    setSelectValue(profileSelect, settings.profile, ['auto', 'eco', 'balanced', 'performance'], 'auto');
    setSelectValue(lengthSelect, settings.length, ['concise', 'standard', 'detailed'], 'standard');
  } catch (err) {
    log(`Could not load chat settings: ${err.message}`, 'warn');
  }
}

function saveToolSettings() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    window.updateSettings(all => {
      const existing = all.chat && typeof all.chat === 'object' && !Array.isArray(all.chat) ? all.chat : {};
      all.chat = {
        ...existing,
        model: selectedModel || preferredModel,
        style: styleSelect.value,
        execution: executionSelect.value,
        profile: profileSelect.value,
        length: lengthSelect.value,
      };
    }).catch(err => log(`Could not save chat settings: ${err.message}`, 'warn'));
  }, 250);
}

// ---- Events ----
function bindEvents() {
  chatSendBtn.addEventListener('click', send);
  chatStopBtn.addEventListener('click', stopGeneration);
  chatClearBtn.addEventListener('click', clearChat);
  downloadModelBtn.addEventListener('click', downloadModel);
  importModelBtn.addEventListener('click', importModel);

  modelSelect.addEventListener('change', () => {
    selectedModel = modelSelect.value;
    preferredModel = selectedModel;
    updateModelStatus();
    updateControls();
    saveToolSettings();
  });

  for (const select of [styleSelect, executionSelect, profileSelect, lengthSelect]) {
    select.addEventListener('change', saveToolSettings);
  }

  chatInput.addEventListener('input', () => {
    autoGrow();
    updateCharacterCount();
  });
  chatInput.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!isGenerating) send();
    }
  });

  chatMessages.addEventListener('scroll', () => {
    isFollowingOutput = isNearBottom();
    chatJumpBtn.hidden = isFollowingOutput;
  }, { passive: true });
  chatJumpBtn.addEventListener('click', () => {
    isFollowingOutput = true;
    chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
    chatJumpBtn.hidden = true;
  });
}

window.registerTool('chat', { init, cleanup, deactivate, onBackendStatus });

})();

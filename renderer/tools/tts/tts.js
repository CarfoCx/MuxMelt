// ============================================================================
// Text-to-Speech Tool (WebSocket-based)
// ============================================================================

(function() {

let outputDir = '';
let isProcessing = false;
let ws = null;
let pythonPort = null;
let log = null;

let reconnectDelay = 1000;
let reconnectAttempts = 0;
let reconnectTimerId = null;
const MAX_RECONNECT_DELAY = 30000;

let ttsText, voiceSelect, speedSlider, speedValue, outputFormat;
let outputDirBtn, generateBtn, clearBtn, statusText, processingIndicator;
let resultArea, charCount, openOutputBtn;

function init(ctx) {
  pythonPort = ctx.pythonPort;
  log = ctx.log;

  ttsText = document.getElementById('ttsText');
  voiceSelect = document.getElementById('voiceSelect');
  speedSlider = document.getElementById('speedSlider');
  speedValue = document.getElementById('speedValue');
  outputFormat = document.getElementById('outputFormat');
  outputDirBtn = document.getElementById('outputDirBtn');
  generateBtn = document.getElementById('generateBtn');
  clearBtn = document.getElementById('clearBtn');
  statusText = document.getElementById('statusText');
  processingIndicator = document.getElementById('processingIndicator');
  resultArea = document.getElementById('resultArea');
  charCount = document.getElementById('charCount');
  openOutputBtn = document.getElementById('openOutputBtn');

  bindEvents();
  connectWebSocket(pythonPort);
  log('Text-to-Speech ready');
}

function cleanup() {
  if (reconnectTimerId) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

// ---- WebSocket ----
function connectWebSocket(port) {
  ws = new WebSocket(`ws://127.0.0.1:${port}/tts/ws`);
  ws.onopen = () => {
    reconnectDelay = 1000; reconnectAttempts = 0;
    if (statusText) statusText.textContent = 'Connected to backend';
    log('WebSocket connected', 'success');
    // Request voice list
    ws.send(JSON.stringify({ action: 'list_voices' }));
  };
  ws.onmessage = (event) => handleWSMessage(JSON.parse(event.data));
  ws.onclose = () => {
    if (!statusText) return;
    statusText.textContent = 'Disconnected - reconnecting...';
    reconnectAttempts++;
    const delay = Math.min(reconnectDelay * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    log(`WebSocket disconnected, reconnecting in ${(delay / 1000).toFixed(1)}s...`, 'warn');
    reconnectTimerId = setTimeout(() => connectWebSocket(port), delay);
  };
  ws.onerror = () => { if (statusText) statusText.textContent = 'Connection error'; };
}

function handleWSMessage(data) {
  switch (data.type) {
    case 'voices':
      populateVoices(data.voices || []);
      break;
    case 'log':
      log(data.message, data.level || 'info');
      break;
    case 'progress':
      updateProgress(data.progress, data.status);
      break;
    case 'complete':
      isProcessing = false;
      generateBtn.disabled = false;
      generateBtn.textContent = 'Generate';
      generateBtn.classList.remove('btn-cancel');
      processingIndicator.classList.remove('active');
      statusText.textContent = 'Audio generated!';
      if (window.updateQueueSummary) window.updateQueueSummary([{ state: 'complete' }]);
      if (data.output) {
        const dir = data.output.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        if (!outputDir) outputDir = dir;
        openOutputBtn.style.display = '';
      }
      log(`Audio saved: ${data.output || 'done'}`, 'success');
      showAudioResult(data.output);
      break;
    case 'error':
      isProcessing = false;
      generateBtn.disabled = false;
      generateBtn.textContent = 'Generate';
      generateBtn.classList.remove('btn-cancel');
      processingIndicator.classList.remove('active');
      statusText.textContent = `Error: ${data.error}`;
      if (window.updateQueueSummary) window.updateQueueSummary([{ state: 'error' }]);
      log(`TTS error: ${data.error}`, 'error');
      resultArea.innerHTML = `<div class="empty-state" style="color: var(--error);">Error: ${window.escapeHtml(data.error)}</div>`;
      break;
  }
}

function populateVoices(voices) {
  voiceSelect.innerHTML = '';
  if (voices.length === 0) {
    voiceSelect.innerHTML = '<option value="default">Default</option>';
    return;
  }
  voices.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.id || v.name || v;
    opt.textContent = v.name || v.id || v;
    voiceSelect.appendChild(opt);
  });
  log(`Loaded ${voices.length} voice(s)`);
}

function updateProgress(progress, status) {
  const progressFill = document.getElementById('ttsProgress');
  if (progressFill) {
    progressFill.style.width = `${Math.round(progress * 100)}%`;
  }
  if (status) statusText.textContent = status;
}

function showAudioResult(outputPath) {
  if (outputPath) {
    const fileUrl = 'file://' + outputPath.replace(/\\/g, '/');
    resultArea.innerHTML = `
      <div class="tts-audio-player">
        <div class="audio-preview">
          <button class="audio-play-btn" id="ttsPlayBtn" title="Play audio">&#9654;</button>
          <span class="tts-play-label">Play result</span>
        </div>
        <div class="tts-output-path">${window.escapeHtml(outputPath)}</div>
      </div>`;
    const playBtn = document.getElementById('ttsPlayBtn');
    let currentAudio = null;
    playBtn.addEventListener('click', () => {
      if (currentAudio && !currentAudio.paused) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio = null;
        playBtn.innerHTML = '&#9654;';
        playBtn.classList.remove('playing');
        return;
      }
      currentAudio = new Audio(fileUrl);
      playBtn.innerHTML = '&#9632;';
      playBtn.classList.add('playing');
      currentAudio.play().catch(() => {
        playBtn.innerHTML = '&#9654;';
        playBtn.classList.remove('playing');
        log('Could not play audio preview', 'warn');
      });
      currentAudio.addEventListener('ended', () => {
        playBtn.innerHTML = '&#9654;';
        playBtn.classList.remove('playing');
        currentAudio = null;
      });
    });
  } else {
    resultArea.innerHTML = '<div class="empty-state" style="color: var(--success);">Audio generated successfully!</div>';
  }
}

function bindEvents() {
  ttsText.addEventListener('input', () => {
    charCount.textContent = ttsText.value.length;
    statusText.textContent = ttsText.value.trim() ? 'Text ready' : 'Ready';
  });

  speedSlider.addEventListener('input', () => {
    speedValue.textContent = `${parseFloat(speedSlider.value).toFixed(1)}x`;
  });

  outputDirBtn.addEventListener('click', async () => {
    if (isProcessing) return;
    const dir = await window.api.selectOutputDir();
    if (dir) {
      outputDir = dir;
      const display = dir.length > 35 ? '...' + dir.slice(-32) : dir;
      outputDirBtn.textContent = display;
      outputDirBtn.title = dir;
    }
  });

  openOutputBtn.addEventListener('click', () => {
    if (outputDir) window.api.openFolder(outputDir);
  });

  clearBtn.addEventListener('click', () => {
    ttsText.value = '';
    charCount.textContent = '0';
    resultArea.innerHTML = '<div class="empty-state">Enter text and click Generate to create speech audio.</div>';
    statusText.textContent = 'Ready';
    openOutputBtn.style.display = 'none';
    if (window.updateQueueSummary) window.updateQueueSummary([]);
    window.clearLog();
  });

  generateBtn.addEventListener('click', () => {
    if (isProcessing) {
      // Cancel
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'cancel' }));
        generateBtn.disabled = true;
        generateBtn.textContent = 'Cancelling...';
        log('Cancelling...', 'warn');
        setTimeout(() => {
          if (isProcessing) {
            generateBtn.disabled = false;
            generateBtn.textContent = 'Cancel';
            log('Cancel may not have completed — you can try again', 'warn');
          }
        }, 10000);
      }
      return;
    }

    const text = ttsText.value.trim();
    if (!text) {
      log('Please enter text to convert to speech', 'warn');
      return;
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log('Not connected to backend', 'error');
      return;
    }

    isProcessing = true;
    if (window.updateQueueSummary) window.updateQueueSummary([{ state: 'processing' }]);
    generateBtn.disabled = false;
    generateBtn.textContent = 'Cancel';
    generateBtn.classList.add('btn-cancel');
    processingIndicator.classList.add('active');
    statusText.textContent = 'Generating audio...';

    resultArea.innerHTML = `
      <div style="text-align: center; width: 100%;">
        <div class="file-progress-bar"><div class="file-progress-fill" id="ttsProgress" style="width: 0%"></div></div>
        <div style="margin-top: 8px; font-size: 12px; color: var(--text-secondary);">Generating...</div>
      </div>`;

    const voice = voiceSelect.value;
    const speed = parseFloat(speedSlider.value);
    const format = outputFormat.value;

    // Convert speed multiplier to edge-tts rate string (e.g., 1.5 -> "+50%", 0.5 -> "-50%")
    const ratePercent = Math.round((speed - 1.0) * 100);
    const rate = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;

    log(`Generating TTS: ${text.length} chars, voice=${voice}, speed=${speed}x, format=${format}`);

    ws.send(JSON.stringify({
      action: 'synthesize',
      text: text,
      voice: voice,
      rate: rate,
      output_format: format,
      output_dir: outputDir
    }));
  });
}

window.registerTool('tts', { init, cleanup });

})();

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

let ttsText, languageSelect, voiceSelect, speedSlider, speedValue, outputFormat;
let outputDirBtn, generateBtn, previewBtn, clearBtn, statusText, processingIndicator;
let resultArea, charCount, openOutputBtn;

let allVoices = [];
let isPreviewing = false;

function init(ctx) {
  pythonPort = ctx.pythonPort;
  log = ctx.log;

  ttsText = document.getElementById('ttsText');
  languageSelect = document.getElementById('languageSelect');
  voiceSelect = document.getElementById('voiceSelect');
  speedSlider = document.getElementById('speedSlider');
  speedValue = document.getElementById('speedValue');
  outputFormat = document.getElementById('outputFormat');
  outputDirBtn = document.getElementById('outputDirBtn');
  generateBtn = document.getElementById('generateBtn');
  previewBtn = document.getElementById('previewBtn');
  clearBtn = document.getElementById('clearBtn');
  statusText = document.getElementById('statusText');
  processingIndicator = document.getElementById('processingIndicator');
  resultArea = document.getElementById('resultArea');
  charCount = document.getElementById('charCount');
  openOutputBtn = document.getElementById('openOutputBtn');

  bindEvents();
  connectWebSocket(pythonPort);
  // log('Text-to-Speech initialized'); // Removed as per request to clean logs
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
    // if (statusText) statusText.textContent = 'Connected to backend';
    // log('WebSocket connected', 'success'); // Removed technical log
    // Request voice list
    ws.send(JSON.stringify({ action: 'list_voices' }));
  };
  ws.onmessage = (event) => handleWSMessage(JSON.parse(event.data));
  ws.onclose = () => {
    if (!statusText) return;
    statusText.textContent = 'Disconnected - reconnecting...';
    reconnectAttempts++;
    const delay = Math.min(reconnectDelay * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    // log(`WebSocket disconnected...`, 'warn'); // Simplified log
    reconnectTimerId = setTimeout(() => connectWebSocket(port), delay);
  };
  ws.onerror = () => { if (statusText) statusText.textContent = 'Connection error'; };
}

function handleWSMessage(data) {
  switch (data.type) {
    case 'voices':
      allVoices = data.voices || [];
      populateLanguages();
      break;
    case 'log':
      // Filter out technical logs from backend
      if (!data.message.toLowerCase().includes('websocket') && !data.message.toLowerCase().includes('connected')) {
        log(data.message, data.level || 'info');
      }
      break;
    case 'progress':
      updateProgress(data.progress, data.status);
      break;
    case 'complete':
      handleComplete(data);
      break;
    case 'error':
      isProcessing = false;
      isPreviewing = false;
      generateBtn.disabled = false;
      previewBtn.disabled = false;
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

function handleComplete(data) {
  isProcessing = false;
  const isActuallyPreview = isPreviewing;
  isPreviewing = false;
  
  generateBtn.disabled = false;
  previewBtn.disabled = false;
  generateBtn.textContent = 'Generate';
  generateBtn.classList.remove('btn-cancel');
  processingIndicator.classList.remove('active');
  
  statusText.textContent = isActuallyPreview ? 'Preview ready' : 'Audio generated!';
  if (window.updateQueueSummary) window.updateQueueSummary([{ state: 'complete' }]);
  
  if (!isActuallyPreview && data.output) {
    const dir = data.output.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    if (!outputDir) outputDir = dir;
    openOutputBtn.style.display = '';
    log(`Audio saved: ${data.output}`, 'success');
  }
  
  showAudioResult(data.output, isActuallyPreview);
}

function populateLanguages() {
  const languages = new Set();
  allVoices.forEach(v => {
    if (v.locale) {
      const lang = v.locale.split('-')[0];
      languages.add(lang);
    }
  });

  languageSelect.innerHTML = '';
  const sortedLangs = Array.from(languages).sort();
  
  // Try to find full language names
  const langNames = {
    'en': 'English',
    'es': 'Spanish',
    'fr': 'French',
    'de': 'German',
    'it': 'Italian',
    'pt': 'Portuguese',
    'ja': 'Japanese',
    'zh': 'Chinese',
    'ko': 'Korean',
    'ru': 'Russian',
    'hi': 'Hindi',
    'ar': 'Arabic'
  };

  sortedLangs.forEach(lang => {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = langNames[lang] || lang.toUpperCase();
    languageSelect.appendChild(opt);
  });

  // Default to English if available
  if (languages.has('en')) languageSelect.value = 'en';
  
  populateVoices();
}

function populateVoices() {
  const lang = languageSelect.value;
  const filtered = allVoices.filter(v => v.locale.startsWith(lang));
  
  // Simplify: only take a few male and female variants
  const simplified = [];
  const genders = { 'Male': 0, 'Female': 0 };
  const MAX_VARIANTS = 3;

  filtered.forEach(v => {
    if (genders[v.gender] < MAX_VARIANTS) {
      simplified.push(v);
      genders[v.gender]++;
    }
  });

  voiceSelect.innerHTML = '';
  simplified.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = `${v.gender} variant ${simplified.filter(sv => sv.gender === v.gender).indexOf(v) + 1}`;
    voiceSelect.appendChild(opt);
  });
}

function updateProgress(progress, status) {
  const progressFill = document.getElementById('ttsProgress');
  if (progressFill) {
    progressFill.style.width = `${Math.round(progress * 100)}%`;
  }
  if (status) statusText.textContent = status;
}

function showAudioResult(outputPath, isPreview) {
  if (outputPath) {
    const fileUrl = 'file://' + outputPath.replace(/\\/g, '/');
    resultArea.innerHTML = `
      <div class="tts-audio-player">
        <div class="audio-preview">
          <button class="audio-play-btn" id="ttsPlayBtn" title="Play audio">&#9654;</button>
          <span class="tts-play-label">${isPreview ? 'Play Preview' : 'Play result'}</span>
        </div>
        ${isPreview ? '' : `<div class="tts-output-path">${window.escapeHtml(outputPath)}</div>`}
      </div>`;
    
    const playBtn = document.getElementById('ttsPlayBtn');
    let audio = new Audio(fileUrl);
    
    playBtn.addEventListener('click', () => {
      if (!audio.paused) {
        audio.pause();
        audio.currentTime = 0;
        playBtn.innerHTML = '&#9654;';
        playBtn.classList.remove('playing');
      } else {
        playBtn.innerHTML = '&#9632;';
        playBtn.classList.add('playing');
        audio.play().catch(() => {
          playBtn.innerHTML = '&#9654;';
          playBtn.classList.remove('playing');
          log('Could not play audio preview', 'warn');
        });
      }
    });

    audio.addEventListener('ended', () => {
      playBtn.innerHTML = '&#9654;';
      playBtn.classList.remove('playing');
    });

    // Auto-play preview
    if (isPreview) playBtn.click();

  } else {
    resultArea.innerHTML = '<div class="empty-state" style="color: var(--success);">Audio generated successfully!</div>';
  }
}

function bindEvents() {
  ttsText.addEventListener('input', () => {
    charCount.textContent = ttsText.value.length;
    statusText.textContent = ttsText.value.trim() ? 'Text Entered' : 'Waiting for Text';
  });

  languageSelect.addEventListener('change', populateVoices);

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
    resultArea.innerHTML = '<div class="empty-state">Enter text and click Preview or Generate.</div>';
    statusText.textContent = 'Waiting for Text';
    openOutputBtn.style.display = 'none';
    if (window.updateQueueSummary) window.updateQueueSummary([]);
    window.clearLog();
  });

  previewBtn.addEventListener('click', () => startSynthesis(true));
  generateBtn.addEventListener('click', () => {
    if (isProcessing && !isPreviewing) {
      // Cancel logic
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'cancel' }));
        generateBtn.disabled = true;
        generateBtn.textContent = 'Cancelling...';
        setTimeout(() => { if (isProcessing) { generateBtn.disabled = false; generateBtn.textContent = 'Cancel'; } }, 5000);
      }
      return;
    }
    startSynthesis(false);
  });
}

function startSynthesis(isPreview) {
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
  isPreviewing = isPreview;
  
  if (window.updateQueueSummary) window.updateQueueSummary([{ state: 'processing' }]);
  
  generateBtn.disabled = !isPreview;
  previewBtn.disabled = true;
  if (!isPreview) {
    generateBtn.textContent = 'Cancel';
    generateBtn.classList.add('btn-cancel');
  }
  
  processingIndicator.classList.add('active');
  statusText.textContent = isPreview ? 'Preparing preview...' : 'Generating audio...';

  resultArea.innerHTML = `
    <div style="text-align: center; width: 100%;">
      <div class="file-progress-bar"><div class="file-progress-fill" id="ttsProgress" style="width: 0%"></div></div>
      <div style="margin-top: 8px; font-size: 12px; color: var(--text-secondary);">${isPreview ? 'Preparing preview...' : 'Generating...'}</div>
    </div>`;

  const voice = voiceSelect.value;
  const speed = parseFloat(speedSlider.value);
  const format = outputFormat.value;

  const ratePercent = Math.round((speed - 1.0) * 100);
  const rate = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;

  if (!isPreview) {
    log(`Generating TTS: ${text.length} chars, voice=${voice}, speed=${speed}x`);
  }

  ws.send(JSON.stringify({
    action: 'synthesize',
    text: text,
    voice: voice,
    rate: rate,
    output_format: format,
    output_dir: isPreview ? 'TEMP' : outputDir,
    is_preview: isPreview
  }));
}

window.registerTool('tts', { init, cleanup });

})();

// ============================================================================
// Text-to-Speech Tool (WebSocket-based)
// ============================================================================

(function() {

let outputDir = '';
let isProcessing = false;
let ws = null;
let getPythonPort = () => null;
let connectedPythonPort = null;
let pythonToken = null;
let log = null;

let reconnectDelay = 1000;
let reconnectAttempts = 0;
let reconnectTimerId = null;
let cancelWatchdog = null;
const MAX_RECONNECT_DELAY = 30000;

let ttsText, languageSelect, voiceSelect, speedSlider, speedValue, pitchSlider, pitchValue, outputFormat;
let spellcheckToggle;
let outputDirBtn, generateBtn, previewBtn, clearBtn, statusText, processingIndicator;
let resultArea, charCount, openOutputBtn;

let allVoices = [];
let isPreviewing = false;
let _ttsAudio = null; // active result/preview audio, stopped on cleanup
let _previewOutputPath = '';
const PREVIEW_MAX_CHARS = 300;
let savedLanguage = '';
let savedVoice = '';
let _saveTimer = null;

async function init(ctx) {
  getPythonPort = typeof ctx.getPythonPort === 'function' ? ctx.getPythonPort : () => ctx.pythonPort;
  pythonToken = ctx.pythonToken;
  log = ctx.log;

  ttsText = document.getElementById('ttsText');
  spellcheckToggle = document.getElementById('spellcheckToggle');
  languageSelect = document.getElementById('languageSelect');
  voiceSelect = document.getElementById('voiceSelect');
  speedSlider = document.getElementById('speedSlider');
  speedValue = document.getElementById('speedValue');
  pitchSlider = document.getElementById('pitchSlider');
  pitchValue = document.getElementById('pitchValue');
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

  await loadToolSettings();
  bindEvents();
  connectWebSocket();
  // log('Text-to-Speech initialized'); // Removed as per request to clean logs
}

function cleanup() {
  releasePreviewFile();
  stopTtsPlayback();
  _ttsAudio = null;
  if (spellcheckToggle) spellcheckToggle.checked = false;
  if (ttsText) ttsText.spellcheck = false;
  if (reconnectTimerId) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
  if (cancelWatchdog) { clearTimeout(cancelWatchdog); cancelWatchdog = null; }
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  connectedPythonPort = null;
}

// ---- WebSocket ----
function connectWebSocket() {
  const port = getPythonPort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  connectedPythonPort = port;
  ws = new WebSocket(`ws://127.0.0.1:${port}/tts/ws?token=${encodeURIComponent(pythonToken || '')}`);
  ws.onopen = () => {
    reconnectDelay = 1000; reconnectAttempts = 0;
    reconnectTimerId = null;
    if (!isProcessing && statusText) statusText.textContent = 'Checking installed voices...';
    // if (statusText) statusText.textContent = 'Connected to backend';
    // log('WebSocket connected', 'success'); // Removed technical log
    // Request voice list
    ws.send(JSON.stringify({ action: 'list_voices' }));
  };
  ws.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); }
    catch { return; } // ignore malformed frames rather than throwing in the socket loop
    handleWSMessage(data);
  };
  ws.onclose = () => {
    ws = null;
    connectedPythonPort = null;
    if (!statusText) return;
    statusText.textContent = 'Disconnected - reconnecting...';
    if (isProcessing) resetProcessingState('Synthesis interrupted by backend disconnect');
    reconnectAttempts++;
    const delay = Math.min(reconnectDelay * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    // log(`WebSocket disconnected...`, 'warn'); // Simplified log
    reconnectTimerId = setTimeout(connectWebSocket, delay);
  };
  ws.onerror = () => { if (statusText) statusText.textContent = 'Connection error'; };
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
    case 'voices':
      allVoices = Array.isArray(data.voices)
        ? data.voices.filter(voice => voice && typeof voice.id === 'string' && typeof voice.locale === 'string')
        : [];
      populateLanguages();
      if (allVoices.length && statusText) {
        statusText.textContent = ttsText.value.trim() ? 'Text Entered' : 'Ready - fully offline';
      }
      break;
    case 'log':
      // Filter out technical logs from backend
      if (typeof data.message === 'string' && !data.message.toLowerCase().includes('websocket') && !data.message.toLowerCase().includes('connected')) {
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
      if (!isProcessing && allVoices.length === 0) {
        const message = typeof data.error === 'string' ? data.error : 'No offline voices are available';
        languageSelect.disabled = true;
        voiceSelect.disabled = true;
        previewBtn.disabled = true;
        generateBtn.disabled = true;
        statusText.textContent = 'Offline speech unavailable';
        resultArea.innerHTML = `<div class="empty-state" style="color: var(--error);">${window.escapeHtml(message)}</div>`;
        log(`TTS unavailable: ${message}`, 'error');
      } else {
        resetProcessingState(typeof data.error === 'string' ? data.error : 'Text-to-speech failed');
      }
      break;
  }
}

function stopTtsPlayback() {
  if (_ttsAudio) {
    try {
      _ttsAudio.pause();
      _ttsAudio.currentTime = 0;
    } catch {}
  }
  const playBtn = document.getElementById('ttsPlayBtn');
  if (playBtn) {
    playBtn.innerHTML = '&#9654;';
    playBtn.classList.remove('playing');
  }
}

function resetProcessingState(errorMessage = '') {
  if (cancelWatchdog) { clearTimeout(cancelWatchdog); cancelWatchdog = null; }
  isProcessing = false;
  isPreviewing = false;
  generateBtn.disabled = false;
  previewBtn.disabled = false;
  generateBtn.textContent = 'Generate';
  generateBtn.classList.remove('btn-cancel');
  processingIndicator.classList.remove('active');
  if (errorMessage) {
    statusText.textContent = `Error: ${errorMessage}`;
    if (window.updateQueueSummary) window.updateQueueSummary([{ state: 'error' }], 'tts');
    log(`TTS error: ${errorMessage}`, 'error');
    resultArea.innerHTML = `<div class="empty-state" style="color: var(--error);">Error: ${window.escapeHtml(errorMessage)}</div>`;
  }
}

function handleComplete(data) {
  if (cancelWatchdog) { clearTimeout(cancelWatchdog); cancelWatchdog = null; }
  const output = data && typeof data.output === 'string' ? data.output : '';
  if (!output) {
    resetProcessingState('The backend did not return an audio file');
    return;
  }
  isProcessing = false;
  const isActuallyPreview = isPreviewing;
  isPreviewing = false;
  
  generateBtn.disabled = false;
  previewBtn.disabled = false;
  generateBtn.textContent = 'Generate';
  generateBtn.classList.remove('btn-cancel');
  processingIndicator.classList.remove('active');
  
  statusText.textContent = isActuallyPreview ? 'Preview Generated' : 'Audio generated!';
  if (window.updateQueueSummary) window.updateQueueSummary([{ state: 'complete' }], 'tts');
  
  if (!isActuallyPreview) {
    const dir = window.getParentDirectory(output);
    if (!outputDir) outputDir = dir;
    openOutputBtn.style.display = '';
    log(`Audio saved: ${output}`, 'success');
    if (window.showCompletionToast) window.showCompletionToast(`Audio saved: ${output.split(/[\\/]/).pop()}`, false, [output]);
    if (window.addRecentFile) window.addRecentFile(output);
    if (window.autoOpenOutputIfEnabled && outputDir) window.autoOpenOutputIfEnabled(outputDir);
  }
  if (isActuallyPreview) _previewOutputPath = output;
  
  showAudioResult(output, isActuallyPreview);
}

function releasePreviewFile() {
  if (_ttsAudio) {
    try { _ttsAudio.pause(); } catch {}
    if (_previewOutputPath) {
      try {
        _ttsAudio.removeAttribute('src');
        _ttsAudio.load();
      } catch {}
    }
  }
  if (_previewOutputPath && ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ action: 'cleanup_preview', path: _previewOutputPath })); } catch {}
  }
  _previewOutputPath = '';
}

function populateLanguages() {
  const languages = new Set();
  allVoices.forEach(v => {
    if (v.locale) {
      const lang = v.locale.replace('_', '-').split('-')[0].toLowerCase();
      languages.add(lang);
    }
  });

  languageSelect.innerHTML = '';
  const sortedLangs = Array.from(languages).sort();

  if (sortedLangs.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No local voices installed';
    languageSelect.appendChild(option);
    voiceSelect.innerHTML = '<option value="">No local voices installed</option>';
    languageSelect.disabled = true;
    voiceSelect.disabled = true;
    previewBtn.disabled = true;
    generateBtn.disabled = true;
    return;
  }
  languageSelect.disabled = false;
  voiceSelect.disabled = false;
  previewBtn.disabled = false;
  generateBtn.disabled = false;
  
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
  if (savedLanguage && languages.has(savedLanguage)) languageSelect.value = savedLanguage;
  else if (languages.has('en')) languageSelect.value = 'en';
  
  populateVoices();
}

function populateVoices() {
  const lang = languageSelect.value;
  const filtered = allVoices.filter(v => v && typeof v.locale === 'string'
    && v.locale.replace('_', '-').toLowerCase().split('-')[0] === lang);

  voiceSelect.innerHTML = '';
  filtered.sort((a, b) => cleanVoiceName(a).localeCompare(cleanVoiceName(b))).forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.id;
    const details = [v.locale, v.gender, v.engine].filter(Boolean).join(', ');
    opt.textContent = details ? `${cleanVoiceName(v)} (${details})` : cleanVoiceName(v);
    voiceSelect.appendChild(opt);
  });
  if (savedVoice && filtered.some(v => v.id === savedVoice)) voiceSelect.value = savedVoice;
  savedVoice = voiceSelect.value;
  updatePitchAvailability();
}

function cleanVoiceName(voice) {
  return String(voice.name || voice.id || '').trim();
}

function updatePitchAvailability() {
  const selected = allVoices.find(voice => voice.id === voiceSelect.value);
  const supportsPitch = !!selected && selected.supports_pitch !== false;
  pitchSlider.disabled = !supportsPitch;
  pitchSlider.title = supportsPitch ? 'Adjust the local voice pitch' : 'This local speech engine does not expose pitch control';
  if (!supportsPitch) pitchValue.textContent = 'Unavailable';
  else {
    const pitch = parseInt(pitchSlider.value, 10) || 0;
    pitchValue.textContent = `${pitch > 0 ? '+' : ''}${pitch}Hz`;
  }
}

function updateProgress(progress, status) {
  const progressFill = document.getElementById('ttsProgress');
  if (progressFill) {
    const normalized = Math.max(0, Math.min(1, Number(progress) || 0));
    progressFill.style.width = `${Math.round(normalized * 100)}%`;
  }
  if (typeof status === 'string' && status) statusText.textContent = status;
}

function showAudioResult(outputPath, isPreview) {
  if (outputPath) {
    const fileUrl = window.localPathToFileUrl(outputPath);
    resultArea.innerHTML = `
      <div class="tts-audio-player">
        <div class="audio-preview">
          <button class="audio-play-btn" id="ttsPlayBtn" title="Play audio">&#9654;</button>
          <span class="tts-play-label">${isPreview ? 'Play Preview' : 'Play result'}</span>
        </div>
        ${isPreview ? '' : `<div class="tts-output-path">${window.escapeHtml(outputPath)}</div>`}
      </div>`;
    
    const playBtn = document.getElementById('ttsPlayBtn');
    if (_ttsAudio) { _ttsAudio.pause(); }
    let audio = new Audio(fileUrl);
    _ttsAudio = audio;

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

  if (spellcheckToggle) {
    // Keep platform spellcheck session-only and fail closed. Chromium or the
    // operating system may manage dictionaries outside this tool, so it must
    // never turn on merely because an old setting was restored at startup.
    spellcheckToggle.checked = false;
    ttsText.spellcheck = false;
    spellcheckToggle.addEventListener('change', () => {
      ttsText.spellcheck = spellcheckToggle.checked;
      // Chromium only re-evaluates spellcheck on the next edit/focus, so nudge
      // focus to apply (or clear) the red underlines immediately.
      const hadFocus = document.activeElement === ttsText;
      ttsText.blur();
      if (spellcheckToggle.checked || hadFocus) ttsText.focus();
      saveToolSettings();
    });
  }

  languageSelect.addEventListener('change', () => {
    savedLanguage = languageSelect.value;
    savedVoice = '';
    populateVoices();
    savedVoice = voiceSelect.value;
    saveToolSettings();
  });
  voiceSelect.addEventListener('change', () => {
    savedVoice = voiceSelect.value;
    updatePitchAvailability();
    saveToolSettings();
  });

  speedSlider.addEventListener('input', () => {
    speedValue.textContent = `${parseFloat(speedSlider.value).toFixed(1)}x`;
    saveToolSettings();
  });

  pitchSlider.addEventListener('input', () => {
    const pitch = parseInt(pitchSlider.value, 10);
    pitchValue.textContent = `${pitch > 0 ? '+' : ''}${pitch}Hz`;
    saveToolSettings();
  });
  outputFormat.addEventListener('change', saveToolSettings);

  outputDirBtn.addEventListener('click', async () => {
    if (isProcessing) return;
    const dir = await window.api.system.selectOutputDir();
    if (dir) {
      outputDir = dir;
      const display = dir.length > 35 ? '...' + dir.slice(-32) : dir;
      outputDirBtn.textContent = display;
      outputDirBtn.title = dir;
      saveToolSettings();
    }
  });

  openOutputBtn.addEventListener('click', () => {
    if (outputDir) window.api.system.openFolder(outputDir);
  });

  clearBtn.addEventListener('click', () => {
    if (isProcessing) {
      log('Wait for synthesis to finish or cancel it before clearing', 'warn');
      return;
    }
    releasePreviewFile();
    if (_ttsAudio) { _ttsAudio.pause(); _ttsAudio = null; }
    ttsText.value = '';
    charCount.textContent = '0';
    resultArea.innerHTML = '<div class="empty-state">Enter text and click Preview or Generate.</div>';
    statusText.textContent = 'Waiting for Text';
    openOutputBtn.style.display = 'none';
    if (window.updateQueueSummary) window.updateQueueSummary([], 'tts');
    window.clearLog();
  });

  previewBtn.addEventListener('click', () => startSynthesis(true));
  generateBtn.addEventListener('click', () => {
    if (isProcessing) {
      // Cancel logic
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ action: 'cancel' })); }
        catch (err) {
          log(`Could not request cancellation: ${err.message}`, 'error');
          return;
        }
        generateBtn.disabled = true;
        generateBtn.textContent = 'Cancelling...';
        if (cancelWatchdog) clearTimeout(cancelWatchdog);
        cancelWatchdog = setTimeout(() => {
          cancelWatchdog = null;
          if (isProcessing) { generateBtn.disabled = false; generateBtn.textContent = 'Cancel'; }
        }, 5000);
      }
      return;
    }
    startSynthesis(false);
  });
}

function startSynthesis(isPreview) {
  if (isProcessing) return;
  if (cancelWatchdog) { clearTimeout(cancelWatchdog); cancelWatchdog = null; }
  const text = ttsText.value.trim();
  if (!text) {
    log('Please enter text to convert to speech', 'warn');
    return;
  }
  if (text.length > 50000) {
    log('Text is too long. The maximum is 50,000 characters.', 'warn');
    return;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log('Not connected to backend', 'error');
    return;
  }

  releasePreviewFile();

  isProcessing = true;
  isPreviewing = isPreview;
  
  if (window.updateQueueSummary) window.updateQueueSummary([{ state: 'processing' }], 'tts');
  
  // Keep the primary button available as Cancel for both previews and full jobs.
  generateBtn.disabled = false;
  previewBtn.disabled = true;
  generateBtn.textContent = 'Cancel';
  generateBtn.classList.add('btn-cancel');
  
  processingIndicator.classList.add('active');
  statusText.textContent = isPreview ? 'Preparing preview...' : 'Generating audio...';

  resultArea.innerHTML = `
    <div style="text-align: center; width: 100%;">
      <div class="file-progress-bar"><div class="file-progress-fill" id="ttsProgress" style="width: 0%"></div></div>
      <div style="margin-top: 8px; font-size: 12px; color: var(--text-secondary);">${isPreview ? 'Preparing preview...' : 'Generating...'}</div>
    </div>`;

  const synthesisText = isPreview ? text.slice(0, PREVIEW_MAX_CHARS) : text;
  const voice = voiceSelect.value;
  const speed = parseFloat(speedSlider.value);
  const selectedVoice = allVoices.find(item => item.id === voiceSelect.value);
  const pitchHz = selectedVoice && selectedVoice.supports_pitch !== false
    ? parseInt(pitchSlider.value, 10) : 0;
  const format = outputFormat.value;

  const ratePercent = Math.round((speed - 1.0) * 100);
  const rate = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;
  const pitch = pitchHz >= 0 ? `+${pitchHz}Hz` : `${pitchHz}Hz`;

  if (!isPreview) {
    log(`Generating offline TTS: ${text.length} chars, voice=${voice}, speed=${speed}x`);
  }

  try {
    ws.send(JSON.stringify({
      action: 'synthesize',
      text: synthesisText,
      voice: voice,
      rate: rate,
      pitch: pitch,
      output_format: format,
      output_dir: isPreview ? 'TEMP' : outputDir,
      is_preview: isPreview
    }));
  } catch (err) {
    resetProcessingState(`Could not start synthesis: ${err.message}`);
  }
}

async function loadToolSettings() {
  try {
    const all = await window.loadAllSettings();
    const settings = all.tts || {};
    outputDir = typeof settings.outputDir === 'string' ? settings.outputDir : '';
    if (!outputDir && window.getDefaultOutputDir) outputDir = window.getDefaultOutputDir();
    if (outputDir) {
      const parts = outputDir.replace(/\\/g, '/').split('/');
      outputDirBtn.textContent = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : outputDir;
      outputDirBtn.title = outputDir;
    }

    const speed = Number(settings.speed);
    if (Number.isFinite(speed) && speed >= 0.5 && speed <= 2) speedSlider.value = String(speed);
    speedValue.textContent = `${Number(speedSlider.value).toFixed(1)}x`;

    const pitch = Number(settings.pitch);
    if (Number.isFinite(pitch) && pitch >= -12 && pitch <= 12) pitchSlider.value = String(pitch);
    const pitchValueNumber = Number(pitchSlider.value);
    pitchValue.textContent = `${pitchValueNumber > 0 ? '+' : ''}${pitchValueNumber}Hz`;

    if (settings.outputFormat === 'mp3' || settings.outputFormat === 'wav') outputFormat.value = settings.outputFormat;
    savedLanguage = typeof settings.language === 'string' ? settings.language : '';
    savedVoice = typeof settings.voice === 'string' ? settings.voice : '';
  } catch (err) {
    log(`Could not load TTS settings: ${err.message}`, 'warn');
  }
}

function saveToolSettings() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    window.updateSettings(all => {
      all.tts = {
        outputDir,
        language: languageSelect.value || savedLanguage,
        voice: voiceSelect.value || savedVoice,
        speed: Number(speedSlider.value),
        pitch: Number(pitchSlider.value),
        outputFormat: outputFormat.value
      };
    }).catch(err => log(`Could not save TTS settings: ${err.message}`, 'warn'));
  }, 250);
}

window.registerTool('tts', { init, cleanup, deactivate: stopTtsPlayback, onBackendStatus });

})();

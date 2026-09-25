// ============================================================================
// QR Studio Tool
// ============================================================================

(function() {

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

let isGenerating = false;
let isScanning = false;
let lastGeneratedDataUrl = null;
let lastGeneratedOptions = null;
let log = null;
let activeTemplate = 'text';
let generationRequestId = 0;
let scanRequestId = 0;

let qrText, qrSize, qrSizeValue, qrColor, qrBgColor;
let qrMargin, qrMarginValue, qrErrorCorrection;
let generateBtn, saveBtn, clearBtn, statusText, processingIndicator;
let qrPreviewBox, scanToggle, scanPanel, scanDropZone, scanBrowseBtn;
let scanResult, decodedText, copyResultBtn;

// Template fields
let qrUrl;
let qrWifiSsid, qrWifiPass, qrWifiSecurity;
let qrVcardName, qrVcardPhone, qrVcardEmail, qrVcardOrg;
let qrGeoLat, qrGeoLon;

function init(ctx) {
  log = ctx.log;

  qrText = document.getElementById('qrText');
  qrSize = document.getElementById('qrSize');
  qrSizeValue = document.getElementById('qrSizeValue');
  qrColor = document.getElementById('qrColor');
  qrBgColor = document.getElementById('qrBgColor');
  qrMargin = document.getElementById('qrMargin');
  qrMarginValue = document.getElementById('qrMarginValue');
  qrErrorCorrection = document.getElementById('qrErrorCorrection');
  generateBtn = document.getElementById('generateBtn');
  saveBtn = document.getElementById('saveBtn');
  clearBtn = document.getElementById('clearBtn');
  statusText = document.getElementById('statusText');
  processingIndicator = document.getElementById('processingIndicator');
  qrPreviewBox = document.getElementById('qrPreviewBox');
  scanToggle = document.getElementById('scanToggle');
  scanPanel = document.getElementById('scanPanel');
  scanDropZone = document.getElementById('scanDropZone');
  scanBrowseBtn = document.getElementById('scanBrowseBtn');
  scanResult = document.getElementById('scanResult');
  decodedText = document.getElementById('decodedText');
  copyResultBtn = document.getElementById('copyResultBtn');

  // Template fields
  qrUrl = document.getElementById('qrUrl');
  qrWifiSsid = document.getElementById('qrWifiSsid');
  qrWifiPass = document.getElementById('qrWifiPass');
  qrWifiSecurity = document.getElementById('qrWifiSecurity');
  qrVcardName = document.getElementById('qrVcardName');
  qrVcardPhone = document.getElementById('qrVcardPhone');
  qrVcardEmail = document.getElementById('qrVcardEmail');
  qrVcardOrg = document.getElementById('qrVcardOrg');
  qrGeoLat = document.getElementById('qrGeoLat');
  qrGeoLon = document.getElementById('qrGeoLon');

  bindEvents();
  switchTemplate(activeTemplate, false);
  log('QR Studio initialized');
}

function cleanup() {
  clearTimeout(_previewTimer);
  generationRequestId++;
  scanRequestId++;
}

function escapeWifiField(value) {
  return String(value || '').replace(/([\\;,:"])/g, '\\$1');
}

function escapeVcardField(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function getTemplateText() {
  switch (activeTemplate) {
    case 'url': {
      const url = qrUrl.value.trim();
      if (!url) return '';
      return /^https?:\/\//i.test(url) ? url : `https://${url}`;
    }
    case 'wifi': {
      const ssid = qrWifiSsid.value.trim();
      if (!ssid) return '';
      const sec = qrWifiSecurity.value;
      const pass = qrWifiPass.value;
      if (sec === 'nopass') return `WIFI:T:nopass;S:${escapeWifiField(ssid)};;`;
      return `WIFI:T:${sec};S:${escapeWifiField(ssid)};P:${escapeWifiField(pass)};;`;
    }
    case 'vcard': {
      const name = qrVcardName.value.trim();
      if (!name) return '';
      let card = 'BEGIN:VCARD\nVERSION:3.0\nFN:' + escapeVcardField(name);
      const phone = qrVcardPhone.value.trim();
      const email = qrVcardEmail.value.trim();
      const org = qrVcardOrg.value.trim();
      if (phone) card += '\nTEL:' + escapeVcardField(phone);
      if (email) card += '\nEMAIL:' + escapeVcardField(email);
      if (org) card += '\nORG:' + escapeVcardField(org);
      card += '\nEND:VCARD';
      return card;
    }
    case 'geo': {
      const lat = qrGeoLat.value.trim();
      const lon = qrGeoLon.value.trim();
      if (!lat || !lon) return '';
      const latitude = Number(lat);
      const longitude = Number(lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
          latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return '';
      return `geo:${latitude},${longitude}`;
    }
    default:
      return qrText.value.trim();
  }
}

function getQROptions() {
  return {
    text: getTemplateText(),
    size: parseInt(qrSize.value),
    margin: parseInt(qrMargin.value),
    color: qrColor.value,
    backgroundColor: qrBgColor.value,
    errorCorrection: qrErrorCorrection.value
  };
}

function switchTemplate(name, refreshPreview = true) {
  activeTemplate = name;

  // Update tabs
  document.querySelectorAll('.qr-template-tab').forEach(tab => {
    const selected = tab.dataset.template === name;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });

  // Show/hide field panels
  const panels = {
    text: 'tmplText',
    url: 'tmplUrl',
    wifi: 'tmplWifi',
    vcard: 'tmplVcard',
    geo: 'tmplGeo'
  };
  Object.entries(panels).forEach(([key, id]) => {
    const panel = document.getElementById(id);
    const selected = key === name;
    panel.style.display = selected ? '' : 'none';
    panel.setAttribute('aria-hidden', String(!selected));
  });

  if (refreshPreview) schedulePreview();
}

let _previewTimer = null;

function refreshProcessingUi() {
  processingIndicator.classList.toggle('active', isGenerating || isScanning);
  generateBtn.disabled = isGenerating;
}

function invalidateGeneratedPreview(message = 'Waiting for valid input') {
  clearTimeout(_previewTimer);
  generationRequestId++;
  lastGeneratedDataUrl = null;
  lastGeneratedOptions = null;
  saveBtn.disabled = true;
  qrPreviewBox.innerHTML = '<div class="empty-state">QR code preview will appear here</div>';
  if (isGenerating) {
    isGenerating = false;
    refreshProcessingUi();
  }
  if (!isScanning) statusText.textContent = message;
}

function schedulePreview() {
  invalidateGeneratedPreview();
  const text = getTemplateText();
  if (text.length > 0 && text.length <= 2953) {
    _previewTimer = setTimeout(() => handleGenerate(), 500);
  }
}

function bindEvents() {
  // Template tab clicks
  document.querySelectorAll('.qr-template-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTemplate(tab.dataset.template));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = Array.from(document.querySelectorAll('.qr-template-tab'));
      const current = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
        (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      switchTemplate(tabs[next].dataset.template);
    });
  });

  // Auto-preview for all template inputs
  qrText.addEventListener('input', schedulePreview);
  qrUrl.addEventListener('input', schedulePreview);
  qrWifiSsid.addEventListener('input', schedulePreview);
  qrWifiPass.addEventListener('input', schedulePreview);
  qrWifiSecurity.addEventListener('change', schedulePreview);
  qrVcardName.addEventListener('input', schedulePreview);
  qrVcardPhone.addEventListener('input', schedulePreview);
  qrVcardEmail.addEventListener('input', schedulePreview);
  qrVcardOrg.addEventListener('input', schedulePreview);
  qrGeoLat.addEventListener('input', schedulePreview);
  qrGeoLon.addEventListener('input', schedulePreview);

  qrSize.addEventListener('input', () => {
    qrSizeValue.textContent = `${qrSize.value}px`;
    schedulePreview();
  });

  qrMargin.addEventListener('input', () => {
    qrMarginValue.textContent = qrMargin.value;
    schedulePreview();
  });
  qrColor.addEventListener('input', schedulePreview);
  qrBgColor.addEventListener('input', schedulePreview);
  qrErrorCorrection.addEventListener('change', schedulePreview);

  generateBtn.addEventListener('click', handleGenerate);
  saveBtn.addEventListener('click', handleSave);

  clearBtn.addEventListener('click', () => {
    clearTimeout(_previewTimer);
    generationRequestId++;
    scanRequestId++;
    qrText.value = '';
    qrUrl.value = '';
    qrWifiSsid.value = '';
    qrWifiPass.value = '';
    qrWifiSecurity.value = 'WPA';
    qrVcardName.value = '';
    qrVcardPhone.value = '';
    qrVcardEmail.value = '';
    qrVcardOrg.value = '';
    qrGeoLat.value = '';
    qrGeoLon.value = '';
    switchTemplate('text', false);
    qrPreviewBox.innerHTML = '<div class="empty-state">QR code preview will appear here</div>';
    scanResult.style.display = 'none';
    decodedText.textContent = '';
    statusText.textContent = 'Waiting for input';
    lastGeneratedDataUrl = null;
    lastGeneratedOptions = null;
    isGenerating = false;
    isScanning = false;
    refreshProcessingUi();
    saveBtn.disabled = true;
    window.clearLog();
  });

  // Scan toggle
  scanToggle.addEventListener('click', () => {
    const visible = scanPanel.style.display !== 'none';
    scanPanel.style.display = visible ? 'none' : 'block';
    scanToggle.textContent = visible ? 'Scan existing QR code' : 'Hide scanner';
    scanToggle.setAttribute('aria-expanded', String(!visible));
  });

  // Scan drop zone
  scanDropZone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); scanDropZone.classList.add('dragover'); });
  scanDropZone.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); scanDropZone.classList.remove('dragover'); });
  scanDropZone.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); scanDropZone.classList.remove('dragover');
    const paths = [];
    for (const file of e.dataTransfer.files) paths.push(window.api.system.getPathForFile(file));
    if (paths.length > 0) {
      const resolved = await window.api.system.resolveDroppedPaths(paths);
      if (resolved.length > 0) scanQR(resolved[0]);
      else log('No supported image file found', 'warn');
    }
  });

  scanBrowseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const paths = await window.api.system.selectFiles({ title: 'Select Image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
    if (paths.length > 0) scanQR(paths[0]);
  });

  scanDropZone.addEventListener('click', async (e) => {
    if (e.target.id === 'scanBrowseBtn') return;
    const paths = await window.api.system.selectFiles({ title: 'Select Image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
    if (paths.length > 0) scanQR(paths[0]);
  });

  copyResultBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(decodedText.textContent).then(() => {
      copyResultBtn.textContent = 'Copied!';
      setTimeout(() => { copyResultBtn.textContent = 'Copy to Clipboard'; }, 2000);
    }).catch(err => log(`Could not copy QR result: ${err.message}`, 'error'));
  });
}

async function handleGenerate() {
  clearTimeout(_previewTimer);
  const text = getTemplateText();
  if (!text) {
    invalidateGeneratedPreview();
    log('Please fill in the required fields to generate a QR code', 'warn');
    return;
  }
  if (text.length > 2953) {
    invalidateGeneratedPreview('Input is too long for a QR code');
    log(`Text too long (${text.length} chars). QR codes support max 2,953 characters.`, 'warn');
    return;
  }

  const requestId = ++generationRequestId;
  const opts = getQROptions();
  lastGeneratedDataUrl = null;
  lastGeneratedOptions = null;
  saveBtn.disabled = true;
  qrPreviewBox.innerHTML = '<div class="empty-state">Generating preview...</div>';
  isGenerating = true;
  refreshProcessingUi();
  statusText.textContent = 'Generating QR code...';

  log(`Generating QR code: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}", size=${opts.size}px`);

  try {
    const preview = await window.api.tools.qrStudio.previewQR(opts);
    if (requestId !== generationRequestId) return;

    if (preview && preview.success && /^data:image\/(?:png|webp);base64,/i.test(preview.dataUrl || '')) {
      const image = document.createElement('img');
      image.src = preview.dataUrl;
      image.alt = 'QR Code';
      qrPreviewBox.replaceChildren(image);
      lastGeneratedDataUrl = preview.dataUrl;
      lastGeneratedOptions = { ...opts };
      saveBtn.disabled = false;
      log('QR code generated successfully', 'success');
      statusText.textContent = 'QR code generated!';
    } else {
      log(`Generation failed: ${preview ? preview.error : 'unknown error'}`, 'error');
      statusText.textContent = 'Error generating QR code';
    }
  } catch (err) {
    if (requestId !== generationRequestId) return;
    log(`QR generation error: ${err.message}`, 'error');
    statusText.textContent = 'Error generating QR code';
  }

  if (requestId === generationRequestId) {
    isGenerating = false;
    refreshProcessingUi();
  }
}

async function handleSave() {
  if (!lastGeneratedDataUrl || !lastGeneratedOptions) {
    log('Generate a QR code first', 'warn');
    return;
  }

  const requestId = generationRequestId;
  const opts = { ...lastGeneratedOptions };

  // Use default output dir if available, otherwise prompt
  let dir = window.getDefaultOutputDir ? window.getDefaultOutputDir() : '';
  if (!dir) {
    dir = await window.api.system.selectOutputDir();
    if (!dir) return;
  }
  if (requestId !== generationRequestId || !lastGeneratedDataUrl) {
    log('The QR content changed before it could be saved. Generate it again.', 'warn');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    const result = await window.api.tools.qrStudio.generateQR({
      ...opts,
      outputDir: dir
    });

    if (result && result.success && typeof result.output === 'string' && result.output) {
      log(`QR code saved to: ${result.output}`, 'success');
      statusText.textContent = 'QR code saved!';
      if (window.showCompletionToast) window.showCompletionToast('QR code saved!', false, [result.output]);
      if (window.addRecentFile) window.addRecentFile(result.output);
      if (window.autoOpenOutputIfEnabled) window.autoOpenOutputIfEnabled(dir);
    } else {
      log(`Save failed: ${result ? result.error : 'unknown error'}`, 'error');
      statusText.textContent = 'Failed to save QR code';
    }
  } catch (err) {
    log(`Save error: ${err.message}`, 'error');
    statusText.textContent = 'Error saving QR code';
  }

  saveBtn.disabled = !lastGeneratedDataUrl || requestId !== generationRequestId;
  saveBtn.textContent = 'Save QR code';
}

async function scanQR(filePath) {
  const ext = getFileExtension(filePath);
  if (!IMAGE_EXTS.has(ext)) {
    log('Not a supported image file', 'warn');
    return;
  }

  const requestId = ++scanRequestId;
  isScanning = true;
  refreshProcessingUi();
  statusText.textContent = 'Scanning QR code...';
  log(`Scanning: ${getFileName(filePath)}`);

  try {
    const result = await window.api.tools.qrStudio.scanQR(filePath);
    if (requestId !== scanRequestId) return;

    const decodedValue = result && (result.data || result.text);
    const decoded = typeof decodedValue === 'string' ? decodedValue : '';
    if (decoded) {
      decodedText.textContent = decoded;
      scanResult.style.display = 'block';
      statusText.textContent = 'QR code decoded!';
      log(`Decoded: "${decoded.substring(0, 80)}${decoded.length > 80 ? '...' : ''}"`, 'success');
    } else {
      scanResult.style.display = 'none';
      statusText.textContent = result && result.error ? result.error : 'No QR code found in image';
      log(result && result.error ? result.error : 'No QR code found in image', 'warn');
    }
  } catch (err) {
    if (requestId !== scanRequestId) return;
    log(`Scan error: ${err.message}`, 'error');
    statusText.textContent = 'Error scanning QR code';
    scanResult.style.display = 'none';
  }

  if (requestId === scanRequestId) {
    isScanning = false;
    refreshProcessingUi();
  }
}

function getFileExtension(fp) {
  const parts = fp.replace(/\\/g, '/').split('/').pop().split('.');
  return parts.length > 1 ? '.' + parts.pop().toLowerCase() : '';
}

function getFileName(fp) { return fp.replace(/\\/g, '/').split('/').pop(); }

window.registerTool('qr-studio', { init, cleanup });

})();

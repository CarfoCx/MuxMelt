// ============================================================================
// QR Studio Tool
// ============================================================================

(function() {

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

let isProcessing = false;
let lastGeneratedDataUrl = null;
let log = null;
let activeTemplate = 'text';

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
  log('QR Studio initialized');
}

function cleanup() {}

function getTemplateText() {
  switch (activeTemplate) {
    case 'url': {
      const url = qrUrl.value.trim();
      return url ? 'https://' + url : '';
    }
    case 'wifi': {
      const ssid = qrWifiSsid.value.trim();
      if (!ssid) return '';
      const sec = qrWifiSecurity.value;
      const pass = qrWifiPass.value;
      if (sec === 'nopass') return `WIFI:T:nopass;S:${ssid};;`;
      return `WIFI:T:${sec};S:${ssid};P:${pass};;`;
    }
    case 'vcard': {
      const name = qrVcardName.value.trim();
      if (!name) return '';
      let card = 'BEGIN:VCARD\nVERSION:3.0\nFN:' + name;
      const phone = qrVcardPhone.value.trim();
      const email = qrVcardEmail.value.trim();
      const org = qrVcardOrg.value.trim();
      if (phone) card += '\nTEL:' + phone;
      if (email) card += '\nEMAIL:' + email;
      if (org) card += '\nORG:' + org;
      card += '\nEND:VCARD';
      return card;
    }
    case 'geo': {
      const lat = qrGeoLat.value.trim();
      const lon = qrGeoLon.value.trim();
      if (!lat || !lon) return '';
      return `geo:${lat},${lon}`;
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

function switchTemplate(name) {
  activeTemplate = name;

  // Update tabs
  document.querySelectorAll('.qr-template-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.template === name);
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
    document.getElementById(id).style.display = key === name ? '' : 'none';
  });
}

let _previewTimer = null;

function schedulePreview() {
  clearTimeout(_previewTimer);
  const text = getTemplateText();
  if (text.length > 0) {
    _previewTimer = setTimeout(() => handleGenerate(), 500);
  }
}

function bindEvents() {
  // Template tab clicks
  document.querySelectorAll('.qr-template-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTemplate(tab.dataset.template));
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
  });

  qrMargin.addEventListener('input', () => {
    qrMarginValue.textContent = qrMargin.value;
  });

  generateBtn.addEventListener('click', handleGenerate);
  saveBtn.addEventListener('click', handleSave);

  clearBtn.addEventListener('click', () => {
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
    switchTemplate('text');
    qrPreviewBox.innerHTML = '<div class="empty-state">QR code preview will appear here</div>';
    scanResult.style.display = 'none';
    decodedText.textContent = '';
    statusText.textContent = 'Waiting for Input';
    lastGeneratedDataUrl = null;
    saveBtn.disabled = true;
    window.clearLog();
  });

  // Scan toggle
  scanToggle.addEventListener('click', () => {
    const visible = scanPanel.style.display !== 'none';
    scanPanel.style.display = visible ? 'none' : 'block';
    scanToggle.textContent = visible ? 'Scan existing QR code' : 'Hide scanner';
  });

  // Scan drop zone
  scanDropZone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); scanDropZone.classList.add('dragover'); });
  scanDropZone.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); scanDropZone.classList.remove('dragover'); });
  scanDropZone.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); scanDropZone.classList.remove('dragover');
    const paths = [];
    for (const file of e.dataTransfer.files) paths.push(file.path);
    if (paths.length > 0) scanQR(paths[0]);
  });

  scanBrowseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const paths = await window.api.selectFiles({ title: 'Select Image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
    if (paths.length > 0) scanQR(paths[0]);
  });

  scanDropZone.addEventListener('click', async (e) => {
    if (e.target.id === 'scanBrowseBtn') return;
    const paths = await window.api.selectFiles({ title: 'Select Image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
    if (paths.length > 0) scanQR(paths[0]);
  });

  copyResultBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(decodedText.textContent).then(() => {
      copyResultBtn.textContent = 'Copied!';
      setTimeout(() => { copyResultBtn.textContent = 'Copy to Clipboard'; }, 2000);
    });
  });
}

async function handleGenerate() {
  const text = getTemplateText();
  if (!text) {
    log('Please fill in the required fields to generate a QR code', 'warn');
    return;
  }
  if (text.length > 2953) {
    log(`Text too long (${text.length} chars). QR codes support max 2,953 characters.`, 'warn');
    return;
  }

  isProcessing = true;
  generateBtn.disabled = true;
  processingIndicator.classList.add('active');
  statusText.textContent = 'Generating QR code...';

  const opts = getQROptions();
  log(`Generating QR code: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}", size=${opts.size}px`);

  try {
    const preview = await window.api.previewQR(opts);

    if (preview && preview.success && preview.dataUrl) {
      qrPreviewBox.innerHTML = `<img src="${preview.dataUrl}" alt="QR Code">`;
      lastGeneratedDataUrl = preview.dataUrl;
      saveBtn.disabled = false;
      log('QR code generated successfully', 'success');
      statusText.textContent = 'QR code generated!';
    } else {
      log(`Generation failed: ${preview ? preview.error : 'unknown error'}`, 'error');
      statusText.textContent = 'Error generating QR code';
    }
  } catch (err) {
    log(`QR generation error: ${err.message}`, 'error');
    statusText.textContent = 'Error generating QR code';
  }

  isProcessing = false;
  generateBtn.disabled = false;
  processingIndicator.classList.remove('active');
}

async function handleSave() {
  if (!lastGeneratedDataUrl) {
    log('Generate a QR code first', 'warn');
    return;
  }

  const text = getTemplateText();
  const opts = getQROptions();

  // Use default output dir if available, otherwise prompt
  let dir = window.getDefaultOutputDir ? window.getDefaultOutputDir() : '';
  if (!dir) {
    dir = await window.api.selectOutputDir();
    if (!dir) return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    const result = await window.api.generateQR({
      ...opts,
      outputDir: dir
    });

    if (result && result.success && result.output) {
      log(`QR code saved to: ${result.output}`, 'success');
      statusText.textContent = 'QR code saved!';
      if (window.showCompletionToast) window.showCompletionToast('QR code saved!');
    } else {
      log(`Save failed: ${result ? result.error : 'unknown error'}`, 'error');
      statusText.textContent = 'Failed to save QR code';
    }
  } catch (err) {
    log(`Save error: ${err.message}`, 'error');
    statusText.textContent = 'Error saving QR code';
  }

  saveBtn.disabled = false;
  saveBtn.textContent = 'Save QR';
}

async function scanQR(filePath) {
  const ext = getFileExtension(filePath);
  if (!IMAGE_EXTS.has(ext)) {
    log('Not a supported image file', 'warn');
    return;
  }

  isProcessing = true;
  processingIndicator.classList.add('active');
  statusText.textContent = 'Scanning QR code...';
  log(`Scanning: ${getFileName(filePath)}`);

  try {
    const result = await window.api.scanQR(filePath);

    const decoded = result && (result.data || result.text);
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
    log(`Scan error: ${err.message}`, 'error');
    statusText.textContent = 'Error scanning QR code';
    scanResult.style.display = 'none';
  }

  isProcessing = false;
  processingIndicator.classList.remove('active');
}

function getFileExtension(fp) {
  const parts = fp.replace(/\\/g, '/').split('/').pop().split('.');
  return parts.length > 1 ? '.' + parts.pop().toLowerCase() : '';
}

function getFileName(fp) { return fp.replace(/\\/g, '/').split('/').pop(); }

window.registerTool('qr-studio', { init, cleanup });

})();

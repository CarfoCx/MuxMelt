// ============================================================================
// Basic Image Editor Tool
// ============================================================================

(function() {

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif']);

let files = [];
let outputDir = '';
let isProcessing = false;
let log = null;
let progressCleanup = null;
let dropZone, browseBtn, fileList, applyBtn, clearBtn, openOutputBtn;
let outputDirBtn, statusText, processingIndicator;
let lastOutputDir = '';
let _pasteHandler = null;

let editorModal, editorOverlay, editorCanvas, editorCtx;
let editorCanvasWrap, cropOverlay;
let currentEditorFile = null;
let editorImg = null;
let editorTool = 'crop';
let canvasScale = 1;

let cropRect = null;
let isCropping = false;
let cropStartX = 0;
let cropStartY = 0;
let cropAspectRatio = null;

let flipH = false;
let flipV = false;

function init(ctx) {
  log = ctx.log;

  dropZone = document.getElementById('dropZone');
  browseBtn = document.getElementById('browseBtn');
  fileList = document.getElementById('fileList');
  applyBtn = document.getElementById('applyBtn');
  clearBtn = document.getElementById('clearBtn');
  outputDirBtn = document.getElementById('outputDirBtn');
  statusText = document.getElementById('statusText');
  processingIndicator = document.getElementById('processingIndicator');
  openOutputBtn = document.getElementById('openOutputBtn');

  editorModal = document.getElementById('editorModal');
  editorOverlay = document.getElementById('editorOverlay');
  editorCanvas = document.getElementById('editorCanvas');
  editorCtx = editorCanvas.getContext('2d');
  editorCanvasWrap = document.getElementById('editorCanvasWrap');
  cropOverlay = document.getElementById('cropOverlay');

  bindEvents();
  bindEditorEvents();
  _pasteHandler = (e) => { if (e.detail && e.detail.length > 0) setImageFromPaths(e.detail); };
  document.addEventListener('paste-files', _pasteHandler);
  if (!outputDir && window.applyDefaultOutputDir) outputDir = window.applyDefaultOutputDir(outputDirBtn);
  log('Basic Image Editor initialized');
}

function cleanup() {
  if (_pasteHandler) { document.removeEventListener('paste-files', _pasteHandler); _pasteHandler = null; }
  if (progressCleanup) { progressCleanup(); progressCleanup = null; }
  closeEditor();
}

function bindEvents() {
  outputDirBtn.addEventListener('click', async () => {
    if (isProcessing) return;
    const dir = await window.api.system.selectOutputDir();
    if (dir) {
      outputDir = dir;
      const display = dir.length > 35 ? '...' + dir.slice(-32) : dir;
      outputDirBtn.textContent = display;
      outputDirBtn.title = dir;
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('dragover');
    const paths = [...e.dataTransfer.files].map(file => window.api.system.getPathForFile(file));
    if (paths.length > 0) {
      const resolved = await window.api.system.resolveDroppedPaths(paths);
      if (resolved.length > 0) setImageFromPaths(resolved);
      else log('No supported image found', 'warn');
    }
  });

  browseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await browseForImage();
  });

  dropZone.addEventListener('click', async (e) => {
    if (dropZone.classList.contains('collapsed')) {
      dropZone.classList.remove('collapsed');
      return;
    }
    if (e.target.id !== 'browseBtn') await browseForImage();
  });

  clearBtn.addEventListener('click', () => {
    if (!isProcessing) {
      clearFiles();
      window.clearLog();
      openOutputBtn.style.display = 'none';
    }
  });

  openOutputBtn.addEventListener('click', () => {
    if (lastOutputDir) window.api.system.openFolder(lastOutputDir);
  });

  applyBtn.addEventListener('click', () => {
    if (!files[0]) {
      log('Select an image first', 'warn');
      return;
    }
    openEditor(0);
  });

  progressCleanup = window.api.tools.onToolProgress((data) => {
    if (data.tool === 'bulk-imager' && data.status) statusText.textContent = data.status;
  });
}

async function browseForImage() {
  const paths = await window.api.system.selectFiles({
    title: 'Select Image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif'] }]
  });
  if (paths.length > 0) setImageFromPaths(paths);
}

function bindEditorEvents() {
  document.getElementById('editorClose').addEventListener('click', closeEditor);
  editorOverlay.addEventListener('click', closeEditor);

  document.querySelectorAll('.editor-tool').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.editor-tool').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.editor-option-panel').forEach(panel => panel.classList.remove('active'));
      btn.classList.add('active');
      editorTool = btn.dataset.tool;
      const panel = document.getElementById(`opt-${editorTool}`);
      if (panel) panel.classList.add('active');
      updateCropOverlay();
      drawEditor();
    });
  });

  editorCanvasWrap.addEventListener('mousedown', onCanvasMouseDown);
  editorCanvasWrap.addEventListener('mousemove', onCanvasMouseMove);
  editorCanvasWrap.addEventListener('mouseup', onCanvasMouseUp);
  editorCanvasWrap.addEventListener('mouseleave', onCanvasMouseUp);

  document.getElementById('cropResetBtn').addEventListener('click', resetCrop);

  document.querySelectorAll('.aspect-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.aspect-btn').forEach(item => item.classList.remove('active'));
      btn.classList.add('active');
      const ratio = btn.dataset.ratio;
      if (ratio === 'free') {
        cropAspectRatio = null;
      } else {
        const [w, h] = ratio.split(':').map(Number);
        cropAspectRatio = w / h;
      }
    });
  });

  document.getElementById('flipH').addEventListener('click', () => {
    flipH = !flipH;
    updateFlipInfo();
    drawEditor();
  });

  document.getElementById('flipV').addEventListener('click', () => {
    flipV = !flipV;
    updateFlipInfo();
    drawEditor();
  });

  document.getElementById('flipResetBtn').addEventListener('click', () => {
    flipH = false;
    flipV = false;
    updateFlipInfo();
    drawEditor();
  });

  document.getElementById('edApplyOne').addEventListener('click', applyToOne);
}

function canvasToImage(clientX, clientY) {
  const rect = editorCanvas.getBoundingClientRect();
  const displayX = Math.round((clientX - rect.left) / canvasScale);
  const displayY = Math.round((clientY - rect.top) / canvasScale);
  return {
    x: flipH ? editorImg.naturalWidth - displayX : displayX,
    y: flipV ? editorImg.naturalHeight - displayY : displayY
  };
}

function onCanvasMouseDown(e) {
  if (editorTool !== 'crop' || !editorImg) return;
  const pos = canvasToImage(e.clientX, e.clientY);
  isCropping = true;
  cropStartX = clamp(pos.x, 0, editorImg.naturalWidth);
  cropStartY = clamp(pos.y, 0, editorImg.naturalHeight);
  cropRect = { x: cropStartX, y: cropStartY, w: 0, h: 0 };
}

function onCanvasMouseMove(e) {
  if (!isCropping || editorTool !== 'crop' || !editorImg) return;
  const pos = canvasToImage(e.clientX, e.clientY);
  let endX = clamp(pos.x, 0, editorImg.naturalWidth);
  let endY = clamp(pos.y, 0, editorImg.naturalHeight);

  if (cropAspectRatio) {
    const rawW = endX - cropStartX;
    const rawH = endY - cropStartY;
    const signW = rawW >= 0 ? 1 : -1;
    const signH = rawH >= 0 ? 1 : -1;
    const absW = Math.abs(rawW);
    const absH = Math.abs(rawH);

    if (absW / cropAspectRatio >= absH) {
      endY = cropStartY + Math.round((absW / cropAspectRatio) * signH);
    } else {
      endX = cropStartX + Math.round((absH * cropAspectRatio) * signW);
    }

    endX = clamp(endX, 0, editorImg.naturalWidth);
    endY = clamp(endY, 0, editorImg.naturalHeight);
  }

  cropRect = {
    x: Math.min(cropStartX, endX),
    y: Math.min(cropStartY, endY),
    w: Math.abs(endX - cropStartX),
    h: Math.abs(endY - cropStartY)
  };
  document.getElementById('cropInfo').textContent = `${cropRect.w} x ${cropRect.h} at (${cropRect.x}, ${cropRect.y})`;
  updateCropOverlay();
  drawEditor();
}

function onCanvasMouseUp() {
  if (!isCropping) return;
  isCropping = false;
  if (cropRect && (cropRect.w < 5 || cropRect.h < 5)) resetCrop();
}

function resetCrop() {
  cropRect = null;
  cropAspectRatio = null;
  document.getElementById('cropInfo').textContent = '-';
  document.querySelectorAll('.aspect-btn').forEach(item => item.classList.remove('active'));
  const freeBtn = document.querySelector('.aspect-btn[data-ratio="free"]');
  if (freeBtn) freeBtn.classList.add('active');
  updateCropOverlay();
  drawEditor();
}

function updateCropOverlay() {
  if (!cropRect || editorTool !== 'crop') {
    cropOverlay.style.display = 'none';
    return;
  }

  const displayRect = getDisplayCropRect();
  const canvasRect = editorCanvas.getBoundingClientRect();
  const wrapRect = editorCanvasWrap.getBoundingClientRect();
  cropOverlay.style.display = 'block';
  cropOverlay.style.left = (canvasRect.left - wrapRect.left + displayRect.x * canvasScale) + 'px';
  cropOverlay.style.top = (canvasRect.top - wrapRect.top + displayRect.y * canvasScale) + 'px';
  cropOverlay.style.width = (displayRect.w * canvasScale) + 'px';
  cropOverlay.style.height = (displayRect.h * canvasScale) + 'px';
}

function updateFlipInfo() {
  const parts = [];
  if (flipH) parts.push('horizontal');
  if (flipV) parts.push('vertical');
  document.getElementById('flipInfo').textContent = parts.length ? `Flip ${parts.join(' + ')}` : 'No flip';
}

function openEditor(fileIndex) {
  currentEditorFile = fileIndex;
  const file = files[fileIndex];
  document.getElementById('editorTitle').textContent = `Edit: ${file.name}`;

  editorTool = 'crop';
  document.querySelectorAll('.editor-tool').forEach(item => item.classList.toggle('active', item.dataset.tool === 'crop'));
  document.querySelectorAll('.editor-option-panel').forEach(panel => panel.classList.toggle('active', panel.id === 'opt-crop'));
  flipH = false;
  flipV = false;
  updateFlipInfo();
  resetCrop();

  editorImg = new Image();
  editorImg.onload = () => {
    document.getElementById('editorImageInfo').textContent = `${editorImg.naturalWidth} x ${editorImg.naturalHeight}`;
    drawEditor();
  };
  editorImg.src = `file://${file.path.replace(/\\/g, '/')}`;

  editorOverlay.classList.add('active');
  editorModal.classList.add('active');
}

function closeEditor() {
  if (editorOverlay) editorOverlay.classList.remove('active');
  if (editorModal) editorModal.classList.remove('active');
  if (cropOverlay) cropOverlay.style.display = 'none';
  currentEditorFile = null;
}

function drawEditor() {
  if (!editorImg || !editorImg.naturalWidth) return;

  const maxW = editorCanvasWrap.clientWidth;
  const maxH = editorCanvasWrap.clientHeight;
  const iw = editorImg.naturalWidth;
  const ih = editorImg.naturalHeight;
  canvasScale = Math.min(maxW / iw, maxH / ih, 1);

  const cw = Math.round(iw * canvasScale);
  const ch = Math.round(ih * canvasScale);
  editorCanvas.width = cw;
  editorCanvas.height = ch;
  editorCtx.clearRect(0, 0, cw, ch);

  editorCtx.save();
  editorCtx.translate(cw / 2, ch / 2);
  editorCtx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  editorCtx.drawImage(editorImg, -cw / 2, -ch / 2, cw, ch);
  editorCtx.restore();

  if (cropRect && editorTool === 'crop') {
    const displayRect = getDisplayCropRect();
    editorCtx.fillStyle = 'rgba(0,0,0,0.5)';
    editorCtx.fillRect(0, 0, cw, displayRect.y * canvasScale);
    const cropBottom = (displayRect.y + displayRect.h) * canvasScale;
    editorCtx.fillRect(0, cropBottom, cw, ch - cropBottom);
    editorCtx.fillRect(0, displayRect.y * canvasScale, displayRect.x * canvasScale, displayRect.h * canvasScale);
    const cropRight = (displayRect.x + displayRect.w) * canvasScale;
    editorCtx.fillRect(cropRight, displayRect.y * canvasScale, cw - cropRight, displayRect.h * canvasScale);
  }

  updateCropOverlay();
}

function getDisplayCropRect() {
  if (!cropRect || !editorImg) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: flipH ? editorImg.naturalWidth - cropRect.x - cropRect.w : cropRect.x,
    y: flipV ? editorImg.naturalHeight - cropRect.y - cropRect.h : cropRect.y,
    w: cropRect.w,
    h: cropRect.h
  };
}

function buildOperationChain() {
  const chain = [];
  if (cropRect && cropRect.w > 0 && cropRect.h > 0) {
    chain.push({
      operation: 'crop',
      operationOptions: {
        left: cropRect.x,
        top: cropRect.y,
        width: cropRect.w,
        height: cropRect.h
      }
    });
  }
  if (flipH) chain.push({ operation: 'flip', operationOptions: { direction: 'horizontal' } });
  if (flipV) chain.push({ operation: 'flip', operationOptions: { direction: 'vertical' } });
  return chain;
}

async function applyToOne() {
  const file = files[currentEditorFile];
  if (!file) return;

  const chain = buildOperationChain();
  if (chain.length === 0) {
    log('Choose a crop area or flip the image before exporting', 'warn');
    return;
  }

  log(`Exporting ${file.name}...`);
  isProcessing = true;
  applyBtn.disabled = true;
  file.state = 'processing';
  file.status = 'Processing...';
  file.progress = 0;
  renderFileList();
  processingIndicator.classList.add('active');
  statusText.textContent = 'Exporting image...';
  if (window.updateQueueSummary) window.updateQueueSummary(files);

  try {
    const result = chain.length === 1
      ? await window.api.tools.bulkImager.bulkProcess({
          files: [file.path],
          operation: chain[0].operation,
          operationOptions: chain[0].operationOptions,
          outputDir
        })
      : await window.api.tools.bulkImager.bulkProcessChain({
          files: [file.path],
          chain,
          outputDir
        });

    const first = result && result.results && result.results[0];
    if (result && result.success && (!first || first.success)) {
      file.state = 'complete';
      file.progress = 1;
      file.status = 'Complete';
      const output = first && first.output ? first.output : '';
      if (output) {
        lastOutputDir = output.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        if (window.addRecentFile) window.addRecentFile(output);
      } else {
        lastOutputDir = outputDir || file.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      }
      openOutputBtn.style.display = '';
      log(`Exported: ${output || file.name}`, 'success');
      statusText.textContent = 'Image exported';
      if (window.showCompletionToast) window.showCompletionToast('Image exported successfully', false, output ? [output] : []);
      if (window.autoOpenOutputIfEnabled) window.autoOpenOutputIfEnabled(lastOutputDir);
    } else {
      const error = first && first.error ? first.error : (result ? result.error : 'unknown');
      file.state = 'error';
      file.status = `Error: ${error}`;
      statusText.textContent = 'Export failed';
      log(`Error: ${error}`, 'error');
    }
  } catch (err) {
    file.state = 'error';
    file.status = `Error: ${err.message}`;
    statusText.textContent = 'Export failed';
    log(`Error: ${err.message}`, 'error');
  }

  renderFileList();
  isProcessing = false;
  processingIndicator.classList.remove('active');
  updateButton();
  closeEditor();
}

function getFileExtension(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/').pop().split('.');
  return parts.length > 1 ? '.' + parts.pop().toLowerCase() : '';
}

function getFileName(filePath) {
  return filePath.replace(/\\/g, '/').split('/').pop();
}

async function setImageFromPaths(paths) {
  const selected = paths.find(path => IMAGE_EXTS.has(getFileExtension(path)));
  if (!selected) {
    log('No supported image found', 'warn');
    return;
  }

  const size = await window.api.system.getFileSize(selected);
  files = [{ path: selected, name: getFileName(selected), size, progress: 0, status: 'Active', state: 'pending' }];
  lastOutputDir = '';
  openOutputBtn.style.display = 'none';
  statusText.textContent = 'Image selected';
  log(`Selected image: ${getFileName(selected)}`);
  renderFileList();
  updateButton();
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, files.length);
}

function removeFile(index) {
  files.splice(index, 1);
  renderFileList();
  updateButton();
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, files.length);
  if (files.length === 0 && window.updateQueueSummary) window.updateQueueSummary([]);
}

function clearFiles() {
  files = [];
  renderFileList();
  updateButton();
  statusText.textContent = 'Waiting for Image';
  if (window.updateQueueSummary) window.updateQueueSummary([]);
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, 0);
}

function updateButton() {
  applyBtn.disabled = files.length === 0 || isProcessing;
}

function renderFileList() {
  if (files.length === 0) {
    fileList.innerHTML = '<div class="empty-state">No image selected. Drag one image here, browse, or press <span class="shortcut-hint">Ctrl+O</span></div>';
    return;
  }
  fileList.innerHTML = '';
  files.forEach((file, index) => fileList.appendChild(createFileElement(file, index)));
  if (window.updateQueueSummary) window.updateQueueSummary(files);
}

function createFileElement(file, index) {
  const el = document.createElement('div');
  el.className = 'file-item file-editable';
  const progressClass = file.state === 'complete' ? ' complete' : file.state === 'error' ? ' error' : '';

  el.innerHTML = `
    <img class="file-thumb" data-path="${window.escapeHtml(file.path)}" src="" alt="">
    <div class="file-info">
      <div class="file-name" title="${window.escapeHtml(file.path)}">${window.escapeHtml(file.name)}<span class="file-edit-badge">click to edit</span></div>
      <div class="file-status">${window.escapeHtml(file.status)}</div>
    </div>
    ${file.size ? `<span class="file-size">${window.formatFileSize(file.size)}</span>` : ''}
    <div class="file-progress-bar">
      <div class="file-progress-fill${progressClass}" style="width: ${Math.round(file.progress * 100)}%"></div>
    </div>
    <button class="file-remove" data-index="${index}" title="Remove">&times;</button>`;

  const thumb = el.querySelector('.file-thumb');
  if (thumb) {
    window.getFileThumbnail(file.path).then(url => { if (url) thumb.src = url; });
  }

  el.addEventListener('click', (e) => {
    if (e.target.closest('.file-remove')) return;
    if (!isProcessing) openEditor(index);
  });
  el.querySelector('.file-remove').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!isProcessing) removeFile(index);
  });

  el.addEventListener('contextmenu', (e) => {
    if (window.showFileContextMenu) {
      window.showFileContextMenu(e, file.path, isProcessing ? null : () => removeFile(index));
    }
  });

  return el;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

window.registerTool('bulk-imager', { init, cleanup });

})();

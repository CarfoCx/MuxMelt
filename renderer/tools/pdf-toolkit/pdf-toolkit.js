// ============================================================================
// PDF Toolkit Tool
// ============================================================================

(function() {

let files = [];
let outputDir = '';
let currentOp = 'merge';
let isProcessing = false;
let log = null;
let progressCleanup = null;
let dragSrcIndex = null;

let dropZone, browseBtn, fileList, actionBtn, clearBtn, openOutputBtn;
let outputDirBtn, statusText, processingIndicator, pageRange;
let lastOutputDir = '';
let _pasteHandler = null;

let launchEditorBtn, redactTerms;
let pdfEditorOverlay, closeEditorBtn, editorFileName, pagesContainer, editorSidebar, editorLoading;
let toolSelect, toolRedact, toolText, textColorPicker, textSizeSelect, editorStatusText, editorPageInfo;
let editorApplyBtn, editorClearBtn;

let currentEditorFile = null;
let editorPages = [];
let editorActions = { rects: [], edits: [] };
let currentTool = 'select';
let activePageIdx = 0;
let isDrawing = false;
let startPos = { x: 0, y: 0 };
let currentDrawingBox = null;

function init(ctx) {
  log = ctx.log;

  dropZone = document.getElementById('dropZone');
  browseBtn = document.getElementById('browseBtn');
  fileList = document.getElementById('fileList');
  actionBtn = document.getElementById('actionBtn');
  clearBtn = document.getElementById('clearBtn');
  outputDirBtn = document.getElementById('outputDirBtn');
  statusText = document.getElementById('statusText');
  processingIndicator = document.getElementById('processingIndicator');
  pageRange = document.getElementById('pageRange');
  redactTerms = document.getElementById('redactTerms');
  openOutputBtn = document.getElementById('openOutputBtn');
  launchEditorBtn = document.getElementById('launchEditorBtn');

  // Editor elements
  pdfEditorOverlay = document.getElementById('pdfEditorOverlay');
  closeEditorBtn = document.getElementById('closeEditorBtn');
  editorFileName = document.getElementById('editorFileName');
  pagesContainer = document.getElementById('pagesContainer');
  editorSidebar = document.getElementById('editorSidebar');
  editorLoading = document.getElementById('editorLoading');
  toolSelect = document.getElementById('toolSelect');
  toolRedact = document.getElementById('toolRedact');
  toolText = document.getElementById('toolText');
  textColorPicker = document.getElementById('textColorPicker');
  textSizeSelect = document.getElementById('textSizeSelect');
  editorStatusText = document.getElementById('editorStatusText');
  editorPageInfo = document.getElementById('editorPageInfo');
  editorApplyBtn = document.getElementById('editorApplyBtn');
  editorClearBtn = document.getElementById('editorClearBtn');

  bindEvents();
  bindEditorEvents();

  _pasteHandler = (e) => { if (e.detail && e.detail.length > 0) addFiles(e.detail); };
  document.addEventListener('paste-files', _pasteHandler);
  if (!outputDir && window.applyDefaultOutputDir) outputDir = window.applyDefaultOutputDir(outputDirBtn);
  log('PDF Toolkit initialized');
}

function cleanup() {
  if (_pasteHandler) { document.removeEventListener('paste-files', _pasteHandler); _pasteHandler = null; }
  if (progressCleanup) { progressCleanup(); progressCleanup = null; }
}

function bindEvents() {
  // Tab switching
  document.querySelectorAll('.op-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (isProcessing) return;
      document.querySelectorAll('.op-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.op-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      currentOp = tab.dataset.op;
      const panel = document.getElementById(`panel-${currentOp}`);
      if (panel) panel.classList.add('active');
      updateActionButton();
      renderFileList();
    });
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

  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('dragover'); });
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('dragover');
    const paths = [];
    for (const file of e.dataTransfer.files) paths.push(file.path);
    if (paths.length > 0) {
      const resolved = await window.api.resolveDroppedPaths(paths);
      if (resolved.length > 0) addFiles(resolved);
      else log('No PDF files found', 'warn');
    }
  });

  const pdfFileOptions = {
    title: 'Select PDF Files',
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
  };

  browseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const paths = await window.api.selectFiles(pdfFileOptions);
    if (paths.length > 0) addFiles(paths);
  });

  dropZone.addEventListener('click', async (e) => {
    if (dropZone.classList.contains('collapsed')) { dropZone.classList.remove('collapsed'); return; }
    if (e.target.id === 'browseBtn') return;
    const paths = await window.api.selectFiles(pdfFileOptions);
    if (paths.length > 0) addFiles(paths);
  });

  clearBtn.addEventListener('click', () => {
    if (!isProcessing) { clearFiles(); window.clearLog(); openOutputBtn.style.display = 'none'; }
  });

  openOutputBtn.addEventListener('click', () => {
    if (lastOutputDir) window.api.openFolder(lastOutputDir);
  });

  actionBtn.addEventListener('click', startOperation);

  launchEditorBtn.addEventListener('click', openEditor);

  progressCleanup = window.api.onToolProgress((data) => {
    if (data.tool !== 'pdf-toolkit') return;
    handleProgress(data);
  });
}

function bindEditorEvents() {
  closeEditorBtn.addEventListener('click', closeEditor);
  
  toolSelect.addEventListener('click', () => setTool('select'));
  toolRedact.addEventListener('click', () => setTool('redact'));
  toolText.addEventListener('click', () => setTool('text'));
  
  editorClearBtn.addEventListener('click', () => {
    editorActions = { rects: [], edits: [] };
    renderEditorActions();
  });
  
  editorApplyBtn.addEventListener('click', async () => {
    if (isProcessing) return;
    closeEditor();
    startOperation();
  });
}

function setTool(tool) {
  currentTool = tool;
  toolSelect.classList.toggle('active', tool === 'select');
  toolRedact.classList.toggle('active', tool === 'redact');
  toolText.classList.toggle('active', tool === 'text');
  
  const toolNames = { select: 'Selection Mode', redact: 'Redaction Tool (Click & Drag)', text: 'Add Text Tool (Click anywhere)' };
  editorStatusText.textContent = toolNames[tool];
}

async function openEditor() {
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error');
  if (pending.length === 0) return;
  
  currentEditorFile = pending[0];
  editorFileName.textContent = currentEditorFile.name;
  pdfEditorOverlay.style.display = 'flex';
  
  editorLoading.style.display = 'flex';
  pagesContainer.innerHTML = '';
  editorSidebar.innerHTML = '';
  editorActions = { rects: [], edits: [] };
  setTool('select');
  
  try {
    const result = await window.api.pdfOperation({
      operation: 'render',
      files: [currentEditorFile.path],
      dpi: 150
    });
    
    if (result && result.success) {
      editorPages = result.pages;
      renderEditorPages();
      editorPageInfo.textContent = `Page 1 of ${editorPages.length}`;
    } else {
      throw new Error(result.error || 'Failed to render PDF');
    }
  } catch (err) {
    log('Editor error: ' + err.message, 'error');
    closeEditor();
  } finally {
    editorLoading.style.display = 'none';
  }
}

function closeEditor() {
  pdfEditorOverlay.style.display = 'none';
}

function renderEditorPages() {
  pagesContainer.innerHTML = '';
  editorSidebar.innerHTML = '';
  
  editorPages.forEach(async (page, idx) => {
    // Page in main viewer
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrapper';
    wrapper.dataset.index = idx;
    
    const img = document.createElement('img');
    img.className = 'pdf-page-img';
    
    const overlay = document.createElement('div');
    overlay.className = 'pdf-page-overlay';
    
    wrapper.appendChild(img);
    wrapper.appendChild(overlay);
    pagesContainer.appendChild(wrapper);
    
    // Thumbnail in sidebar
    const thumb = document.createElement('div');
    thumb.className = 'thumb-item' + (idx === 0 ? ' active' : '');
    const thumbImg = document.createElement('img');
    thumb.appendChild(thumbImg);
    const thumbLabel = document.createElement('div');
    thumbLabel.className = 'thumb-label';
    thumbLabel.textContent = `Page ${idx + 1}`;
    thumb.appendChild(thumbLabel);
    
    thumb.addEventListener('click', () => {
      wrapper.scrollIntoView({ behavior: 'smooth' });
      updateActiveThumb(idx);
    });
    editorSidebar.appendChild(thumb);
    
    // Securely load local images via IPC
    try {
      const dataUrl = await window.api.readImagePreview(page.path);
      img.src = dataUrl;
      thumbImg.src = dataUrl;
    } catch (err) {
      console.error('Failed to load PDF page image:', err);
    }
    
    // Interaction logic
    overlay.addEventListener('mousedown', (e) => handlePageMouseDown(e, idx, overlay));
    overlay.addEventListener('mousemove', (e) => handlePageMouseMove(e, idx, overlay));
    window.addEventListener('mouseup', handlePageMouseUp);
  });
}

function updateActiveThumb(idx) {
  const thumbs = editorSidebar.querySelectorAll('.thumb-item');
  thumbs.forEach((t, i) => t.classList.toggle('active', i === idx));
  editorPageInfo.textContent = `Page ${idx + 1} of ${editorPages.length}`;
}

function handlePageMouseDown(e, pageIdx, overlay) {
  const rect = overlay.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  
  if (currentTool === 'redact') {
    isDrawing = true;
    startPos = { x, y };
    currentDrawingBox = document.createElement('div');
    currentDrawingBox.className = 'redaction-box';
    currentDrawingBox.style.left = x + 'px';
    currentDrawingBox.style.top = y + 'px';
    overlay.appendChild(currentDrawingBox);
  } else if (currentTool === 'text') {
    const text = prompt('Enter text to add:');
    if (text) {
      const page = editorPages[pageIdx];
      const scaleX = page.width / rect.width;
      const scaleY = page.height / rect.height;
      
      const hexColor = textColorPicker.value;
      const r = parseInt(hexColor.slice(1, 3), 16);
      const g = parseInt(hexColor.slice(3, 5), 16);
      const b = parseInt(hexColor.slice(5, 7), 16);
      
      editorActions.edits.push({
        text,
        page: pageIdx + 1,
        x: x * scaleX,
        y: y * scaleY,
        size: parseInt(textSizeSelect.value, 10),
        color: [r, g, b],
        // UI only props
        uiX: x,
        uiY: y,
        uiColor: hexColor
      });
      renderEditorActions();
    }
  }
}

function handlePageMouseMove(e, pageIdx, overlay) {
  if (!isDrawing || !currentDrawingBox) return;
  
  const rect = overlay.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
  
  const left = Math.min(startPos.x, x);
  const top = Math.min(startPos.y, y);
  const width = Math.abs(startPos.x - x);
  const height = Math.abs(startPos.y - y);
  
  currentDrawingBox.style.left = left + 'px';
  currentDrawingBox.style.top = top + 'px';
  currentDrawingBox.style.width = width + 'px';
  currentDrawingBox.style.height = height + 'px';
}

function handlePageMouseUp() {
  if (isDrawing && currentDrawingBox) {
    const overlay = currentDrawingBox.parentElement;
    const pageIdx = parseInt(overlay.parentElement.dataset.index, 10);
    const rect = overlay.getBoundingClientRect();
    const page = editorPages[pageIdx];
    
    const scaleX = page.width / rect.width;
    const scaleY = page.height / rect.height;
    
    const left = parseFloat(currentDrawingBox.style.left);
    const top = parseFloat(currentDrawingBox.style.top);
    const width = parseFloat(currentDrawingBox.style.width);
    const height = parseFloat(currentDrawingBox.style.height);
    
    if (width > 5 && height > 5) {
      editorActions.rects.push({
        page: pageIdx + 1,
        x: left * scaleX,
        y: top * scaleY,
        w: width * scaleX,
        h: height * scaleY,
        // UI only props
        uiX: left,
        uiY: top,
        uiW: width,
        uiH: height
      });
    }
    
    currentDrawingBox.remove();
    currentDrawingBox = null;
    renderEditorActions();
  }
  isDrawing = false;
}

function renderEditorActions() {
  // Clear existing UI elements
  document.querySelectorAll('.redaction-box, .text-edit-item').forEach(el => el.remove());
  
  const pages = pagesContainer.querySelectorAll('.pdf-page-wrapper');
  
  editorActions.rects.forEach((rect, idx) => {
    const pageEl = pages[rect.page - 1];
    if (!pageEl) return;
    const overlay = pageEl.querySelector('.pdf-page-overlay');
    
    const box = document.createElement('div');
    box.className = 'redaction-box';
    box.style.left = rect.uiX + 'px';
    box.style.top = rect.uiY + 'px';
    box.style.width = rect.uiW + 'px';
    box.style.height = rect.uiH + 'px';
    
    const removeBtn = document.createElement('div');
    removeBtn.className = 'box-remove';
    removeBtn.innerHTML = '\u00D7';
    removeBtn.onclick = (e) => { e.stopPropagation(); editorActions.rects.splice(idx, 1); renderEditorActions(); };
    box.appendChild(removeBtn);
    
    overlay.appendChild(box);
  });
  
  editorActions.edits.forEach((edit, idx) => {
    const pageEl = pages[edit.page - 1];
    if (!pageEl) return;
    const overlay = pageEl.querySelector('.pdf-page-overlay');
    
    const box = document.createElement('div');
    box.className = 'text-edit-item';
    box.style.left = edit.uiX + 'px';
    box.style.top = edit.uiY + 'px';
    box.style.color = edit.uiColor;
    box.style.fontSize = (edit.size * 0.75) + 'px'; // approx conversion from pt to px for UI
    box.textContent = edit.text;
    
    const removeBtn = document.createElement('div');
    removeBtn.className = 'box-remove';
    removeBtn.innerHTML = '\u00D7';
    removeBtn.onclick = (e) => { e.stopPropagation(); editorActions.edits.splice(idx, 1); renderEditorActions(); };
    box.appendChild(removeBtn);
    
    overlay.appendChild(box);
  });
}

function updateActionButton() {
  const labels = { merge: 'Merge', split: 'Split', extract: 'Extract', edit: 'Save Edited PDF' };
  actionBtn.textContent = labels[currentOp] || 'Process';
  const hasPending = files.some(f => f.state === 'pending' || f.state === 'error');
  const hasRequiredFiles = currentOp === 'merge' ? files.length >= 2 : files.length >= 1;
  actionBtn.disabled = !hasPending || !hasRequiredFiles || isProcessing;
  
  if (launchEditorBtn) {
    launchEditorBtn.disabled = !hasPending || files.length === 0 || isProcessing;
  }
}

async function startOperation() {
  if (isProcessing) return;
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error');
  if (pending.length === 0) return;
  const processedFiles = currentOp === 'merge' ? files : pending.slice(0, 1);

  isProcessing = true;
  actionBtn.disabled = true;
  if (launchEditorBtn) launchEditorBtn.disabled = true;
  processingIndicator.classList.add('active');
  statusText.textContent = `Processing...`;

  processedFiles.forEach(f => { f.state = 'processing'; f.progress = 0; f.status = 'Queued...'; });
  renderFileList();

  const filePaths = processedFiles.map(f => f.path);

  const pdfOpts = {
    files: filePaths,
    operation: currentOp,
    outputDir: outputDir
  };
  
  if (currentOp === 'extract') {
    if (!pageRange.value.trim()) {
      log('Please enter a page range (e.g. 1-3, 5, 8-10)', 'warn');
      finishProcessingWithError('Page range required');
      return;
    }
    pdfOpts.pageRange = pageRange.value.trim();
  }
  
  if (currentOp === 'edit') {
    pdfOpts.redactTerms = redactTerms ? redactTerms.value : '';
    pdfOpts.rects = editorActions.rects;
    pdfOpts.edits = editorActions.edits;
    
    if (!pdfOpts.redactTerms.trim() && pdfOpts.rects.length === 0 && pdfOpts.edits.length === 0) {
      log('Add a redaction term or use the Interactive Editor before saving.', 'warn');
      finishProcessingWithError('No changes specified');
      return;
    }
  }

  log(`Starting PDF ${currentOp}: ${filePaths.length} file(s)`);

  try {
    const result = await window.api.pdfOperation(pdfOpts);

    if (result && result.success) {
      processedFiles.forEach(f => { f.state = 'complete'; f.progress = 1; f.status = 'Complete'; });
      if (result.output) {
        lastOutputDir = result.output.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        log(`Output: ${result.output}`, 'success');
        if (currentOp === 'edit') {
          log(`PDF edits applied: ${result.redactions || 0} redactions, ${result.textEdits || 0} text additions`, 'success');
        }
      }
      if (result.outputs) {
        if (result.outputs.length > 0) lastOutputDir = result.outputs[0].replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        log(`Created ${result.outputs.length} files`, 'success');
      }
    } else if (result && result.error) {
      processedFiles.forEach(f => { f.state = 'error'; f.progress = 0; f.status = `Error: ${result.error}`; });
      log(`Error: ${result.error}`, 'error');
    }
    renderFileList();
  } catch (err) {
    log(`PDF operation error: ${err.message}`, 'error');
    processedFiles.forEach(f => { f.state = 'error'; f.progress = 0; f.status = `Error: ${err.message}`; });
    renderFileList();
  }

  isProcessing = false;
  processingIndicator.classList.remove('active');
  const completed = files.filter(f => f.state === 'complete').length;
  const errors = files.filter(f => f.state === 'error').length;
  statusText.textContent = `Done! ${completed} processed${errors > 0 ? `, ${errors} failed` : ''}`;
  if (completed > 0 && lastOutputDir) openOutputBtn.style.display = '';
  log(`PDF ${currentOp} finished: ${completed} completed, ${errors} failed`, errors > 0 ? 'warn' : 'success');
  if (window.showCompletionToast) window.showCompletionToast('PDF ' + currentOp + ' complete', errors > 0);
  if (window.autoOpenOutputIfEnabled) window.autoOpenOutputIfEnabled(lastOutputDir);
  updateActionButton();
}

function finishProcessingWithError(msg) {
  isProcessing = false;
  processingIndicator.classList.remove('active');
  statusText.textContent = msg;
  updateActionButton();
}

function handleProgress(data) {
  const idx = files.findIndex(f => f.path === data.file);
  if (idx === -1 && data.type !== 'all_complete') return;

  if (data.type === 'progress' && idx !== -1) {
    files[idx].progress = data.progress;
    files[idx].status = data.status || 'Processing...';
    files[idx].state = 'processing';
    renderFileItem(idx);
  } else if (data.type === 'complete' && idx !== -1) {
    files[idx].progress = 1;
    files[idx].status = 'Complete';
    files[idx].state = 'complete';
    log(`Complete: ${files[idx].name}`, 'success');
    renderFileItem(idx);
  } else if (data.type === 'error' && idx !== -1) {
    files[idx].progress = 0;
    files[idx].status = `Error: ${data.error}`;
    files[idx].state = 'error';
    log(`Error [${files[idx].name}]: ${data.error}`, 'error');
    renderFileItem(idx);
  }
}

// ---- File management ----
function getFileExtension(fp) {
  const parts = fp.replace(/\\/g, '/').split('/').pop().split('.');
  return parts.length > 1 ? '.' + parts.pop().toLowerCase() : '';
}

function getFileName(fp) { return fp.replace(/\\/g, '/').split('/').pop(); }

async function addFiles(paths) {
  let added = 0;
  for (const p of paths) {
    const ext = getFileExtension(p);
    if (ext !== '.pdf') continue;
    if (files.some(f => f.path === p)) continue;
    const size = await window.api.getFileSize(p);
    files.push({ path: p, name: getFileName(p), size, progress: 0, status: 'Waiting for PDF', state: 'pending' });
    // Fetch page count asynchronously
    window.api.pdfInfo(p).then(info => {
      if (info && (info.pages || info.pageCount)) {
        const f = files.find(f2 => f2.path === p);
        const pages = info.pages || info.pageCount;
        if (f) { f.pages = pages; f.status = `${pages} pages`; }
        renderFileList();
      }
    }).catch(() => {});
    added++;
  }
  if (added > 0) log(`Added ${added} PDF file(s)`);
  renderFileList();
  updateActionButton();
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, files.length);
}

function removeFile(index) { files.splice(index, 1); renderFileList(); updateActionButton(); }

function clearFiles() {
  files = [];
  renderFileList();
  updateActionButton();
  statusText.textContent = 'Waiting for PDF';
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, 0);
  if (window.updateQueueSummary) window.updateQueueSummary([]);
}

// ---- Reorder (merge mode) ----
function handleDragStart(e, index) {
  dragSrcIndex = index;
  e.target.closest('.file-item').classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragOver(e, index) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const items = fileList.querySelectorAll('.file-item');
  items.forEach(item => item.classList.remove('drag-over'));
  if (index !== dragSrcIndex) {
    items[index].classList.add('drag-over');
  }
}

function handleDrop(e, index) {
  e.preventDefault();
  const items = fileList.querySelectorAll('.file-item');
  items.forEach(item => { item.classList.remove('dragging'); item.classList.remove('drag-over'); });
  if (dragSrcIndex !== null && dragSrcIndex !== index) {
    const moved = files.splice(dragSrcIndex, 1)[0];
    files.splice(index, 0, moved);
    renderFileList();
    log(`Reordered: ${moved.name}`);
  }
  dragSrcIndex = null;
}

function handleDragEnd() {
  const items = fileList.querySelectorAll('.file-item');
  items.forEach(item => { item.classList.remove('dragging'); item.classList.remove('drag-over'); });
  dragSrcIndex = null;
}

// ---- Rendering ----
function renderFileList() {
  if (files.length === 0) {
    fileList.innerHTML = '<div class="empty-state">No files added. Drag files here, browse, or press <span class="shortcut-hint">Ctrl+O</span></div>';
    return;
  }
  fileList.innerHTML = '';
  files.forEach((f, i) => fileList.appendChild(createFileElement(f, i)));
  if (window.updateQueueSummary) window.updateQueueSummary(files);
}

function renderFileItem(index) {
  if (window.updateQueueSummary) window.updateQueueSummary(files);
  const existing = fileList.children[index];
  if (!existing) return;
  fileList.replaceChild(createFileElement(files[index], index), existing);
}

function createFileElement(file, index) {
  const el = document.createElement('div');
  el.className = 'file-item';

  let progressClass = '';
  if (file.state === 'complete') progressClass = ' complete';
  else if (file.state === 'error') progressClass = ' error';

  const isMerge = currentOp === 'merge';
  const dragHandle = isMerge ? `<span class="file-drag-handle" title="Drag to reorder">\u2630</span>` : '';
  const orderNum = isMerge ? `<span class="file-order-num">${index + 1}</span>` : '';

  el.innerHTML = `
    ${dragHandle}
    ${orderNum}
    <span class="file-icon">\u{1F4C4}</span>
    <div class="file-info">
      <div class="file-name" title="${window.escapeHtml(file.path)}">${window.escapeHtml(file.name)}</div>
      <div class="file-status">${window.escapeHtml(file.status)}</div>
    </div>
    ${file.size ? `<span class="file-size">${window.formatFileSize(file.size)}</span>` : ''}
    <div class="file-progress-bar">
      <div class="file-progress-fill${progressClass}" style="width: ${Math.round(file.progress * 100)}%"></div>
    </div>
    <button class="file-remove" data-index="${index}" title="Remove">\u00D7</button>`;

  el.querySelector('.file-remove').addEventListener('click', (e) => { e.stopPropagation(); if (!isProcessing) removeFile(index); });

  // Enable drag reorder in merge mode
  if (isMerge && !isProcessing) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => handleDragStart(e, index));
    el.addEventListener('dragover', (e) => handleDragOver(e, index));
    el.addEventListener('drop', (e) => handleDrop(e, index));
    el.addEventListener('dragend', handleDragEnd);
  }

  el.addEventListener('contextmenu', (e) => {
    if (window.showFileContextMenu) {
      window.showFileContextMenu(e, file.path, isProcessing ? null : () => removeFile(index));
    }
  });

  return el;
}

window.registerTool('pdf-toolkit', { init, cleanup });

})();

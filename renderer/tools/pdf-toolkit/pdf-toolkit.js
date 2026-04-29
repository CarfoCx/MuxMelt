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
let redactTerms, editText, editPage, editX, editY, editSize;
let lastOutputDir = '';
let _pasteHandler = null;

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
  editText = document.getElementById('editText');
  editPage = document.getElementById('editPage');
  editX = document.getElementById('editX');
  editY = document.getElementById('editY');
  editSize = document.getElementById('editSize');
  openOutputBtn = document.getElementById('openOutputBtn');

  bindEvents();
  _pasteHandler = (e) => { if (e.detail && e.detail.length > 0) addFiles(e.detail); };
  document.addEventListener('paste-files', _pasteHandler);
  if (!outputDir && window.applyDefaultOutputDir) outputDir = window.applyDefaultOutputDir(outputDirBtn);
  log('PDF Toolkit ready');
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

  progressCleanup = window.api.onToolProgress((data) => {
    if (data.tool !== 'pdf-toolkit') return;
    handleProgress(data);
  });
}

function updateActionButton() {
  const labels = { merge: 'Merge', split: 'Split', extract: 'Extract', edit: 'Save Edited PDF' };
  actionBtn.textContent = labels[currentOp] || 'Process';
  const hasPending = files.some(f => f.state === 'pending' || f.state === 'error');
  const hasRequiredFiles = currentOp === 'merge' ? files.length >= 2 : files.length >= 1;
  actionBtn.disabled = !hasPending || !hasRequiredFiles || isProcessing;
}

async function startOperation() {
  if (isProcessing) return;
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error');
  if (pending.length === 0) return;
  const processedFiles = currentOp === 'merge' ? files : pending.slice(0, 1);

  isProcessing = true;
  actionBtn.disabled = true;
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
      isProcessing = false;
      processingIndicator.classList.remove('active');
      statusText.textContent = 'Ready';
      updateActionButton();
      return;
    }
    pdfOpts.pageRange = pageRange.value.trim();
  }
  if (currentOp === 'edit') {
    pdfOpts.redactTerms = redactTerms ? redactTerms.value : '';
    pdfOpts.textEdit = {
      text: editText ? editText.value : '',
      page: editPage ? editPage.value : '1',
      x: editX ? editX.value : '72',
      y: editY ? editY.value : '72',
      size: editSize ? editSize.value : '12'
    };
    if (!pdfOpts.redactTerms.trim() && !pdfOpts.textEdit.text.trim()) {
      log('Add a redaction term or text edit before saving.', 'warn');
      isProcessing = false;
      processingIndicator.classList.remove('active');
      statusText.textContent = 'Ready';
      updateActionButton();
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
          log(`Secure redactions applied: ${result.redactions || 0}; text edits: ${result.textEdits || 0}`, 'success');
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
    files.push({ path: p, name: getFileName(p), size, progress: 0, status: 'Ready', state: 'pending' });
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
  statusText.textContent = 'Ready';
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, 0);
  if (window.updateFileCount) window.updateFileCount(0);
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
  if (window.updateFileCount) window.updateFileCount(files.length);
}

function renderFileItem(index) {
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

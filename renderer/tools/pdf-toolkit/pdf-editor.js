// ============================================================================
// MuxMelt PDF Editor
// ============================================================================

(function() {

const params = new URLSearchParams(window.location.search);
const sessionId = params.get('sessionId');

let session = null;
let pages = [];
let actions = [];
let undoStack = [];  // snapshots of actions[] for multi-level undo
let redoStack = [];
let textMap = [];    // text items from text-map API — snapshotted once at session open
let textMapFetched = false;
let activeTool = 'select';
let zoom = 1.0;
let draft = null;

const MAX_CANVAS_PX = 4096; // guard against OOM on very large pages

// Drawing state
let isDrawing = false;
let currentPath = [];
let canvas = null;
let ctx = null;

// Inline editor state
let activeInlineEditor = null;

// UI Elements
const documentName = document.getElementById('documentName');
const documentStatus = document.getElementById('documentStatus');
const thumbs = document.getElementById('thumbs');
const pagesEl = document.getElementById('pages');
const loadingState = document.getElementById('loadingState');
const activeToolLabel = document.getElementById('activeToolLabel');
const changeList = document.getElementById('changeList');
const zoomValue = document.getElementById('zoomValue');

// Property Controls
const textColor = document.getElementById('textColor');
const textSize = document.getElementById('textSize');
const strokeColor = document.getElementById('strokeColor');
const fillColor = document.getElementById('fillColor');
const strokeWidth = document.getElementById('strokeWidth');
const shapeOpacity = document.getElementById('shapeOpacity');

const propSectionText = document.getElementById('propSectionText');
const propSectionShape = document.getElementById('propSectionShape');

const TOOL_LABELS = {
  select: 'Select',
  hand: 'Hand',
  text: 'Text',
  highlight: 'Highlight',
  freehand: 'Signature',
  line: 'Line',
  arrow: 'Arrow',
  rect: 'Rectangle',
  circle: 'Circle',
  redact: 'Secure Redact',
  whiteout: 'Whiteout',
  replace: 'Edit Text'
};

// ============================================================================
// Undo / Redo
// ============================================================================

function cloneActions(arr) {
  return structuredClone(arr);
}

function saveUndoSnapshot() {
  undoStack.push(cloneActions(actions));
  redoStack = [];
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(cloneActions(actions));
  actions = undoStack.pop();
  renderActions();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(cloneActions(actions));
  actions = redoStack.pop();
  renderActions();
}

// ============================================================================
// Coordinate helpers
// ============================================================================

// Convert screen drawing rect (unzoomed pixels inside overlay) to PDF payload.
// PyMuPDF's "PDF-space" for annotation placement uses bottom-left origin, so
// we flip Y here. All shape annotations go through this path.
function screenRectToPdfPayload(left, top, width, height, page, overlay) {
  const scaleX = page.width / overlay.clientWidth;
  const scaleY = page.height / overlay.clientHeight;
  return {
    page: page.index,
    x: left * scaleX,
    y: page.height - (top + height) * scaleY,
    w: width * scaleX,
    h: height * scaleY,
    uiX: left, uiY: top, uiW: width, uiH: height
  };
}

// Convert a text-map item's PDF coordinates to screen pixel positions.
// PyMuPDF stores text coords with top-left origin (no Y flip needed here).
function pdfItemToScreen(item, page, pageEl) {
  const scaleX = pageEl.clientWidth / page.width;
  const scaleY = pageEl.clientHeight / page.height;
  return {
    x: item.x * scaleX,
    y: item.y * scaleY,
    w: item.w * scaleX,
    h: item.h * scaleY
  };
}

// Convert a single screen point to PDF coordinates (bottom-left origin).
function screenPointToPdf(x, y, page, overlay) {
  const scaleX = page.width / overlay.clientWidth;
  const scaleY = page.height / overlay.clientHeight;
  return [x * scaleX, page.height - (y * scaleY)];
}

init();

async function init() {
  bindEvents();
  setTool('select');
  
  const result = await window.api.getPdfEditorSession(sessionId);
  if (!result || !result.success) {
    documentStatus.textContent = result ? result.error : 'Could not load editor session';
    loadingState.classList.add('hidden');
    return;
  }

  session = result;
  documentName.textContent = session.fileName;
  documentStatus.textContent = 'Rendering pages';
  await renderPdf();

  // After rendering, fetch the text map automatically
  await fetchTextMap();
}

function bindEvents() {
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  document.getElementById('undoBtn').addEventListener('click', undo);
  document.getElementById('redoBtn').addEventListener('click', redo);

  document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all edits?')) {
      saveUndoSnapshot();
      actions = [];
      renderActions();
    }
  });

  document.getElementById('saveBtn').addEventListener('click', savePdf);
  document.getElementById('zoomOutBtn').addEventListener('click', () => setZoom(Math.max(0.5, zoom - 0.1)));
  document.getElementById('zoomInBtn').addEventListener('click', () => setZoom(Math.min(2.0, zoom + 0.1)));

  // Hotkeys
  window.addEventListener('keydown', (e) => {
    if (activeInlineEditor) return; // Don't hijack keys while editing text
    if (e.ctrlKey && e.key === 'z') { undo(); return; }
    if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { redo(); return; }
    if (e.key === 's') setTool('select');
    if (e.key === 'h') setTool('hand');
    if (e.key === 't') setTool('text');
    if (e.key === 'Escape') dismissInlineEditor(false);
  });
}

async function renderPdf() {
  loadingState.classList.remove('hidden');
  const result = await window.api.pdfOperation({
    operation: 'render',
    files: [session.filePath],
    dpi: 150
  });

  if (!result || !result.success) {
    documentStatus.textContent = result ? result.error : 'Failed to render PDF';
    loadingState.classList.add('hidden');
    return;
  }

  pages = result.pages || [];
  // Clear image src before removing nodes so the browser can GC the image data
  document.querySelectorAll('.page img, .thumb img').forEach(img => { img.src = ''; });
  pagesEl.innerHTML = '';
  thumbs.innerHTML = '';

  for (const page of pages) {
    await renderPage(page);
  }

  loadingState.classList.add('hidden');
  documentStatus.textContent = `${pages.length} page${pages.length === 1 ? '' : 's'} ready`;
  renderActions();
}

async function fetchTextMap(force = false) {
  if (textMapFetched && !force) return;

  // If re-fetching by force, clear orphaned replace actions tied to old IDs
  if (force && textMapFetched) {
    const replaceCount = actions.filter(a => a.type === 'replace').length;
    if (replaceCount > 0) {
      saveUndoSnapshot();
      actions = actions.filter(a => a.type !== 'replace');
      renderActions();
    }
  }

  documentStatus.textContent = 'Detecting text…';
  try {
    const result = await window.api.pdfOperation({
      operation: 'text-map',
      files: [session.filePath],
      ocr: false
    });
    if (result && result.success && result.items) {
      textMap = result.items;
      textMapFetched = true;
      renderTextMapOverlays();

      const count = textMap.length;
      let status = `${count} text block${count === 1 ? '' : 's'} detected — click any to edit`;

      // Warn when OCR was requested but unavailable
      if (result.ocrError && !result.ocrUsed) {
        status += ' (OCR unavailable — embedded text only)';
        console.warn('OCR skipped:', result.ocrError);
      }

      // Warn when fonts were substituted
      const substitutedFonts = [...new Set(
        result.items.filter(i => i.fontSubstituted).map(i => i.fontName).filter(Boolean)
      )];
      if (substitutedFonts.length > 0) {
        const names = substitutedFonts.slice(0, 3).join(', ');
        const extra = substitutedFonts.length > 3 ? ` +${substitutedFonts.length - 3} more` : '';
        status += ` — font substitution: ${names}${extra}`;
      }

      documentStatus.textContent = status;
    } else {
      documentStatus.textContent = `${pages.length} page${pages.length === 1 ? '' : 's'} ready`;
    }
  } catch (err) {
    console.warn('Text map fetch failed:', err);
    documentStatus.textContent = `${pages.length} page${pages.length === 1 ? '' : 's'} ready`;
  }
}

function renderTextMapOverlays() {
  // Remove existing overlays
  document.querySelectorAll('.textmap-overlay').forEach(el => el.remove());

  for (const item of textMap) {
    const pageNum = item.page;
    const pageEl = document.querySelector(`.page[data-page="${pageNum}"]`);
    if (!pageEl) continue;

    const overlay = pageEl.querySelector('.page-overlay');
    if (!overlay) continue;

    const page = pages.find(p => p.index === pageNum);
    if (!page) continue;

    const { x: uiX, y: uiY, w: uiW, h: uiH } = pdfItemToScreen(item, page, pageEl);

    const el = document.createElement('div');
    el.className = 'textmap-overlay';
    el.dataset.itemId = item.id;
    el.style.left = uiX + 'px';
    el.style.top = uiY + 'px';
    el.style.width = uiW + 'px';
    el.style.height = uiH + 'px';
    el.title = `"${item.text}" — ${item.fontFamily} ${Math.round(item.fontSize)}pt`;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeTool === 'select') {
        startInlineEdit(el, item, page, overlay, pageEl);
      }
    });

    overlay.appendChild(el);
  }
}

// ============================================================================
// Inline text editing
// ============================================================================

function startInlineEdit(overlayEl, item, page, pageOverlay, pageEl) {
  dismissInlineEditor(false);
  overlayEl.classList.add('editing');

  const existingIdx = actions.findIndex(a => a.type === 'replace' && a.textMapId === item.id);
  const currentText = existingIdx >= 0 ? actions[existingIdx].text : item.text;

  const { x: uiX, y: uiY, w: rawW, h: rawH } = pdfItemToScreen(item, page, pageEl);
  const uiW = Math.max(rawW, 40);
  const uiH = Math.max(rawH, 14);
  const scaleY = pageEl.clientHeight / page.height;
  const fontSizePx = Math.max(item.fontSize * scaleY, 8);
  // fontName is the raw PDF font name (e.g. "ArialMT", "ABCDEF+Calibri-Bold")
  // fontFamily is the over-normalized family ("Helvetica"/"Times"/"Courier")
  // Prefer fontName for precise CSS mapping; fall back to fontFamily
  const cssFontFamily = mapFontFamilyToCss(item.fontName || item.fontFamily);

  // White cover to erase original rendered text (Acrobat-style whiteout)
  const cover = document.createElement('div');
  cover.className = 'inline-editor-cover';
  cover.style.left = uiX + 'px';
  cover.style.top = uiY + 'px';
  cover.style.width = uiW + 'px';
  cover.style.height = uiH + 'px';
  pageOverlay.appendChild(cover);

  const textarea = document.createElement('textarea');
  textarea.className = 'inline-editor';
  textarea.value = currentText;
  textarea.style.left = uiX + 'px';
  textarea.style.top = uiY + 'px';
  textarea.style.width = uiW + 'px';
  textarea.style.minHeight = uiH + 'px';
  textarea.style.fontSize = fontSizePx + 'px';
  textarea.style.fontFamily = cssFontFamily;
  textarea.style.fontWeight = item.fontWeight || 'normal';
  textarea.style.fontStyle = item.fontStyle || 'normal';
  textarea.style.color = item.color || '#000000';
  textarea.style.lineHeight = '1.2';
  textarea.rows = 1;
  textarea._cover = cover;

  function autoResize() {
    textarea.style.height = 'auto';
    const newH = Math.max(textarea.scrollHeight, uiH);
    textarea.style.height = newH + 'px';
    cover.style.height = newH + 'px';
  }
  textarea.addEventListener('input', autoResize);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      dismissInlineEditor(false);
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitInlineEdit(textarea, overlayEl, item, page, pageEl);
    }
  });

  textarea.addEventListener('blur', () => {
    setTimeout(() => {
      if (activeInlineEditor === textarea) {
        commitInlineEdit(textarea, overlayEl, item, page, pageEl);
      }
    }, 120);
  });

  pageOverlay.appendChild(textarea);
  activeInlineEditor = textarea;

  setTimeout(() => {
    textarea.focus();
    textarea.select();
    autoResize();
  }, 0);
}

function commitInlineEdit(textarea, overlayEl, item, page, pageEl) {
  if (activeInlineEditor !== textarea) return;
  activeInlineEditor = null;

  const newText = textarea.value.trim();
  overlayEl.classList.remove('editing');
  if (textarea._cover) textarea._cover.remove();
  textarea.remove();

  if (!newText || newText === item.text.trim()) {
    return;
  }

  saveUndoSnapshot();
  // Remove any previous replace action for this item
  actions = actions.filter(a => !(a.type === 'replace' && a.textMapId === item.id));

  // Record replacement action
  actions.push({
    type: 'replace',
    textMapId: item.id,
    page: item.page,
    text: newText,
    originalText: item.text,
    // PDF coordinate space (for sending to Python)
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    // Font metadata from detected text
    size: item.fontSize,
    originalFontSize: item.fontSize,
    originalFontFamily: item.fontFamily,
    fontFamily: item.fontFamily,
    fontName: item.fontName,    // raw PDF font name for CSS mapping
    fontWeight: item.fontWeight || 'normal',
    fontStyle: item.fontStyle || 'normal',
    color: item.color || '#000000',
    sourceType: item.sourceType || 'pdf',
    // UI display (screen coordinates for renderReplaceAnnotation)
    uiX: item.x * (pageEl.clientWidth / page.width),
    uiY: item.y * (pageEl.clientHeight / page.height),
    uiW: item.w * (pageEl.clientWidth / page.width),
    uiH: item.h * (pageEl.clientHeight / page.height),
  });

  renderActions();
}

function dismissInlineEditor(commit) {
  if (!activeInlineEditor) return;
  if (commit) {
    activeInlineEditor.blur(); // triggers commitInlineEdit via blur handler
  } else {
    const editor = activeInlineEditor;
    activeInlineEditor = null;
    document.querySelectorAll('.textmap-overlay.editing').forEach(el => el.classList.remove('editing'));
    if (editor._cover) editor._cover.remove();
    editor.remove();
  }
}

function mapFontFamilyToCss(family) {
  // Strip PDF subset prefix "ABCDEF+" from embedded font names
  const stripped = (family || '').replace(/^[A-Z]{6}\+/, '');
  const f = stripped.toLowerCase().replace(/[-_\s]/g, '');

  // Monospace
  if (/courier|consolas|inconsolata|lucidaconsole|firacode|sourcecodemono|ocra|ocr/.test(f) ||
      f.endsWith('mono')) {
    return "'Courier New', Courier, monospace";
  }
  // Serif — Times family
  if (/timesnewroman|timesroman/.test(f) || f === 'times' || /^times(?!camp)/.test(f)) {
    return "Times, 'Times New Roman', serif";
  }
  if (/garamond/.test(f)) return "Garamond, 'EB Garamond', Georgia, serif";
  if (/palatino/.test(f)) return "'Palatino Linotype', Palatino, serif";
  if (/georgia/.test(f)) return "Georgia, serif";
  if (/baskerville/.test(f)) return "Baskerville, 'Baskerville Old Face', Georgia, serif";
  if (/bookantiqua|bookman/.test(f)) return "'Book Antiqua', Palatino, serif";
  if (/centuryschoolbook|schoolbook/.test(f)) return "'Century Schoolbook', Georgia, serif";
  if (/minion/.test(f)) return "Garamond, Georgia, serif";
  if (/constantia|cambria/.test(f)) return "Constantia, Cambria, Georgia, serif";

  // Sans-serif — Helvetica family (most common in PDFs)
  if (/^helv|helvetica/.test(f)) return "Helvetica, Arial, sans-serif";
  // Sans-serif — Arial family
  if (/^arial/.test(f)) return "Arial, Helvetica, sans-serif";
  if (/calibri/.test(f)) return "Calibri, Candara, Arial, sans-serif";
  if (/verdana/.test(f)) return "Verdana, Geneva, sans-serif";
  if (/tahoma/.test(f)) return "Tahoma, Geneva, sans-serif";
  if (/trebuchet/.test(f)) return "'Trebuchet MS', Helvetica, sans-serif";
  if (/centurygothic/.test(f)) return "'Century Gothic', Futura, Arial, sans-serif";
  if (/futura/.test(f)) return "Futura, 'Century Gothic', Arial, sans-serif";
  if (/gillsans/.test(f)) return "'Gill Sans', 'Gill Sans MT', Arial, sans-serif";
  if (/myriad/.test(f)) return "'Myriad Pro', Arial, sans-serif";
  if (/optima/.test(f)) return "Optima, Candara, sans-serif";
  if (/franklingothic|franklin/.test(f)) return "'Franklin Gothic Medium', Arial, sans-serif";
  if (/impact/.test(f)) return "Impact, 'Arial Narrow', sans-serif";
  if (/comicsans|comic/.test(f)) return "'Comic Sans MS', cursive";
  if (/candara/.test(f)) return "Candara, Arial, sans-serif";
  if (/corbel/.test(f)) return "Corbel, Arial, sans-serif";
  if (/lato|roboto|montserrat|opensans|sourcesans|notosans|inter/.test(f)) {
    return "Arial, sans-serif";
  }

  return "Helvetica, Arial, sans-serif";
}

// ============================================================================
// Page rendering
// ============================================================================

async function renderPage(page) {
  const dataUrl = await window.api.readImagePreview(page.path);

  const pageEl = document.createElement('div');
  pageEl.className = 'page';
  pageEl.dataset.page = page.index;
  pageEl.style.width = page.width + 'px';
  pageEl.style.height = page.height + 'px';

  const img = document.createElement('img');
  img.src = dataUrl;

  const overlay = document.createElement('div');
  overlay.className = 'page-overlay';
  
  // Events
  overlay.addEventListener('mousedown', (e) => handlePointerDown(e, page, overlay));
  overlay.addEventListener('click', (e) => {
    if (activeTool === 'text' && e.target === overlay) addTextAtClick(e, page, overlay);
  });

  pageEl.appendChild(img);
  pageEl.appendChild(overlay);
  pagesEl.appendChild(pageEl);

  // Thumbnail
  const thumb = document.createElement('div');
  thumb.className = 'thumb' + (page.index === 1 ? ' active' : '');
  thumb.dataset.page = page.index;
  thumb.innerHTML = `
    <img src="${dataUrl}">
    <span>Page ${page.index}</span>
    <div class="thumb-actions">
      <button class="thumb-action-btn rotate-btn" title="Rotate 90° CW">ROT</button>
      <button class="thumb-action-btn delete-btn" title="Delete Page">DEL</button>
    </div>
  `;
  
  thumb.addEventListener('click', (e) => {
    if (e.target.closest('.thumb-action-btn')) return;
    document.querySelectorAll('.thumb').forEach(t => t.classList.remove('active'));
    thumb.classList.add('active');
    pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Rotate handler
  thumb.querySelector('.rotate-btn').addEventListener('click', async () => {
    documentStatus.textContent = 'Rotating page...';
    const res = await window.api.pdfOperation({
      operation: 'rotate',
      inputPath: session.filePath,
      pageIndex: page.index - 1,
      degrees: 90
    });
    if (res.success) await renderPdf();
    else alert(res.error);
  });

  // Delete handler
  thumb.querySelector('.delete-btn').addEventListener('click', async () => {
    if (!confirm('Delete this page? This cannot be undone.')) return;
    documentStatus.textContent = 'Deleting page...';
    const res = await window.api.pdfOperation({
      operation: 'delete',
      inputPath: session.filePath,
      pageIndex: page.index - 1
    });
    if (res.success) {
      saveUndoSnapshot();
      actions = actions.filter(a => (a.rect ? a.rect.page : a.page) !== page.index);
      await renderPdf();
    }
    else alert(res.error);
  });

  thumbs.appendChild(thumb);
}

function setTool(tool) {
  activeTool = tool;
  document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tool === tool));
  activeToolLabel.textContent = TOOL_LABELS[tool] || tool;
  
  // Show/hide property sections
  const isShape = ['rect', 'circle', 'line', 'arrow', 'highlight'].includes(tool);
  const isText = tool === 'text' || tool === 'replace';
  
  propSectionText.classList.toggle('hidden', !isText);
  propSectionShape.classList.toggle('hidden', !isShape);

  // Update cursor on overlays based on tool
  const isSelectMode = tool === 'select';
  document.querySelectorAll('.textmap-overlay').forEach(el => {
    el.style.pointerEvents = isSelectMode ? 'auto' : 'none';
  });
}

function setZoom(value) {
  zoom = Math.round(value * 10) / 10;
  zoomValue.textContent = Math.round(zoom * 100) + '%';
  document.querySelectorAll('.page').forEach(p => {
    p.style.transform = `scale(${zoom})`;
  });
}

function handlePointerDown(e, page, overlay) {
  if (activeTool === 'select' || activeTool === 'hand' || activeTool === 'text') return;
  if (e.target !== overlay) return;

  const start = getPoint(e, overlay);
  
  if (activeTool === 'freehand') {
    startFreehand(e, page, overlay);
    return;
  }

  draft = document.createElement('div');
  draft.className = `annotation ${activeTool} draft`;
  draft.style.left = start.x + 'px';
  draft.style.top = start.y + 'px';
  
  // Visual style for draft
  if (activeTool === 'highlight') {
    draft.style.background = 'rgba(255, 230, 64, 0.3)';
  } else if (['rect', 'circle', 'line', 'arrow'].includes(activeTool)) {
    draft.style.border = `${strokeWidth.value}px solid ${strokeColor.value}`;
    if (activeTool === 'rect' || activeTool === 'circle') {
      draft.style.background = fillColor.value + '44';
    }
  }

  overlay.appendChild(draft);

  const onMove = (moveEvent) => {
    const point = getPoint(moveEvent, overlay);
    const left = Math.min(start.x, point.x);
    const top = Math.min(start.y, point.y);
    const width = Math.abs(start.x - point.x);
    const height = Math.abs(start.y - point.y);
    
    if (activeTool === 'line' || activeTool === 'arrow') {
      draft.style.width = width + 'px';
      draft.style.height = height + 'px';
    } else {
      Object.assign(draft.style, {
        left: left + 'px',
        top: top + 'px',
        width: width + 'px',
        height: height + 'px'
      });
    }
  };

  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    const rect = getActionRect(draft, page, overlay);
    draft.remove();
    draft = null;
    
    if (!rect || rect.w < 2 || rect.h < 2) return;

    saveUndoSnapshot();
    actions.push({
      type: activeTool,
      rect,
      stroke: strokeColor.value,
      fill: fillColor.value,
      width: parseInt(strokeWidth.value),
      opacity: parseInt(shapeOpacity.value) / 100
    });
    renderActions();
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function startFreehand(e, page, overlay) {
  isDrawing = true;
  currentPath = [getPoint(e, overlay)];
  
  canvas = document.createElement('canvas');
  canvas.className = 'drawing-canvas';
  canvas.width = Math.min(overlay.clientWidth, MAX_CANVAS_PX);
  canvas.height = Math.min(overlay.clientHeight, MAX_CANVAS_PX);
  overlay.appendChild(canvas);
  ctx = canvas.getContext('2d');
  ctx.strokeStyle = strokeColor.value;
  ctx.lineWidth = strokeWidth.value;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const onMove = (moveEvent) => {
    const point = getPoint(moveEvent, overlay);
    currentPath.push(point);
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
    ctx.moveTo(currentPath[0].x, currentPath[0].y);
    for (let i = 1; i < currentPath.length; i++) {
      ctx.lineTo(currentPath[i].x, currentPath[i].y);
    }
    ctx.stroke();
  };

  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    isDrawing = false;

    const pdfPoints = currentPath.map(p => screenPointToPdf(p.x, p.y, page, overlay));

    saveUndoSnapshot();
    actions.push({
      type: 'freehand',
      page: page.index,
      points: pdfPoints,
      uiPoints: [...currentPath],
      color: strokeColor.value,
      width: parseInt(strokeWidth.value)
    });
    
    canvas.remove();
    renderActions();
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function addTextAtClick(e, page, overlay) {
  const text = prompt('Text to add:');
  if (!text) return;
  const point = getPoint(e, overlay);
  // getPoint already returns layout pixels (÷zoom). Use clientWidth/Height (unscaled)
  // so we don't divide by zoom a second time via getBoundingClientRect.
  const scaleX = page.width / overlay.clientWidth;
  const scaleY = page.height / overlay.clientHeight;

  saveUndoSnapshot();
  actions.push({
    type: 'text',
    page: page.index,
    x: point.x * scaleX,
    y: point.y * scaleY,
    uiX: point.x,
    uiY: point.y,
    text,
    size: parseInt(textSize.value, 10),
    color: textColor.value
  });
  renderActions();
}

function renderActions() {
  document.querySelectorAll('.annotation:not(.draft)').forEach(el => el.remove());
  document.querySelectorAll('.drawing-canvas').forEach(el => el.remove());
  document.querySelectorAll('.replace-preview').forEach(el => el.remove());
  changeList.innerHTML = '';

  actions.forEach((action, index) => {
    const pageNum = action.rect ? action.rect.page : action.page;
    const overlay = document.querySelector(`.page[data-page="${pageNum}"] .page-overlay`);
    if (!overlay) return;

    if (action.type === 'freehand') {
      renderFreehand(action, overlay);
    } else if (action.type === 'replace') {
      renderReplaceAnnotation(action, overlay, index);
    } else {
      renderAnnotation(action, overlay, index);
    }

    const row = document.createElement('div');
    row.className = 'change-item';
    const label = action.type === 'replace'
      ? `Replace: "${truncate(action.originalText, 20)}" → "${truncate(action.text, 20)}"`
      : TOOL_LABELS[action.type] || action.type;
    row.innerHTML = `<div class="change-title">${label}</div><div class="change-meta">Page ${pageNum}</div>`;
    changeList.appendChild(row);
  });

  if (!actions.length) {
    changeList.innerHTML = '<div class="document-status">No edits yet</div>';
  }
  documentStatus.textContent = `${actions.length} pending change${actions.length === 1 ? '' : 's'}`;
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

function renderReplaceAnnotation(action, overlay, index) {
  const el = document.createElement('div');
  el.className = 'replace-preview';
  el.style.left = action.uiX + 'px';
  el.style.top = action.uiY + 'px';
  el.style.width = action.uiW + 'px';
  el.style.minHeight = action.uiH + 'px';

  // Show replacement text as a preview
  const page = pages.find(p => p.index === action.page);
  const pageEl = document.querySelector(`.page[data-page="${action.page}"]`);
  const scaleY = pageEl ? pageEl.clientHeight / (page ? page.height : 1) : 1;
  const fontSizePx = Math.max((action.originalFontSize || action.size || 12) * scaleY, 8);
  const cssFontFamily = mapFontFamilyToCss(action.fontName || action.fontFamily || action.originalFontFamily);

  el.style.fontSize = fontSizePx + 'px';
  el.style.fontFamily = cssFontFamily;
  el.style.fontWeight = action.fontWeight || 'normal';
  el.style.fontStyle = action.fontStyle || 'normal';
  el.style.color = action.color || '#000000';
  el.style.lineHeight = '1.2';
  el.textContent = action.text;

  el.addEventListener('click', (event) => {
    if (activeTool !== 'select') return;
    event.stopPropagation();
    // Re-open the inline editor for this replace action
    const item = textMap.find(it => it.id === action.textMapId);
    if (item) {
      const overlayEl = document.querySelector(`.textmap-overlay[data-item-id="${item.id}"]`);
      const pageEl2 = document.querySelector(`.page[data-page="${item.page}"]`);
      const pageOverlay = pageEl2 && pageEl2.querySelector('.page-overlay');
      const page2 = pages.find(p => p.index === item.page);
      if (overlayEl && pageEl2 && pageOverlay && page2) {
        startInlineEdit(overlayEl, item, page2, pageOverlay, pageEl2);
      }
    } else {
      // Fallback: delete the action
      saveUndoSnapshot();
      actions.splice(index, 1);
      renderActions();
    }
  });
  
  overlay.appendChild(el);
}

function renderAnnotation(action, overlay, index) {
  const el = document.createElement('div');
  el.className = `annotation ${action.type}`;
  
  if (action.type === 'text') {
    el.textContent = action.text;
    el.style.left = action.uiX + 'px';
    el.style.top = action.uiY + 'px';
    el.style.color = action.color;
    el.style.fontSize = action.size * 1.35 + 'px';
  } else if (action.rect) {
    Object.assign(el.style, {
      left: action.rect.uiX + 'px',
      top: action.rect.uiY + 'px',
      width: action.rect.uiW + 'px',
      height: action.rect.uiH + 'px',
      opacity: action.opacity
    });
    
    if (['rect', 'circle', 'line', 'arrow'].includes(action.type)) {
      el.style.borderColor = action.stroke;
      el.style.borderWidth = action.width + 'px';
      if (action.type === 'rect' || action.type === 'circle') {
        el.style.backgroundColor = action.fill + '44';
      }
    }
  }

  el.addEventListener('click', (event) => {
    if (activeTool !== 'select') return;
    event.stopPropagation();
    saveUndoSnapshot();
    actions.splice(index, 1);
    renderActions();
  });

  overlay.appendChild(el);
}

function renderFreehand(action, overlay) {
  const canvas = document.createElement('canvas');
  canvas.className = 'drawing-canvas';
  canvas.width = Math.min(overlay.clientWidth, MAX_CANVAS_PX);
  canvas.height = Math.min(overlay.clientHeight, MAX_CANVAS_PX);
  overlay.appendChild(canvas);
  
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = action.color;
  ctx.lineWidth = action.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  ctx.beginPath();
  ctx.moveTo(action.uiPoints[0].x, action.uiPoints[0].y);
  for (let i = 1; i < action.uiPoints.length; i++) {
    ctx.lineTo(action.uiPoints[i].x, action.uiPoints[i].y);
  }
  ctx.stroke();
  
  canvas.style.pointerEvents = 'auto';
  canvas.addEventListener('click', (e) => {
    if (activeTool === 'select') {
      e.stopPropagation();
      saveUndoSnapshot();
      actions = actions.filter(a => a !== action);
      renderActions();
    }
  });
}

async function savePdf() {
  if (!actions.length) {
    documentStatus.textContent = 'No changes to save';
    return;
  }

  const rects = [];
  const covers = [];
  const highlights = [];
  const edits = [];
  const paths = [];

  actions.forEach(action => {
    if (action.type === 'redact') rects.push({ ...action.rect, fill: '#000000' });
    if (action.type === 'whiteout') covers.push({ ...action.rect, fill: '#ffffff' });
    
    if (['highlight', 'rect', 'circle', 'line', 'arrow'].includes(action.type)) {
      highlights.push({ 
        ...action.rect, 
        type: action.type,
        stroke: action.stroke, 
        fill: action.fill, 
        opacity: action.opacity 
      });
    }
    
    if (action.type === 'text') {
      edits.push({
        page: action.page,
        x: action.x,
        y: action.y,
        text: action.text,
        size: action.size,
        color: hexToRgb(action.color)
      });
    }

    if (action.type === 'replace') {
      // Replacement edit — carries full font metadata so Python uses the right font
      edits.push({
        mode: 'replace',
        source: 'textmap',
        page: action.page,
        // Original bounding box (signals is_replacement_edit in Python)
        originalX: action.x,
        originalY: action.y,
        originalW: action.w,
        originalH: action.h,
        x: action.x,
        y: action.y,
        w: action.w,
        h: action.h,
        text: action.text,
        // Font metadata
        originalFontSize: action.originalFontSize || action.size,
        size: action.originalFontSize || action.size,
        originalFontFamily: action.originalFontFamily || action.fontFamily,
        fontFamily: action.fontFamily || action.originalFontFamily,
        fontWeight: action.fontWeight || 'normal',
        fontStyle: action.fontStyle || 'normal',
        // Color
        color: hexToRgb(action.color || '#000000'),
        sourceType: action.sourceType || 'pdf',
        // White background fill to cover original text cleanly
        replacementFill: action.sourceType === 'ocr' ? [1, 1, 1] : null,
      });
    }
    
    if (action.type === 'freehand') {
      paths.push({
        page: action.page,
        points: action.points,
        color: action.color,
        width: action.width,
        opacity: 1.0
      });
    }
  });

  documentStatus.textContent = 'Saving PDF...';
  const result = await window.api.pdfOperation({
    operation: 'edit',
    files: [session.filePath],
    outputDir: session.outputDir,
    rects,
    covers,
    highlights,
    edits,
    paths
  });

  if (result && result.success) {
    const overflow = result.textOverflow || 0;
    const msg = overflow > 0
      ? `Saved — ${overflow} text item${overflow > 1 ? 's' : ''} truncated (text too long for bounding box)`
      : 'Saved successfully';
    documentStatus.textContent = msg;
    window.api.showNotification({ title: 'MuxMelt', body: 'Professional PDF edits saved.' });
    if (result.output) window.api.openPath(result.output);
  } else {
    documentStatus.textContent = result ? result.error : 'Save failed';
  }
}

function getPoint(e, overlay) {
  const rect = overlay.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(rect.width, (e.clientX - rect.left) / zoom)),
    y: Math.max(0, Math.min(rect.height, (e.clientY - rect.top) / zoom))
  };
}

function getActionRect(el, page, overlay) {
  const left = parseFloat(el.style.left) || 0;
  const top = parseFloat(el.style.top) || 0;
  const width = parseFloat(el.style.width) || 0;
  const height = parseFloat(el.style.height) || 0;
  return screenRectToPdfPayload(left, top, width, height, page, overlay);
}

function hexToRgb(hex) {
  const value = String(hex || '#000000').replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  ];
}

})();

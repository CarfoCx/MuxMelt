// ============================================================================
// MuxMelt PDF Editor
// ============================================================================

(function() {

const params = new URLSearchParams(window.location.search);
const sessionId = params.get('sessionId');

let session = null;
let pages = [];
let actions = [];
let activeTool = 'select';
let zoom = 1.0;
let draft = null;

// Drawing state
let isDrawing = false;
let currentPath = [];
let canvas = null;
let ctx = null;

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
  whiteout: 'Whiteout'
};

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
}

function bindEvents() {
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  document.getElementById('undoBtn').addEventListener('click', () => {
    actions.pop();
    renderActions();
  });
  
  document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all edits?')) {
      actions = [];
      renderActions();
    }
  });

  document.getElementById('saveBtn').addEventListener('click', savePdf);
  document.getElementById('zoomOutBtn').addEventListener('click', () => setZoom(Math.max(0.5, zoom - 0.1)));
  document.getElementById('zoomInBtn').addEventListener('click', () => setZoom(Math.min(2.0, zoom + 0.1)));

  // Hotkeys
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'z') { actions.pop(); renderActions(); }
    if (e.key === 's') setTool('select');
    if (e.key === 'h') setTool('hand');
    if (e.key === 't') setTool('text');
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
  pagesEl.innerHTML = '';
  thumbs.innerHTML = '';

  for (const page of pages) {
    await renderPage(page);
  }

  loadingState.classList.add('hidden');
  documentStatus.textContent = `${pages.length} page${pages.length === 1 ? '' : 's'} ready`;
  renderActions();
}

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
      <button class="thumb-action-btn rotate-btn" title="Rotate 90\u00b0 CW">ROT</button>
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
  activeToolLabel.textContent = TOOL_LABELS[tool];
  
  // Show/hide property sections
  const isShape = ['rect', 'circle', 'line', 'arrow', 'highlight'].includes(tool);
  const isText = tool === 'text' || tool === 'replace';
  
  propSectionText.classList.toggle('hidden', !isText);
  propSectionShape.classList.toggle('hidden', !isShape);
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
      draft.style.background = fillColor.value + '44'; // Add transparency
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
      // Rotation-based lines are complex for pure CSS, so we just do a box for the draft
      // Real lines are drawn in renderActions or final PDF.
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

    const action = { 
      type: activeTool, 
      rect,
      stroke: strokeColor.value,
      fill: fillColor.value,
      width: parseInt(strokeWidth.value),
      opacity: parseInt(shapeOpacity.value) / 100
    };
    
    actions.push(action);
    renderActions();
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function startFreehand(e, page, overlay) {
  isDrawing = true;
  currentPath = [getPoint(e, overlay)];
  
  // Create temp canvas for drawing
  canvas = document.createElement('canvas');
  canvas.className = 'drawing-canvas';
  canvas.width = overlay.clientWidth;
  canvas.height = overlay.clientHeight;
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
    
    const scaleX = page.width / overlay.clientWidth;
    const scaleY = page.height / overlay.clientHeight;
    
    const pdfPoints = currentPath.map(p => [p.x * scaleX, page.height - (p.y * scaleY)]); // PyMuPDF uses bottom-left origin for paths
    
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
  const rect = overlay.getBoundingClientRect();
  
  actions.push({
    type: 'text',
    page: page.index,
    x: point.x * (page.width / rect.width),
    y: point.y * (page.height / rect.height),
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
  changeList.innerHTML = '';

  actions.forEach((action, index) => {
    const pageNum = action.rect ? action.rect.page : action.page;
    const overlay = document.querySelector(`.page[data-page="${pageNum}"] .page-overlay`);
    if (!overlay) return;

    if (action.type === 'freehand') {
      renderFreehand(action, overlay);
    } else {
      renderAnnotation(action, overlay, index);
    }

    const row = document.createElement('div');
    row.className = 'change-item';
    row.innerHTML = `<div class="change-title">${TOOL_LABELS[action.type]}</div><div class="change-meta">Page ${pageNum}</div>`;
    changeList.appendChild(row);
  });

  if (!actions.length) {
    changeList.innerHTML = '<div class="document-status">No edits yet</div>';
  }
  documentStatus.textContent = `${actions.length} pending change${actions.length === 1 ? '' : 's'}`;
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
    actions.splice(index, 1);
    renderActions();
  });
  
  overlay.appendChild(el);
}

function renderFreehand(action, overlay) {
  const canvas = document.createElement('canvas');
  canvas.className = 'drawing-canvas';
  canvas.width = overlay.clientWidth;
  canvas.height = overlay.clientHeight;
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
    documentStatus.textContent = 'Saved successfully';
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
  const rect = overlay.getBoundingClientRect();
  const left = parseFloat(el.style.left) || 0;
  const top = parseFloat(el.style.top) || 0;
  const width = parseFloat(el.style.width) || 0;
  const height = parseFloat(el.style.height) || 0;
  
  const scaleX = page.width / (rect.width / zoom);
  const scaleY = page.height / (rect.height / zoom);

  return {
    page: page.index,
    x: left * scaleX,
    y: page.height - (top + height) * scaleY, // PyMuPDF uses bottom-left origin
    w: width * scaleX,
    h: height * scaleY,
    uiX: left,
    uiY: top,
    uiW: width,
    uiH: height
  };
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

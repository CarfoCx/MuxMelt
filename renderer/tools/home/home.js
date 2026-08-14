// ============================================================================
// Home Tool
// ============================================================================

(function() {

let log = null;
let selectedFiles = [];

const TYPES = {
  image: new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif', 'avif', 'gif', 'svg', 'heic', 'heif', 'tim']),
  video: new Set(['mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v', 'wmv', 'flv']),
  audio: new Set(['mp3', 'wav', 'flac', 'ogg', 'oga', 'aac', 'm4a', 'wma', 'opus'])
};

const ACTIONS = {
  'format-converter': { label: 'Convert format', detail: 'Choose a new image, video, or audio format' },
  'video-compressor': { label: 'Shrink video', detail: 'Make video files easier to share' },
  'gif-maker': { label: 'Make a GIF', detail: 'Turn a video clip into an animation' },
  'audio-extractor': { label: 'Extract audio', detail: 'Save the soundtrack from a video' },
  'bulk-imager': { label: 'Edit image', detail: 'Crop, resize, rotate, or adjust' },
  'upscaler': { label: 'Upscale image', detail: 'Increase image resolution locally' },
  'bg-remover': { label: 'Remove background', detail: 'Cut out a subject locally' },
  'stem-separator': { label: 'Split into stems', detail: 'Separate vocals and instruments locally' },
  'qr-studio': { label: 'Scan QR code', detail: 'Read a QR code from an image' }
};

function getExtension(filePath) {
  const name = String(filePath || '').replace(/\\/g, '/').split('/').pop() || '';
  return name.includes('.') ? name.split('.').pop().toLowerCase() : '';
}

function getType(filePath) {
  const extension = getExtension(filePath);
  return Object.keys(TYPES).find(type => TYPES[type].has(extension)) || 'other';
}

function suggestionsFor(files) {
  const types = new Set(files.map(getType));
  if (types.size !== 1) return ['format-converter'];
  const type = Array.from(types)[0];
  if (type === 'image') return ['format-converter', 'bulk-imager', 'upscaler', 'bg-remover', 'qr-studio'];
  if (type === 'video') return ['video-compressor', 'format-converter', 'gif-maker', 'audio-extractor'];
  if (type === 'audio') return ['format-converter', 'stem-separator'];
  return ['format-converter'];
}

function renderSuggestions() {
  const section = document.getElementById('homeSuggestions');
  const summary = document.getElementById('selectedFileSummary');
  const grid = document.getElementById('suggestionGrid');
  if (!selectedFiles.length) {
    section.hidden = true;
    grid.replaceChildren();
    return;
  }

  section.hidden = false;
  summary.textContent = selectedFiles.length === 1
    ? String(selectedFiles[0]).replace(/\\/g, '/').split('/').pop()
    : `${selectedFiles.length} files selected`;
  grid.replaceChildren();
  suggestionsFor(selectedFiles).forEach(toolId => {
    const action = ACTIONS[toolId];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'home-action-card';
    button.innerHTML = `<strong>${window.escapeHtml(action.label)}</strong><span>${window.escapeHtml(action.detail)}</span>`;
    button.addEventListener('click', () => window.openFilesInTool(toolId, selectedFiles));
    grid.appendChild(button);
  });
  section.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
}

async function acceptFiles(paths) {
  const clean = Array.isArray(paths) ? paths.filter(path => typeof path === 'string' && path) : [];
  if (!clean.length) return;
  selectedFiles = clean;
  renderSuggestions();
  log(`${clean.length} file${clean.length === 1 ? '' : 's'} ready`, 'success');
}

async function browse() {
  try {
    const paths = await window.api.system.selectFiles({
      title: 'Choose media files',
      filters: [{
        name: 'Media files',
        extensions: Array.from(new Set(Object.values(TYPES).flatMap(set => Array.from(set))))
      }]
    });
    await acceptFiles(paths);
  } catch (error) {
    log(`Could not open the file picker: ${error.message}`, 'error');
  }
}

async function handleDrop(event) {
  event.preventDefault();
  document.getElementById('dropZone').classList.remove('drag-over');
  try {
    const raw = Array.from(event.dataTransfer?.files || [])
      .map(file => window.api.system.getPathForFile(file))
      .filter(Boolean);
    const paths = typeof window.api.system.resolveDroppedPaths === 'function'
      ? await window.api.system.resolveDroppedPaths(raw)
      : raw;
    await acceptFiles(paths);
  } catch (error) {
    log(`Could not read dropped files: ${error.message}`, 'error');
  }
}

async function renderRecentFiles() {
  const all = await window.loadAllSettings();
  const remember = all.global?.rememberRecentFiles === true;
  const section = document.getElementById('homeRecentSection');
  const list = document.getElementById('homeRecentList');
  const recent = remember ? await window.getRecentFiles() : [];
  section.hidden = !remember || recent.length === 0;
  list.replaceChildren();
  recent.slice(0, 6).forEach(filePath => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'home-recent-item';
    button.title = filePath;
    button.textContent = String(filePath).replace(/\\/g, '/').split('/').pop();
    button.addEventListener('click', () => window.api.system.openFolder(window.getParentDirectory(filePath)));
    list.appendChild(button);
  });
}

async function renderSupportMilestone() {
  const all = await window.loadAllSettings();
  const global = all.global || {};
  const count = Number(global.completedOutputCount) || 0;
  document.getElementById('homeSupportCard').hidden = count < 25 || global.supportMilestoneDismissed === true;
}

function bindEvents() {
  const dropZone = document.getElementById('dropZone');
  dropZone.addEventListener('click', event => {
    if (event.target.closest('button')) return;
    browse();
  });
  dropZone.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target === dropZone) {
      event.preventDefault();
      browse();
    }
  });
  dropZone.addEventListener('dragover', event => {
    event.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', handleDrop);
  document.getElementById('browseBtn').addEventListener('click', browse);
  document.getElementById('clearSelectionBtn').addEventListener('click', () => {
    selectedFiles = [];
    renderSuggestions();
    dropZone.focus();
  });
  document.querySelectorAll('[data-home-tool]').forEach(button => {
    button.addEventListener('click', () => window.openTool(button.dataset.homeTool));
  });
  document.getElementById('clearRecentHomeBtn').addEventListener('click', async () => {
    await window.clearRecentFiles();
    await renderRecentFiles();
  });
  document.getElementById('homePrivacyBtn').addEventListener('click', () => window.openTool('settings'));
  document.getElementById('homeDonateBtn').addEventListener('click', () => window.api.system.openExternal('https://ko-fi.com/carfo'));
  document.getElementById('dismissSupportBtn').addEventListener('click', async () => {
    await window.updateSettings(all => {
      all.global = all.global || {};
      all.global.supportMilestoneDismissed = true;
    });
    document.getElementById('homeSupportCard').hidden = true;
  });
}

async function init(ctx) {
  log = ctx.log;
  bindEvents();
  await Promise.all([renderRecentFiles(), renderSupportMilestone()]);
}

function cleanup() {}

window.registerTool('home', { init, cleanup });

})();

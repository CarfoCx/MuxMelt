// Home: discover a tool or hand compatible files to the next step.
(function() {
'use strict';

let log = null;
let selectedFiles = [];
let activeFilter = 'all';
let pasteHandler = null;
let searchShortcutHandler = null;
let homeRoot = null;
const el = id => homeRoot.querySelector(`#${id}`);

// These match the input formats accepted by the individual tool modules.
const TYPES = {
  image: new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif', 'avif', 'gif', 'svg', 'heic', 'heif', 'tim']),
  video: new Set(['mp4', 'avi', 'mkv', 'mov', 'webm']),
  audio: new Set(['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'wma', 'mka', 'opus'])
};
const EDITABLE_IMAGES = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif']);
const STEM_AUDIO = new Set(['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'wma']);
const CATEGORIES = {
  'format-converter': ['image', 'video', 'audio'],
  'video-compressor': ['video'],
  'upscaler': ['image', 'video'],
  'gif-maker': ['video'],
  'audio-extractor': ['audio', 'video'],
  'stem-separator': ['audio'],
  'tts': ['audio'],
  'bg-remover': ['image'],
  'bulk-imager': ['image'],
  'qr-studio': ['image'],
  'url-downloader': ['downloads'],
  'torrent-downloader': ['downloads']
};

function getExtension(filePath) {
  const name = String(filePath || '').replace(/\\/g, '/').split('/').pop() || '';
  return name.includes('.') ? name.split('.').pop().toLowerCase() : '';
}
function getType(filePath) {
  const extension = getExtension(filePath);
  return Object.keys(TYPES).find(type => TYPES[type].has(extension)) || 'other';
}
function fileName(filePath) { return String(filePath).replace(/\\/g, '/').split('/').pop(); }

function renderCatalog() {
  const terms = el('homeToolSearch').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const tools = window.WORKSPACE_TOOLS.filter(tool => {
    const categories = CATEGORIES[tool.id];
    if (!categories || (activeFilter !== 'all' && !categories.includes(activeFilter))) return false;
    const searchText = `${tool.label} ${tool.description} ${tool.keywords} ${categories.join(' ')}`.toLowerCase();
    return terms.every(term => searchText.includes(term));
  });
  const grid = el('homeToolGrid');
  grid.replaceChildren();
  tools.forEach(tool => {
    const button = document.createElement('button');
    const categories = CATEGORIES[tool.id];
    button.type = 'button';
    button.className = 'home-tool-card';
    button.dataset.homeTool = tool.id;
    const categoryLabel = tool.id === 'format-converter' ? 'All media' : categories.map(category => category[0].toUpperCase() + category.slice(1)).join(', ');
    button.innerHTML = `<strong>${window.escapeHtml(tool.label)}</strong><small>${window.escapeHtml(tool.description)}</small><span class="home-card-category">${window.escapeHtml(categoryLabel)}</span>`;
    button.addEventListener('click', () => window.openTool(tool.id));
    grid.appendChild(button);
  });
  el('homeToolCount').textContent = `${tools.length} tool${tools.length === 1 ? '' : 's'}`;
  el('homeCatalogEmpty').hidden = tools.length > 0;
  homeRoot.querySelectorAll('[data-home-filter]').forEach(button => {
    const active = button.dataset.homeFilter === activeFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function suggestionsFor(files) {
  const suggestions = [];
  const groups = Object.fromEntries(Object.keys(TYPES).map(type => [type, files.filter(path => getType(path) === type)]));
  const add = (toolId, label, detail, paths, single = false) => {
    if (!paths.length) return;
    suggestions.push({ toolId, label, detail, paths: single ? paths.slice(0, 1) : paths, single: single && paths.length > 1 });
  };
  // The converter requires one media type per queue. Keep mixed selections useful
  // by offering each compatible group separately instead of a disabled queue.
  const groupCount = Object.values(groups).filter(paths => paths.length).length;
  Object.entries(groups).forEach(([type, paths]) => {
    add('format-converter', groupCount > 1 ? `Convert ${type === 'audio' ? 'audio' : `${type}s`}` : 'Convert format', 'Choose a new format for your files.', paths);
  });
  add('video-compressor', 'Make videos smaller', 'Reduce file size for easier sharing.', groups.video);
  const images = groups.image.filter(path => EDITABLE_IMAGES.has(getExtension(path)));
  add('bulk-imager', 'Crop or flip an image', 'Open a simple image editor.', images, true);
  add('bg-remover', 'Edit backgrounds', 'Remove, blur, or replace the background.', images);
  add('upscaler', 'Increase resolution', 'Upscale an image or video to 2× or 4×.', [...images, ...groups.video]);
  add('gif-maker', 'Make a GIF', 'Turn a video clip into an animation.', groups.video, true);
  add('audio-extractor', 'Extract audio', 'Save the soundtrack from a video.', groups.video);
  add('stem-separator', 'Separate vocals and instruments', 'Split a song into individual stems.', [...groups.audio.filter(path => STEM_AUDIO.has(getExtension(path))), ...groups.video]);
  return suggestions;
}

function renderSuggestions(scroll = false) {
  const section = el('homeSuggestions');
  const grid = el('suggestionGrid');
  section.hidden = selectedFiles.length === 0;
  grid.replaceChildren();
  if (!selectedFiles.length) return;
  el('selectedFileSummary').textContent = selectedFiles.length === 1
    ? fileName(selectedFiles[0])
    : `${selectedFiles.length} files selected. Each action uses the files it supports.`;
  const suggestions = suggestionsFor(selectedFiles);
  suggestions.forEach(action => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'home-action-card';
    const count = action.single ? 'Opens the first compatible file' : `${action.paths.length} compatible file${action.paths.length === 1 ? '' : 's'}`;
    button.innerHTML = `<strong>${window.escapeHtml(action.label)}</strong><span>${window.escapeHtml(action.detail)}</span><small>${count}</small>`;
    button.addEventListener('click', () => window.openFilesInTool(action.toolId, action.paths));
    grid.appendChild(button);
  });
  const unsupported = selectedFiles.filter(path => getType(path) === 'other').length;
  const note = el('homeSelectionNote');
  note.hidden = unsupported === 0;
  note.textContent = suggestions.length
    ? `${unsupported} file${unsupported === 1 ? ' has' : 's have'} an unsupported format and won’t be included. Choose an action for the remaining files.`
    : 'These file types are not supported. Choose an image, video, or audio file, or browse the tools below.';
  if (scroll && homeRoot.isConnected) section.scrollIntoView({ behavior: 'auto', block: 'nearest' });
}

async function acceptFiles(paths) {
  const clean = Array.isArray(paths) ? Array.from(new Set(paths.filter(path => typeof path === 'string' && path))) : [];
  if (!clean.length) return;
  selectedFiles = clean;
  renderSuggestions(true);
  log(`${clean.length} file${clean.length === 1 ? '' : 's'} selected`, 'info');
}

async function browse() {
  try {
    const paths = await window.api.system.selectFiles({
      title: 'Choose media files',
      filters: [{ name: 'Media files', extensions: Array.from(new Set(Object.values(TYPES).flatMap(set => Array.from(set)))) }]
    });
    await acceptFiles(paths);
  } catch (error) {
    log(`Could not open the file picker: ${error.message}`, 'error');
  }
}

async function handleDrop(event) {
  event.preventDefault();
  el('dropZone').classList.remove('drag-over');
  try {
    const raw = Array.from(event.dataTransfer?.files || []).map(file => window.api.system.getPathForFile(file)).filter(Boolean);
    const paths = typeof window.api.system.resolveDroppedPaths === 'function'
      ? await window.api.system.resolveDroppedPaths(raw) : raw;
    await acceptFiles(paths);
  } catch (error) {
    log(`Could not read dropped files: ${error.message}`, 'error');
  }
}

async function renderRecentFiles() {
  const all = await window.loadAllSettings();
  const remember = all.global?.rememberRecentFiles === true;
  const recent = remember ? await window.getRecentFiles() : [];
  const list = el('homeRecentList');
  el('homeRecentSection').hidden = !remember || recent.length === 0;
  list.replaceChildren();
  recent.slice(0, 6).forEach(filePath => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'home-recent-item';
    button.title = `Open folder: ${filePath}`;
    const name = document.createElement('span');
    name.textContent = fileName(filePath);
    button.appendChild(name);
    button.addEventListener('click', () => window.api.system.openFolder(window.getParentDirectory(filePath)));
    list.appendChild(button);
  });
}

async function renderSupportMilestone() {
  const all = await window.loadAllSettings();
  const global = all.global || {};
  el('homeSupportCard').hidden = (Number(global.completedOutputCount) || 0) < 25 || global.supportMilestoneDismissed === true;
}

function bindEvents() {
  const dropZone = el('dropZone');
  dropZone.addEventListener('dragover', event => { event.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', event => {
    if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', handleDrop);
  el('browseBtn').addEventListener('click', browse);
  el('clearSelectionBtn').addEventListener('click', () => {
    selectedFiles = [];
    renderSuggestions();
    el('browseBtn').focus();
  });
  el('homeToolSearch').addEventListener('input', renderCatalog);
  el('homeToolSearch').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); el('homeToolSearch').value = ''; renderCatalog(); }
    if (event.key === 'Enter') {
      event.preventDefault();
      const cards = el('homeToolGrid').querySelectorAll('button');
      if (cards.length === 1) cards[0].click();
    }
  });
  homeRoot.querySelectorAll('[data-home-filter]').forEach(button => {
    button.addEventListener('click', () => { activeFilter = button.dataset.homeFilter; renderCatalog(); });
  });
  el('homeResetSearchBtn').addEventListener('click', () => {
    activeFilter = 'all';
    el('homeToolSearch').value = '';
    renderCatalog();
    el('homeToolSearch').focus();
  });
  el('clearRecentHomeBtn').addEventListener('click', async () => { await window.clearRecentFiles(); await renderRecentFiles(); });
  el('homePrivacyBtn').addEventListener('click', async () => {
    if (await window.openTool('settings')) document.querySelector('[data-settings-tab="Privacy"]')?.click();
  });
  el('homeDonateBtn').addEventListener('click', () => window.api.system.openExternal('https://ko-fi.com/carfo'));
  el('dismissSupportBtn').addEventListener('click', async () => {
    await window.updateSettings(all => { all.global = all.global || {}; all.global.supportMilestoneDismissed = true; });
    el('homeSupportCard').hidden = true;
  });
  pasteHandler = event => {
    if (window.isToolActive('home')) acceptFiles(event.detail);
  };
  document.addEventListener('paste-files', pasteHandler);
  searchShortcutHandler = event => {
    if (event.defaultPrevented || event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || !window.isToolActive('home')) return;
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (Array.from(document.querySelectorAll('[aria-modal="true"], dialog[open]')).some(modal =>
      modal.getClientRects().length > 0 && !modal.closest('[aria-hidden="true"]'))) return;
    event.preventDefault();
    el('homeToolSearch').focus();
  };
  document.addEventListener('keydown', searchShortcutHandler);
}

async function init(ctx) {
  log = ctx.log;
  homeRoot = document.querySelector('.home-page');
  bindEvents();
  renderCatalog();
  renderSuggestions();
  await Promise.all([renderRecentFiles(), renderSupportMilestone()]);
}
async function activate() {
  await Promise.all([renderRecentFiles(), renderSupportMilestone()]);
}
function cleanup() {
  if (pasteHandler) document.removeEventListener('paste-files', pasteHandler);
  if (searchShortcutHandler) document.removeEventListener('keydown', searchShortcutHandler);
  pasteHandler = null;
  searchShortcutHandler = null;
}

window.registerTool('home', { init, activate, cleanup });
})();

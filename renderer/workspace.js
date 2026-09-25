// The supported workspace tools also form the navigation allowlist. Old saved
// routes can never load a retired tool simply by guessing its directory name.
(() => {
  'use strict';
  const tools = [
    ['home', 'Home', 'Tools', 'Open files or choose a media tool', 'home start all tools'],
    ['format-converter', 'Format Converter', 'Video & conversion', 'Change an image, video, or audio format', 'convert png jpg webp mp4 mp3 wav'],
    ['video-compressor', 'Video Compressor', 'Video & conversion', 'Make a video smaller and easier to share', 'shrink compress size'],
    ['upscaler', 'Upscaler', 'Video & conversion', 'Increase image or video resolution', 'enlarge upscale resolution ai'],
    ['gif-maker', 'GIF Maker', 'Video & conversion', 'Turn a video clip into a GIF', 'animation loop gif'],
    ['audio-extractor', 'Audio Extractor', 'Audio', 'Save the audio from a video', 'soundtrack extract mp3'],
    ['stem-separator', 'Stem Separator', 'Audio', 'Separate vocals and instruments', 'song music drums bass stems ai'],
    ['tts', 'Text to Speech', 'Audio', 'Read your text with an installed voice', 'speak voice narration tts'],
    ['bg-remover', 'Background Editor', 'Images', 'Remove or replace an image background', 'cutout transparent remove background ai'],
    ['bulk-imager', 'Image Editor', 'Images', 'Crop or flip an image', 'photo crop flip edit'],
    ['qr-studio', 'QR Studio', 'Images', 'Create or scan a QR code', 'qr scan wifi code'],
    ['url-downloader', 'Video Downloader', 'Downloads', 'Save media from a web link', 'url online download link'],
    ['torrent-downloader', 'Torrent Downloader', 'Downloads', 'Download a torrent or magnet link', 'torrent magnet download'],
    ['settings', 'Settings', 'Preferences', 'Appearance, privacy, and components', 'theme light dark offline install media pack']
  ].map(([id, label, category, description, keywords]) => Object.freeze({ id, label, category, description, keywords }));
  window.WORKSPACE_TOOLS = Object.freeze(tools);
  const dialog = document.getElementById('toolSearchDialog');
  const input = document.getElementById('toolSearchInput');
  const results = document.getElementById('toolSearchResults');
  const searchText = new Map(tools.map(tool => [tool.id,
    `${tool.label} ${tool.description} ${tool.category} ${tool.keywords}`.toLowerCase()]));
  const resultNodes = new Map();
  let matches = [];
  let selectedIndex = 0;
  let selectedResult = null;
  let returnFocus = null;

  function select(index) {
    selectedIndex = Math.max(0, Math.min(index, matches.length - 1));
    const selected = results.children[selectedIndex];
    if (selectedResult !== selected) {
      selectedResult?.setAttribute('aria-selected', 'false');
      selected?.setAttribute('aria-selected', 'true');
      selectedResult = selected;
    }
    if (selected) {
      input.setAttribute('aria-activedescendant', selected.id);
      selected.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function close(restoreFocus = true) {
    dialog.close();
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
  }
  async function openTool(id) {
    close(false);
    if (await window.openTool(id)) document.getElementById('toolContent').focus({ preventScroll: true });
    else if (returnFocus?.isConnected) returnFocus.focus();
  }
  function render() {
    const terms = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    matches = tools.filter(tool => terms.every(term => searchText.get(tool.id).includes(term)));
    const fragment = document.createDocumentFragment();
    matches.forEach(tool => {
      let result = resultNodes.get(tool.id);
      if (!result) {
        result = document.createElement('div');
        result.id = `tool-result-${tool.id}`;
        result.className = 'tool-search-result';
        result.setAttribute('role', 'option');
        result.setAttribute('aria-selected', 'false');
        result.innerHTML = `<span><strong>${tool.label}</strong><small>${tool.description}</small></span><span class="search-category">${tool.category}</span>`;
        result.addEventListener('click', () => openTool(tool.id));
        resultNodes.set(tool.id, result);
      }
      fragment.appendChild(result);
    });
    results.replaceChildren(fragment);
    document.getElementById('toolSearchEmpty').hidden = matches.length > 0;
    select(0);
  }
  function openSearch() {
    const modalVisible = Array.from(document.querySelectorAll('[aria-modal="true"]'))
      .some(modal => modal.getClientRects().length > 0 && !modal.closest('[aria-hidden="true"]'));
    if (dialog.open || modalVisible) return;
    returnFocus = document.activeElement;
    input.value = '';
    dialog.showModal();
    render();
    input.focus();
  }
  document.getElementById('toolSearchBtn').addEventListener('click', openSearch);
  document.getElementById('toolSearchClose').addEventListener('click', () => close());
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) close();
  });
  input.addEventListener('input', render);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      select(selectedIndex + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (matches[selectedIndex]) openTool(matches[selectedIndex].id);
    }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
    }
  });
})();

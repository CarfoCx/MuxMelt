import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText, Search, ZoomIn, ZoomOut, MousePointer2, Type, Trash2,
  Lock, ChevronLeft, ChevronRight, Settings, Undo2, Save,
  Copy, Unlock, Loader2, RotateCcw, FolderOpen, ExternalLink,
  ScanText, Underline
} from 'lucide-react';
import PDFViewer, { PageInfo } from './components/PDFViewer';
import ThumbnailSidebar from './components/ThumbnailSidebar';
import { Annotation, useEditorStore } from './store/useEditorStore';

const App = () => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [propsOpen, setPropsOpen] = useState(true);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState('Untitled PDF');
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [renderedPages, setRenderedPages] = useState<PageInfo[]>([]);
  const [pagePreviews, setPagePreviews] = useState<PageInfo[]>([]);
  const [pageTexts, setPageTexts] = useState<{ page: number; text: string }[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCursor, setSearchCursor] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [isDetectingText, setIsDetectingText] = useState(false);
  const [detectedTextPath, setDetectedTextPath] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const viewerRef = useRef<any>(null);

  const {
    activeTool, setTool, zoom, setZoom, currentPage, setCurrentPage, totalPages,
    setTotalPages, annotations, addAnnotation, undo, selectedAnnotationId,
    updateAnnotation, removeAnnotation, duplicateSelected, clear, setSelectedAnnotation
  } = useEditorStore();

  const selectedAnnotation = annotations.find(a => a.id === selectedAnnotationId);

  const reloadPdf = useCallback(async (path = filePath) => {
    if (!path) return;
    setLoadError(null);
    setRenderedPages([]);
    setPagePreviews([]);
    try {
      const renderResult = await window.api.pdfOperation({ operation: 'render', files: [path], dpi: 150 });
      if (!renderResult?.success || !Array.isArray(renderResult.pages)) {
        throw new Error(renderResult?.error || 'The selected PDF could not be rendered.');
      }

      const pages = await Promise.all(renderResult.pages.map(async (page: any) => {
        const dataUrl = await window.api.readImagePreview(page.path);
        if (!dataUrl) throw new Error(`Page ${page.index} could not be rendered.`);
        return {
          id: `page-${page.index}`,
          index: page.index,
          width: page.width,
          height: page.height,
          dataUrl
        };
      }));

      setRenderedPages(pages);
      setPagePreviews(pages);
      setTotalPages(pages.length);
      setDetectedTextPath(null);

      window.api.readPdfFile(path)
        .then((data) => {
          if (data) setPdfData(new Uint8Array(data));
        })
        .catch(() => setPdfData(null));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The selected PDF could not be loaded.';
      setPdfData(null);
      setRenderedPages([]);
      setPagePreviews([]);
      setLoadError(message);
      window.api.showNotification({ title: 'MuxMelt PDF', body: message });
    }
  }, [filePath, setTotalPages]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('sessionId');
    if (!sessionId) {
      setLoadError('No PDF editor session was provided.');
      return;
    }
    window.api.getPdfEditorSession(sessionId).then(async (session: any) => {
      if (!session.success) {
        setLoadError(session.error || 'PDF editor session expired.');
        return;
      }
      setFilePath(session.filePath);
      setFileName(session.fileName || session.filePath.split(/[\\/]/).pop() || 'Document.pdf');
      clear();
      await reloadPdf(session.filePath);
    }).catch((error: any) => {
      setLoadError(error?.message || 'Could not open the PDF editor session.');
    });
  }, [reloadPdf]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isTypingTarget = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
      const key = event.key.toLowerCase();
      const hasModifier = event.ctrlKey || event.metaKey;
      const selectedTextAnnotation = selectedAnnotation && ['text', 'replaceText'].includes(selectedAnnotation.type) ? selectedAnnotation : null;

      if (hasModifier && key === 'b' && selectedTextAnnotation) {
        event.preventDefault();
        updateAnnotation(selectedTextAnnotation.id, { fontWeight: selectedTextAnnotation.fontWeight === 'bold' ? 'normal' : 'bold' });
        return;
      }
      if (hasModifier && key === 'i' && selectedTextAnnotation) {
        event.preventDefault();
        updateAnnotation(selectedTextAnnotation.id, { fontStyle: selectedTextAnnotation.fontStyle === 'italic' ? 'normal' : 'italic' });
        return;
      }
      if (hasModifier && key === 'u' && selectedTextAnnotation) {
        event.preventDefault();
        updateAnnotation(selectedTextAnnotation.id, { textDecoration: selectedTextAnnotation.textDecoration === 'underline' ? 'none' : 'underline' });
        return;
      }
      if (hasModifier && key === 'd' && selectedAnnotation && !isTypingTarget) {
        event.preventDefault();
        duplicateSelected();
        return;
      }
      if (hasModifier && (key === '=' || key === '+')) {
        event.preventDefault();
        setZoom(Math.min(zoom + 0.2, 3.0));
        return;
      }
      if (hasModifier && key === '-') {
        event.preventDefault();
        setZoom(Math.max(zoom - 0.2, 0.5));
        return;
      }
      if (hasModifier && key === '0') {
        event.preventDefault();
        setZoom(1);
        return;
      }
      if (hasModifier && key === 'z') {
        event.preventDefault();
        undo();
        return;
      }
      if (hasModifier && key === 's') {
        event.preventDefault();
        handleSave();
        return;
      }
      if (!hasModifier && !isTypingTarget && key === 'v') {
        setTool('select');
        return;
      }
      if (!hasModifier && !isTypingTarget && key === 't') {
        setTool('text');
        return;
      }
      if (!hasModifier && !isTypingTarget && key === 'r') {
        handleRedactClick();
        return;
      }
      if (event.key === 'Escape') {
        if (!isTypingTarget) {
          setSelectedAnnotation(null);
          setTool('select');
        }
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedAnnotationId && !isTypingTarget) {
          removeAnnotation(selectedAnnotationId);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const isChangedAnnotation = useCallback((ann: Annotation) => {
    if (ann.type === 'redact' || ann.source !== 'textMap') return true;
    return (
      (ann.text || '') !== (ann.originalText || '') ||
      Math.round(ann.x) !== Math.round(ann.originalX ?? ann.x) ||
      Math.round(ann.y) !== Math.round(ann.originalY ?? ann.y) ||
      Math.round(ann.w || 0) !== Math.round(ann.originalW ?? ann.w ?? 0) ||
      Math.round(ann.h || 0) !== Math.round(ann.originalH ?? ann.h ?? 0) ||
      Math.round(ann.fontSize || 0) !== Math.round(ann.originalFontSize ?? ann.fontSize ?? 0) ||
      (ann.color || '#111111').toLowerCase() !== (ann.originalColor || ann.color || '#111111').toLowerCase() ||
      ann.fontWeight === 'bold' ||
      ann.fontStyle === 'italic' ||
      ann.textDecoration === 'underline' ||
      (ann.lineHeight || 1.2) !== 1.2 ||
      (ann.textAlign || 'left') !== 'left'
    );
  }, []);
  const dirtyAnnotations = useMemo(() => annotations.filter(isChangedAnnotation), [annotations, isChangedAnnotation]);
  const dirtyCount = dirtyAnnotations.length;
  const detectedTextCount = useMemo(() => annotations.filter((ann) => ann.source === 'textMap').length, [annotations]);
  const addedTextCount = useMemo(() => annotations.filter((ann) => ann.type === 'text').length, [annotations]);
  const redactionCount = useMemo(() => annotations.filter((ann) => ann.type === 'redact').length, [annotations]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return pageTexts.filter((page) => page.text.toLowerCase().includes(q));
  }, [pageTexts, searchQuery]);

  const goToSearchResult = (direction = 1) => {
    if (!searchResults.length) return;
    const next = (searchCursor + direction + searchResults.length) % searchResults.length;
    setSearchCursor(next);
    const page = searchResults[next].page;
    setCurrentPage(page);
    viewerRef.current?.scrollToPage(page - 1);
  };

  const handlePageSelect = (index: number) => {
    setCurrentPage(index + 1);
    viewerRef.current?.scrollToPage(index);
  };

  const handleLayerSelect = (annotation: Annotation) => {
    setSelectedAnnotation(annotation.id);
    setCurrentPage(annotation.page);
    viewerRef.current?.scrollToPage(annotation.page - 1);
  };

  const handleEditTextClick = () => {
    if (!detectedTextCount) {
      handleDetectEditableText({ quiet: true });
      return;
    }
    setTool('select');
    setSidebarOpen(true);
    setPropsOpen(true);
  };

  const addTextMapItems = useCallback((items: any[]) => {
    items.forEach((item: any) => {
      const width = Math.max(item.w, 16);
      const height = Math.max(item.h, item.fontSize || 12);
      addAnnotation({
        id: `textmap-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: 'replaceText',
        page: item.page,
        x: item.x,
        y: item.y,
        w: width,
        h: height,
        text: item.text || '',
        originalText: item.text || '',
        originalX: item.x,
        originalY: item.y,
        originalW: width,
        originalH: height,
        originalFontSize: Math.max(6, Math.round(item.fontSize || 12)),
        originalColor: item.color || '#111111',
        source: 'textMap',
        fontSize: Math.max(6, Math.round(item.fontSize || 12)),
        fontFamily: 'Helvetica',
        fontWeight: 'normal',
        fontStyle: 'normal',
        textDecoration: 'none',
        textAlign: 'left',
        color: item.color || '#111111',
        fill: '#ffffff',
        borderColor: '#38bdf8',
        opacity: 1
      });
    });
  }, [addAnnotation]);

  const handleDetectEditableText = useCallback(async (options: { ocr?: boolean; quiet?: boolean; path?: string } = {}) => {
    const targetPath = options.path || filePath;
    if (!targetPath || isDetectingText) return;
    if (annotations.some((ann) => ann.source === 'textMap')) {
      return;
    }
    setIsDetectingText(true);
    const res = await window.api.pdfOperation({ operation: 'text-map', files: [targetPath], ocr: options.ocr !== false });
    setIsDetectingText(false);
    if (!res.success) {
      if (!options.quiet) window.api.showNotification({ title: 'MuxMelt PDF', body: res.error || 'Text detection failed.' });
      return;
    }

    const items = Array.isArray(res.items) ? res.items : [];
    if (!items.length) {
      const detail = res.ocrError ? ` OCR was attempted but is unavailable: ${res.ocrError}` : '';
      if (!options.quiet) window.api.showNotification({ title: 'MuxMelt PDF', body: `No editable text was detected.${detail}` });
      return;
    }

    addTextMapItems(items);
    setPageTexts(items.reduce((pages: { page: number; text: string }[], item: any) => {
      const pageNumber = Number(item.page || 1);
      const existing = pages.find((page) => page.page === pageNumber);
      if (existing) existing.text += ` ${item.text || ''}`;
      else pages.push({ page: pageNumber, text: item.text || '' });
      return pages;
    }, []));
    setTool('select');
    const source = res.ocrUsed ? 'OCR/text' : 'PDF text';
    if (!options.quiet) window.api.showNotification({ title: 'MuxMelt PDF', body: `${items.length} editable ${source} object${items.length === 1 ? '' : 's'} created.` });
  }, [addTextMapItems, annotations, filePath, isDetectingText, setTool]);

  useEffect(() => {
    if (!filePath || !renderedPages.length || detectedTextPath === filePath || annotations.some((ann) => ann.source === 'textMap')) return;
    setDetectedTextPath(filePath);
    handleDetectEditableText({ ocr: false, quiet: true, path: filePath });
  }, [filePath, renderedPages.length, detectedTextPath, annotations, handleDetectEditableText]);

  const handleRedactClick = () => {
    if (selectedAnnotation && selectedAnnotation.type === 'replaceText') {
      updateAnnotation(selectedAnnotation.id, {
        type: 'redact',
        text: '',
        x: selectedAnnotation.originalX ?? selectedAnnotation.x,
        y: selectedAnnotation.originalY ?? selectedAnnotation.y,
        w: selectedAnnotation.originalW ?? selectedAnnotation.w,
        h: selectedAnnotation.originalH ?? selectedAnnotation.h,
        color: '#000000',
        fill: '#000000',
        borderColor: '#000000',
        opacity: 1
      });
      return;
    }
    setTool('redact');
  };

  const resetAnnotationToOriginal = (annotation: Annotation) => {
    if (annotation.type !== 'replaceText' || annotation.source !== 'textMap') return;
    updateAnnotation(annotation.id, {
      text: annotation.originalText || '',
      x: annotation.originalX ?? annotation.x,
      y: annotation.originalY ?? annotation.y,
      w: annotation.originalW ?? annotation.w,
      h: annotation.originalH ?? annotation.h,
      fontSize: annotation.originalFontSize ?? annotation.fontSize,
      color: annotation.originalColor ?? annotation.color,
      fontWeight: 'normal',
      fontStyle: 'normal',
      textDecoration: 'none',
      lineHeight: 1.2,
      textAlign: 'left'
    });
  };

  const handleSave = async (options: { afterRedactionApply?: boolean } = {}) => {
    if (!filePath || isSaving) return;
    if (!dirtyAnnotations.length) {
      if (!options.afterRedactionApply) {
        window.api.showNotification({ title: 'MuxMelt PDF', body: 'No PDF edits to save.' });
      }
      return;
    }
    setIsSaving(true);
    const rects: any[] = [];
    const covers: any[] = [];
    const edits: any[] = [];

    dirtyAnnotations.forEach((ann) => {
      const rect = { page: ann.page, x: ann.x, y: ann.y, w: ann.w || 0, h: ann.h || 0 };
      if (ann.type === 'redact') rects.push({ ...rect, fill: '#000000' });
    });

    dirtyAnnotations.forEach((ann) => {
      const rect = { page: ann.page, x: ann.x, y: ann.y, w: ann.w || 0, h: ann.h || 0 };
      if (ann.type === 'redact') return;
      if (ann.type === 'text' || ann.type === 'replaceText') {
        if (ann.type === 'replaceText') {
          covers.push({
            page: ann.page,
            x: ann.originalX ?? ann.x,
            y: ann.originalY ?? ann.y,
            w: ann.originalW ?? ann.w ?? 0,
            h: ann.originalH ?? ann.h ?? 0,
            fill: ann.fill || '#ffffff'
          });
        }
        edits.push({ ...rect, text: ann.text || '', size: ann.fontSize || 14, color: ann.color || '#111111', fontFamily: ann.fontFamily || 'Helvetica', fontWeight: ann.fontWeight || 'normal', fontStyle: ann.fontStyle || 'normal', textDecoration: ann.textDecoration || 'none', align: ann.textAlign || 'left', lineHeight: ann.lineHeight || 1.2 });
      }
    });

    try {
      const res = await window.api.pdfOperation({ operation: 'edit', files: [filePath], rects, covers, edits });
      if (res.success) {
        if (res.output) setLastOutput(res.output);
        if (!options.afterRedactionApply) {
          window.api.showNotification({ title: 'MuxMelt PDF', body: 'Saved an edited PDF copy.' });
        }
        if (options.afterRedactionApply) {
          setSelectedAnnotation(null);
          setTool('select');
        }
      } else {
        window.api.showNotification({ title: 'MuxMelt PDF', body: res.error || 'Save failed.' });
      }
    } catch (error: any) {
      window.api.showNotification({ title: 'MuxMelt PDF', body: error?.message || 'Save failed.' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleApplyRedaction = () => {
    handleSave({ afterRedactionApply: true });
  };

  const openOutputFolder = () => {
    if (!lastOutput) return;
    const normalized = lastOutput.replace(/\\/g, '/');
    window.api.openFolder(normalized.split('/').slice(0, -1).join('/'));
  };

  const openOutputFile = () => {
    if (!lastOutput) return;
    window.api.openPath(lastOutput);
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#111318] font-sans text-zinc-100 select-none">
      <header className="h-14 border-b border-zinc-800 bg-[#191c22] flex items-center justify-between px-3 z-50">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 min-w-[190px]">
            <div className="w-8 h-8 bg-red-600 rounded-md flex items-center justify-center shadow-lg shadow-red-950/20"><FileText size={18} /></div>
            <div className="min-w-0">
              <div className="text-sm font-bold leading-none truncate max-w-[220px]">{fileName}</div>
              <div className="text-[10px] text-zinc-500 mt-1">{dirtyCount ? `${dirtyCount} pending object${dirtyCount === 1 ? '' : 's'}` : 'Ready'}</div>
            </div>
          </div>

          <ToolbarGroup>
            <ToolButton icon={MousePointer2} label="Select" active={activeTool === 'select'} onClick={() => setTool('select')} title="Select (V)" />
            <ToolButton icon={Type} label="Add text" active={activeTool === 'text'} onClick={() => setTool('text')} title="Add text (T)" />
            <ToolButton icon={Lock} label="Redact" active={activeTool === 'redact'} onClick={handleRedactClick} title={selectedAnnotation?.type === 'replaceText' ? 'Redact selected text (R)' : 'Draw redaction box (R)'} />
          </ToolbarGroup>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative hidden xl:block">
            <Search size={14} className="absolute left-2 top-2.5 text-zinc-500" />
            <input value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setSearchCursor(0); }} onKeyDown={(e) => { if (e.key === 'Enter') goToSearchResult(e.shiftKey ? -1 : 1); }} className="h-9 w-56 rounded-md border border-zinc-800 bg-zinc-950 pl-8 pr-16 text-xs outline-none focus:border-red-500" placeholder="Find text" />
            <span className="absolute right-2 top-2.5 text-[10px] text-zinc-500">{searchResults.length}</span>
          </div>
          <ToolbarGroup>
            <button onClick={() => setZoom(Math.max(zoom - 0.2, 0.5))} className="toolbar-btn" title="Zoom out (Ctrl+-)"><ZoomOut size={16} /></button>
            <span className="w-12 text-center text-xs font-bold">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(Math.min(zoom + 0.2, 3.0))} className="toolbar-btn" title="Zoom in (Ctrl++)"><ZoomIn size={16} /></button>
          </ToolbarGroup>
          <button onClick={undo} className="toolbar-btn" title="Undo (Ctrl+Z)"><Undo2 size={17} /></button>
          <button onClick={openOutputFolder} disabled={!lastOutput} className="h-9 rounded-md border border-zinc-800 bg-zinc-950/70 px-3 text-xs font-bold text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-40 flex items-center gap-2">
            <FolderOpen size={14} />
            Open Output Folder
          </button>
          <button onClick={openOutputFile} disabled={!lastOutput} className="h-9 rounded-md border border-zinc-800 bg-zinc-950/70 px-3 text-xs font-bold text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-40 flex items-center gap-2">
            <ExternalLink size={14} />
            Open Output File
          </button>
          <button onClick={() => handleSave()} disabled={isSaving || !filePath || dirtyCount === 0} title="Save copy (Ctrl+S)" className="h-9 rounded-md bg-red-600 px-4 text-xs font-bold text-white hover:bg-red-500 disabled:opacity-50 flex items-center gap-2">
            {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save Copy
          </button>
        </div>
      </header>

      {activeTool === 'redact' && (
        <div className="flex h-8 items-center border-b border-zinc-800 bg-[#171a20] px-4 text-xs text-zinc-300">
          <Lock size={13} className="mr-2 shrink-0 text-red-400" />
          <span className="truncate">Redaction mode: drag over text or an area. Select a redaction box and use its Apply Redaction button.</span>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden relative">
        <aside className={`${sidebarOpen ? 'w-72' : 'w-0'} transition-all duration-300 border-r border-zinc-800 bg-[#191c22] flex flex-col overflow-hidden`}>
          <ThumbnailSidebar
            pages={pagePreviews}
            currentPage={currentPage}
            onPageSelect={handlePageSelect}
            annotations={annotations}
            selectedAnnotationId={selectedAnnotationId}
            onLayerSelect={handleLayerSelect}
          />
        </aside>
        {!sidebarOpen && <EdgeButton side="left" onClick={() => setSidebarOpen(true)} />}

        <main className="flex-1 overflow-auto bg-[#101216]" onMouseDown={(event) => {
          if (event.target === event.currentTarget && activeTool === 'select') setSelectedAnnotation(null);
        }}>
          {renderedPages.length || pdfData ? (
            <PDFViewer ref={viewerRef} data={pdfData} renderedPages={renderedPages} zoom={zoom} onPageChange={setCurrentPage} onTotalPages={setTotalPages} onPagesRendered={setPagePreviews} onTextExtracted={setPageTexts} onLoadError={setLoadError} onApplyRedaction={handleApplyRedaction} isApplyingRedaction={isSaving} />
          ) : loadError ? (
            <div className="h-full w-full flex flex-col items-center justify-center gap-4 px-8 text-center">
              <div className="w-12 h-12 rounded-md border border-red-900/60 bg-red-950/30 flex items-center justify-center">
                <FileText size={22} className="text-red-300" />
              </div>
              <div>
                <div className="text-sm font-bold text-zinc-100">PDF could not be loaded</div>
                <div className="mt-2 max-w-xl text-xs leading-5 text-zinc-400">{loadError}</div>
              </div>
              <button onClick={() => reloadPdf()} className="secondary-btn">Try again</button>
            </div>
          ) : (
            <div className="h-full w-full flex flex-col items-center justify-center gap-4">
              <div className="w-12 h-12 border-4 border-red-500/20 border-t-red-500 rounded-full animate-spin" />
              <span className="text-zinc-500 text-sm font-medium">Initializing PDF engine</span>
            </div>
          )}
        </main>

        <aside className={`${propsOpen ? 'w-80' : 'w-0'} transition-all duration-300 border-l border-zinc-800 bg-[#191c22] flex flex-col overflow-hidden`}>
          <div className="p-4 flex items-center justify-between border-b border-zinc-800 bg-[#20242c]">
            <div className="flex items-center gap-2"><Settings size={14} className="text-cyan-400" /><span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Inspector</span></div>
            <button onClick={() => setPropsOpen(false)} className="hover:text-white text-zinc-500"><ChevronRight size={16} /></button>
          </div>
          <Inspector
            selectedAnnotation={selectedAnnotation}
            updateAnnotation={updateAnnotation}
            removeAnnotation={removeAnnotation}
            duplicateSelected={duplicateSelected}
            onResetToOriginal={resetAnnotationToOriginal}
            onDetectText={handleDetectEditableText}
            onEditText={handleEditTextClick}
            onAddText={() => setTool('text')}
            onRedact={() => setTool('redact')}
            isDetectingText={isDetectingText}
            lastOutput={lastOutput}
            detectedTextCount={detectedTextCount}
            addedTextCount={addedTextCount}
            redactionCount={redactionCount}
            dirtyCount={dirtyCount}
          />
        </aside>
        {!propsOpen && <EdgeButton side="right" onClick={() => setPropsOpen(true)} />}
      </div>

      <footer className="h-7 border-t border-zinc-800 bg-[#111318] flex items-center justify-between px-4 text-[10px] text-zinc-500 font-bold uppercase tracking-tight">
        <div className="flex gap-5 items-center">
          <span className="flex items-center gap-1.5 text-zinc-300"><span className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />Page {currentPage} of {totalPages}</span>
          <span>Mode: {activeTool === 'text' ? 'add text' : activeTool === 'redact' ? 'redact' : 'select'}</span>
          <span>{detectedTextCount} text layers</span>
          {redactionCount > 0 && <span>{redactionCount} redaction area{redactionCount === 1 ? '' : 's'}</span>}
          {searchQuery && <span>{searchResults.length} search matches</span>}
        </div>
        <span className="text-zinc-500">MuxMelt PDF Text and Redaction Editor</span>
      </footer>
    </div>
  );
};

const ToolbarGroup = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950/70 p-1 shadow-inner">{children}</div>
);

const ToolButton = ({ icon: Icon, label, active, onClick, title, disabled, spinning }: any) => (
  <button onClick={onClick} title={title} disabled={disabled} className={`toolbar-action ${active ? 'bg-red-600 text-white shadow-lg shadow-red-950/30' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'}`}>
    <Icon size={16} className={spinning ? 'animate-spin' : ''} />
    {label && <span>{label}</span>}
  </button>
);

const EdgeButton = ({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) => (
  <button onClick={onClick} className={`absolute ${side}-0 top-1/2 z-50 -translate-y-1/2 bg-[#191c22] border border-zinc-800 p-1.5 ${side === 'left' ? 'rounded-r-md' : 'rounded-l-md'} text-zinc-500 hover:text-white shadow-xl`}>
    {side === 'left' ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
  </button>
);

const Inspector = ({ selectedAnnotation, updateAnnotation, removeAnnotation, duplicateSelected, onResetToOriginal, onDetectText, onEditText, onAddText, onRedact, isDetectingText, lastOutput, detectedTextCount, addedTextCount, redactionCount, dirtyCount }: {
  selectedAnnotation?: Annotation;
  updateAnnotation: (id: string, updates: Partial<Annotation>) => void;
  removeAnnotation: (id: string) => void;
  duplicateSelected: () => void;
  onResetToOriginal: (annotation: Annotation) => void;
  onDetectText: () => void;
  onEditText: () => void;
  onAddText: () => void;
  onRedact: () => void;
  isDetectingText: boolean;
  lastOutput: string | null;
  detectedTextCount: number;
  addedTextCount: number;
  redactionCount: number;
  dirtyCount: number;
}) => (
  <div className="p-5 space-y-7 overflow-y-auto">
    {selectedAnnotation ? (
      <PropertySection title={`${selectedAnnotation.type === 'replaceText' ? 'existing text' : selectedAnnotation.type} properties`}>
        {['text', 'replaceText'].includes(selectedAnnotation.type) && (
          <TextControls ann={selectedAnnotation} updateAnnotation={updateAnnotation} onResetToOriginal={onResetToOriginal} />
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1"><span className="label">X</span><input type="number" value={Math.round(selectedAnnotation.x)} onChange={(e) => updateAnnotation(selectedAnnotation.id, { x: Number(e.target.value) })} className="input" /></label>
          <label className="space-y-1"><span className="label">Y</span><input type="number" value={Math.round(selectedAnnotation.y)} onChange={(e) => updateAnnotation(selectedAnnotation.id, { y: Number(e.target.value) })} className="input" /></label>
          <label className="space-y-1"><span className="label">Width</span><input type="number" value={Math.round(selectedAnnotation.w || 0)} onChange={(e) => updateAnnotation(selectedAnnotation.id, { w: Number(e.target.value) })} className="input" /></label>
          <label className="space-y-1"><span className="label">Height</span><input type="number" value={Math.round(selectedAnnotation.h || 0)} onChange={(e) => updateAnnotation(selectedAnnotation.id, { h: Number(e.target.value) })} className="input" /></label>
        </div>
        {selectedAnnotation.type !== 'redact' && <div className="flex items-center justify-between"><span className="label">Color</span><input type="color" value={(selectedAnnotation.color || '#111111').slice(0, 7)} onChange={(e) => updateAnnotation(selectedAnnotation.id, { color: e.target.value })} className="h-8 w-10 rounded bg-transparent" /></div>}
        {selectedAnnotation.type === 'redact' ? (
          <div className="rounded-md border border-red-900/50 bg-red-950/20 p-3 text-[11px] leading-4 text-red-100">This area is locked and will be removed from the saved output when you apply redaction. Delete and redraw it if the selection is wrong.</div>
        ) : (
          <Toggle label="Lock object" checked={!!selectedAnnotation.locked} onChange={(v) => updateAnnotation(selectedAnnotation.id, { locked: v })} icon={selectedAnnotation.locked ? Lock : Unlock} />
        )}
        <div className="grid grid-cols-2 gap-3">
          <button onClick={duplicateSelected} className="secondary-btn"><Copy size={13} />Duplicate</button>
          <button onClick={() => removeAnnotation(selectedAnnotation.id)} className="danger-btn"><Trash2 size={13} />Delete</button>
        </div>
      </PropertySection>
    ) : (
      <>
        <PropertySection title="Document">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Detected text" value={detectedTextCount} />
            <Stat label="Pending edits" value={dirtyCount} />
            <Stat label="Added text" value={addedTextCount} />
            <Stat label="Redactions" value={redactionCount} />
          </div>
        </PropertySection>
        <PropertySection title="Actions">
          <button onClick={onEditText} disabled={isDetectingText} className="large-action disabled:cursor-wait disabled:opacity-60"><ScanText size={19} className="text-sky-400" /><span><b>{isDetectingText ? 'Detecting text' : 'Edit detected text'}</b><small>{detectedTextCount ? `${detectedTextCount} text layer${detectedTextCount === 1 ? '' : 's'} ready` : 'Find PDF text layers'}</small></span></button>
          <button onClick={onAddText} className="large-action"><Type size={19} className="text-emerald-400" /><span><b>Add text</b><small>Create a new text layer</small></span></button>
          <button onClick={onRedact} className="large-action"><Lock size={19} className="text-red-400" /><span><b>Redact</b><small>Draw a secure redaction area</small></span></button>
        </PropertySection>
        {lastOutput && <PropertySection title="Last saved"><div className="rounded-md border border-emerald-900/40 bg-emerald-950/20 p-3 text-xs text-emerald-200 break-all">{lastOutput}</div></PropertySection>}
      </>
    )}
  </div>
);

const TextControls = ({ ann, updateAnnotation, onResetToOriginal }: { ann: Annotation; updateAnnotation: (id: string, updates: Partial<Annotation>) => void; onResetToOriginal: (annotation: Annotation) => void }) => (
  <>
        {ann.source === 'textMap' && <div className="rounded-md border border-sky-900/50 bg-sky-950/20 p-2 text-[11px] leading-4 text-sky-200">This edits detected PDF text. Saving securely removes the original text area and writes your edited text into a new output PDF.</div>}
    <label className="block space-y-1"><span className="label">Text</span><textarea spellCheck value={ann.text || ''} onChange={(e) => updateAnnotation(ann.id, { text: e.target.value })} className="input min-h-24 resize-y p-2" /></label>
    <label className="space-y-1 block">
      <span className="label">Font</span>
      <select value={ann.fontFamily || 'Helvetica'} onChange={(e) => updateAnnotation(ann.id, { fontFamily: e.target.value })} className="input">
        <option value="Helvetica">Helvetica</option>
        <option value="Times">Times</option>
        <option value="Courier">Courier</option>
      </select>
    </label>
    <div className="grid grid-cols-2 gap-3">
      <label className="space-y-1"><span className="label">Font size</span><input type="number" min="6" max="96" value={ann.fontSize || 12} onChange={(e) => updateAnnotation(ann.id, { fontSize: Number(e.target.value) })} className="input" /></label>
      <label className="space-y-1"><span className="label">Align</span><select value={ann.textAlign || 'left'} onChange={(e) => updateAnnotation(ann.id, { textAlign: e.target.value as any })} className="input"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
    </div>
    <div className="grid grid-cols-2 gap-3">
      <label className="space-y-1"><span className="label">Line spacing</span><input type="number" min="0.8" max="3" step="0.1" value={ann.lineHeight || 1.2} onChange={(e) => updateAnnotation(ann.id, { lineHeight: Number(e.target.value) })} className="input" /></label>
      <label className="space-y-1"><span className="label">Layout</span><select value={(ann.w || 0) > 260 ? 'wide' : 'normal'} onChange={(e) => updateAnnotation(ann.id, e.target.value === 'wide' ? { w: Math.max(320, ann.w || 0), h: Math.max(72, ann.h || 0) } : { w: Math.min(220, ann.w || 220), h: Math.max(48, ann.h || 0) })} className="input"><option value="normal">Normal box</option><option value="wide">Wide box</option></select></label>
    </div>
    <div className="grid grid-cols-3 gap-3">
      <button onClick={() => updateAnnotation(ann.id, { fontWeight: ann.fontWeight === 'bold' ? 'normal' : 'bold' })} className={ann.fontWeight === 'bold' ? 'primary-toggle' : 'secondary-btn'} title="Bold (Ctrl+B)">B</button>
      <button onClick={() => updateAnnotation(ann.id, { fontStyle: ann.fontStyle === 'italic' ? 'normal' : 'italic' })} className={ann.fontStyle === 'italic' ? 'primary-toggle italic' : 'secondary-btn italic'} title="Italic (Ctrl+I)">I</button>
      <button
        onClick={() => updateAnnotation(ann.id, { textDecoration: ann.textDecoration === 'underline' ? 'none' : 'underline' })}
        className={ann.textDecoration === 'underline' ? 'primary-toggle' : 'secondary-btn'}
        title="Underline (Ctrl+U)"
      >
        <Underline size={14} />
      </button>
    </div>
    {ann.source === 'textMap' && (
      <button onClick={() => onResetToOriginal(ann)} className="secondary-btn w-full"><RotateCcw size={13} />Reset original</button>
    )}
  </>
);

const Toggle = ({ label, checked, onChange, icon: Icon }: { label: string; checked: boolean; onChange: (checked: boolean) => void; icon?: any }) => (
  <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-xs text-zinc-300">
    <span className="flex items-center gap-2">{Icon && <Icon size={13} />}{label}</span>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-red-500" />
  </label>
);

const Stat = ({ label, value }: { label: string; value: number }) => (
  <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
    <div className="text-lg font-bold text-zinc-100">{value}</div>
    <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{label}</div>
  </div>
);

const PropertySection = ({ title, children }: any) => <section className="space-y-4"><h4 className="text-[10px] font-bold text-zinc-500 uppercase tracking-[0.2em]">{title}</h4>{children}</section>;

export default App;

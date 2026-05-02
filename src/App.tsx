import React, { useState, useEffect, useRef } from 'react';
import { 
  FileText, Search, ZoomIn, ZoomOut, RotateCw, 
  Trash2, MousePointer2, Type, Square, Circle, 
  Edit3, StickyNote, Lock, Download, Printer,
  PanelLeft, PanelRight, ChevronLeft, ChevronRight,
  Layers, Settings, User, Undo2, Save, PenTool,
  Highlighter, ShieldAlert, PenLine
} from 'lucide-react';
import PDFViewer, { PageInfo } from './components/PDFViewer';
import ThumbnailSidebar from './components/ThumbnailSidebar';
import SignaturePad from './components/SignaturePad';
import { useEditorStore } from './store/useEditorStore';

const App = () => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [propsOpen, setPropsOpen] = useState(true);
  const [sigPadOpen, setSigPadOpen] = useState(false);
  const viewerRef = useRef<any>(null);
  
  // Zustand Store
  const { 
    activeTool, setTool, zoom, setZoom, 
    currentPage, setCurrentPage, 
    totalPages, setTotalPages,
    annotations, addAnnotation, undo, selectedAnnotationId,
    updateAnnotation, removeAnnotation
  } = useEditorStore();

  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [pagePreviews, setPagePreviews] = useState<PageInfo[]>([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sId = params.get('sessionId');
    if (sId) {
      window.api.getPdfEditorSession(sId).then(async (session: any) => {
        if (session.success) {
          setFilePath(session.filePath);
          const data = await window.api.readPdfFile(session.filePath);
          setPdfData(data);
        }
      });
    }
  }, []);

  const handleZoomIn = () => setZoom(Math.min(zoom + 0.2, 3.0));
  const handleZoomOut = () => setZoom(Math.max(zoom - 0.2, 0.5));

  const handlePageSelect = (index: number) => {
    setCurrentPage(index + 1);
    viewerRef.current?.scrollToPage(index);
  };

  const handleRotate = async (index: number) => {
    if (!filePath) return;
    const res = await window.api.pdfOperation({ operation: 'rotate', inputPath: filePath, pageIndex: index, degrees: 90 });
    if (res.success) {
      window.api.showNotification({ title: 'MuxMelt PDF', body: `Page ${index + 1} rotated.` });
      setPdfUrl(`file://${filePath}?t=${Date.now()}`);
    }
  };

  const handleDelete = async (index: number) => {
    if (!filePath || !confirm('Permanently delete this page?')) return;
    const res = await window.api.pdfOperation({ operation: 'delete', inputPath: filePath, pageIndex: index });
    if (res.success) {
      window.api.showNotification({ title: 'MuxMelt PDF', body: `Page ${index + 1} removed.` });
      setPdfUrl(`file://${filePath}?t=${Date.now()}`);
    }
  };

  const handleInsertSignature = (dataUrl: string) => {
    const id = `sig-${Date.now()}`;
    addAnnotation({
      id,
      type: 'freehand',
      page: currentPage,
      x: 100, y: 100, w: 200, h: 100,
      color: '#000000',
      text: dataUrl, // We store the dataUrl in the text field for now
      opacity: 1
    });
    setSigPadOpen(false);
    window.api.showNotification({ title: 'MuxMelt PDF', body: 'Signature inserted. Drag to reposition.' });
  };

  const handleSave = async () => {
    if (!filePath) return;
    const rects: any[] = [];
    const covers: any[] = [];
    const highlights: any[] = [];
    const edits: any[] = [];
    const paths: any[] = [];

    annotations.forEach(ann => {
      const rect = { page: ann.page, x: ann.x, y: ann.y, w: ann.w, h: ann.h };
      if (ann.type === 'redact') rects.push({ ...rect, fill: '#000000' });
      else if (ann.type === 'highlight') highlights.push({ ...rect, type: 'highlight', stroke: ann.color, fill: ann.fill, opacity: ann.opacity });
      else if (['rect', 'circle'].includes(ann.type)) {
        highlights.push({ ...rect, type: ann.type, stroke: ann.color, fill: ann.fill, opacity: ann.opacity });
      }
      else if (ann.type === 'freehand' && ann.text?.startsWith('data:image')) {
         console.log('Save signature at', rect);
      }
    });

    const res = await window.api.pdfOperation({
      operation: 'edit',
      files: [filePath],
      rects, covers, highlights, edits, paths
    });

     if (res.success) {
        window.api.showNotification({ title: 'MuxMelt PDF', body: 'All changes saved to document.' });
     }
  };

  const selectedAnnotation = annotations.find(a => a.id === selectedAnnotationId);

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0b0e14] text-slate-200 overflow-hidden select-none font-sans">
      {/* Top Toolbar */}
      <header className="h-14 border-b border-slate-800 bg-[#151921] flex items-center justify-between px-4 z-50">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
             <div className="w-8 h-8 bg-rose-600 rounded-lg flex items-center justify-center shadow-lg shadow-rose-900/20">
                <FileText size={18} className="text-white" />
             </div>
              <div className="flex flex-col">
                <span className="text-sm font-bold tracking-tight text-white leading-none">MuxMelt PDF</span>
              </div>
          </div>
          
          <div className="h-8 w-[1px] bg-slate-800 mx-2" />
          
          <div className="flex items-center gap-1 bg-slate-900/80 p-1 rounded-lg border border-slate-800/50 shadow-inner">
            <ToolButton icon={MousePointer2} active={activeTool === 'select'} onClick={() => setTool('select')} title="Select (V)" />
            <ToolButton icon={Type} active={activeTool === 'text'} onClick={() => setTool('text')} title="Edit Text (T)" />
            <ToolButton icon={StickyNote} active={activeTool === 'note'} onClick={() => setTool('note')} title="Add Note (N)" />
          </div>

          <div className="flex items-center gap-1 bg-slate-900/80 p-1 rounded-lg border border-slate-800/50 shadow-inner">
            <ToolButton icon={Square} active={activeTool === 'rect'} onClick={() => setTool('rect')} title="Rectangle" />
            <ToolButton icon={Circle} active={activeTool === 'circle'} onClick={() => setTool('circle')} title="Circle" />
          </div>

          <div className="flex items-center gap-1 bg-slate-900/80 p-1 rounded-lg border border-slate-800/50 shadow-inner ml-2">
            <ToolButton icon={ShieldAlert} active={activeTool === 'redact'} onClick={() => setTool('redact')} title="Secure Redact (Privacy)" />
            <ToolButton icon={Highlighter} active={activeTool === 'highlight'} onClick={() => setTool('highlight')} title="Highlight Text" />
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 bg-slate-900/80 px-3 py-1.5 rounded-lg border border-slate-800/50">
            <button onClick={handleZoomOut} className="hover:text-white text-slate-400 transition-colors"><ZoomOut size={16} /></button>
            <span className="text-xs font-bold w-12 text-center text-slate-200">{Math.round(zoom * 100)}%</span>
            <button onClick={handleZoomIn} className="hover:text-white text-slate-400 transition-colors"><ZoomIn size={16} /></button>
          </div>
          
          <div className="h-8 w-[1px] bg-slate-800" />
          
          <div className="flex items-center gap-1">
             <button onClick={undo} className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-all" title="Undo (Ctrl+Z)"><Undo2 size={18} /></button>
             <button onClick={handleSave} className="p-2 bg-rose-600 hover:bg-rose-500 text-white rounded-lg px-4 py-2 text-xs font-bold transition-all shadow-lg shadow-rose-900/20 flex items-center gap-2">
                <Save size={14} />
                Save PDF
             </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden relative">
        <aside className={`${sidebarOpen ? 'w-64' : 'w-0'} transition-all duration-300 border-r border-slate-800 bg-[#151921] flex flex-col overflow-hidden`}>
          <ThumbnailSidebar 
            pages={pagePreviews} currentPage={currentPage}
            onPageSelect={handlePageSelect} onRotate={handleRotate} onDelete={handleDelete}
            onReorder={() => {}}
          />
        </aside>

        {!sidebarOpen && (
          <button onClick={() => setSidebarOpen(true)} className="absolute left-0 top-1/2 -translate-y-1/2 bg-[#151921] border border-slate-800 p-1.5 rounded-r-lg z-50 hover:text-white text-slate-500 shadow-xl transition-all"><ChevronRight size={16} /></button>
        )}

        <main className="flex-1 bg-[#0b0e14] overflow-auto flex flex-col items-center scrollbar-thin scrollbar-thumb-slate-800">
          {pdfData ? (
            <PDFViewer ref={viewerRef} data={pdfData} zoom={zoom} onPageChange={setCurrentPage} onTotalPages={setTotalPages} onPagesRendered={setPagePreviews} />
          ) : (
            <div className="h-full w-full flex flex-col items-center justify-center space-y-4">
               <div className="w-12 h-12 border-4 border-rose-500/20 border-t-rose-500 rounded-full animate-spin" />
               <span className="text-slate-500 text-sm font-medium animate-pulse">Initializing PDF Engine...</span>
            </div>
          )}
        </main>

        <aside className={`${propsOpen ? 'w-72' : 'w-0'} transition-all duration-300 border-l border-slate-800 bg-[#151921] flex flex-col overflow-hidden`}>
          <div className="p-4 flex items-center justify-between border-b border-slate-800/50 bg-[#1a1f29]">
             <div className="flex items-center gap-2">
                <Settings size={14} className="text-rose-500" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Properties</span>
             </div>
            <button onClick={() => setPropsOpen(false)} className="hover:text-white text-slate-500"><ChevronRight size={16} /></button>
          </div>
          
          <div className="p-6 space-y-8 overflow-y-auto">
            {selectedAnnotation ? (
               <PropertySection title={`${selectedAnnotation.type.toUpperCase()} Style`}>
                  <div className="space-y-4">
                     <div className="flex items-center justify-between group">
                        <span className="text-xs text-slate-400">Main Color</span>
                        <input type="color" value={selectedAnnotation.fill?.slice(0, 7) || '#f43f5e'} onChange={(e) => updateAnnotation(selectedAnnotation.id, { fill: e.target.value + '33', color: e.target.value })} className="w-6 h-6 rounded-md bg-transparent border-none cursor-pointer" />
                     </div>
                     <div className="space-y-2">
                        <div className="flex items-center justify-between">
                           <span className="text-xs text-slate-400">Opacity</span>
                           <span className="text-[10px] font-bold text-slate-500">{Math.round((selectedAnnotation.opacity || 1) * 100)}%</span>
                        </div>
                        <input type="range" min="0.1" max="1" step="0.1" value={selectedAnnotation.opacity || 1} onChange={(e) => updateAnnotation(selectedAnnotation.id, { opacity: parseFloat(e.target.value) })} className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500" />
                     </div>
                     <button onClick={() => removeAnnotation(selectedAnnotation.id)} className="w-full py-2 bg-slate-800 hover:bg-rose-900/40 text-slate-400 hover:text-rose-500 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-2"><Trash2 size={12} />Delete Object</button>
                  </div>
               </PropertySection>
            ) : (
               <>
                  <PropertySection title="Sign Document">
                     <div className="space-y-3">
                        <button 
                           onClick={() => setSigPadOpen(true)}
                           className="w-full p-4 bg-slate-900/50 border border-slate-800/50 rounded-xl hover:bg-slate-800 hover:border-rose-500/50 transition-all group flex items-center gap-4 shadow-sm"
                        >
                           <div className="w-10 h-10 bg-rose-600/10 rounded-lg flex items-center justify-center group-hover:bg-rose-600/20 transition-colors">
                              <PenTool size={20} className="text-rose-500" />
                           </div>
                           <div className="flex flex-col items-start">
                              <span className="text-xs font-bold text-slate-200">Draw Signature</span>
                              <span className="text-[9px] text-slate-500">Insert digital signature</span>
                           </div>
                        </button>
                        <button className="w-full p-4 bg-slate-900/50 border border-slate-800/50 rounded-xl hover:bg-slate-800 hover:border-slate-700 transition-all group flex items-center gap-4 shadow-sm grayscale opacity-50">
                           <div className="w-10 h-10 bg-slate-700/10 rounded-lg flex items-center justify-center">
                              <User size={20} className="text-slate-500" />
                           </div>
                           <div className="flex flex-col items-start">
                              <span className="text-xs font-bold text-slate-400">Upload Image</span>
                              <span className="text-[9px] text-slate-600">PNG, JPG support</span>
                           </div>
                        </button>
                     </div>
                  </PropertySection>

                  <PropertySection title="Quick Actions">
                     <div className="grid grid-cols-2 gap-3">
                        <ActionButton icon={RotateCw} label="Rotate All" onClick={() => handleRotate(currentPage - 1)} />
                        <ActionButton icon={Search} label="Find Text" />
                        <ActionButton icon={Printer} label="Print Setup" />
                        <ActionButton icon={Download} label="Export Pages" />
                     </div>
                  </PropertySection>
               </>
            )}
          </div>
        </aside>

        {!propsOpen && (
          <button onClick={() => setPropsOpen(true)} className="absolute right-0 top-1/2 -translate-y-1/2 bg-[#151921] border border-slate-800 p-1.5 rounded-l-lg z-50 hover:text-white text-slate-500 shadow-xl transition-all"><ChevronLeft size={16} /></button>
        )}
      </div>

      {/* Signature Pad Modal */}
      {sigPadOpen && (
        <SignaturePad 
          onSave={handleInsertSignature} 
          onClose={() => setSigPadOpen(false)} 
        />
      )}

      {/* Status Bar */}
      <footer className="h-7 border-t border-slate-800 bg-[#0b0e14] flex items-center justify-between px-4 text-[10px] text-slate-500 font-bold uppercase tracking-tight">
        <div className="flex gap-6 items-center">
          <span className="flex items-center gap-1.5 text-slate-300"><div className="w-1.5 h-1.5 bg-green-500 rounded-full shadow-sm shadow-green-900" />Page {currentPage} of {totalPages}</span>
          <span className="text-slate-800">|</span>
          <span className="text-slate-400">Zoom: {Math.round(zoom * 100)}%</span>
        </div>
        <div className="flex gap-4 items-center">
          <span className="text-slate-400 font-bold tracking-tighter">MuxMelt Engine v1.2.2</span>
        </div>
      </footer>
    </div>
  );
};

const ToolButton = ({ icon: Icon, active, onClick, title }: any) => (
  <button onClick={onClick} title={title} className={`p-2 rounded-md transition-all duration-200 ${active ? 'bg-rose-600 text-white shadow-lg shadow-rose-900/30' : 'hover:bg-slate-800 text-slate-400 hover:text-white'}`}><Icon size={18} /></button>
);

const PropertySection = ({ title, children }: any) => (
  <div className="space-y-4">
    <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">{title}</h4>
    {children}
  </div>
);

const ActionButton = ({ icon: Icon, label, onClick }: any) => (
  <button onClick={onClick} className="flex flex-col items-center justify-center gap-2 p-4 bg-slate-900/50 border border-slate-800/50 rounded-xl hover:bg-slate-800/50 hover:border-slate-700 transition-all group shadow-sm">
    <Icon size={18} className="text-slate-500 group-hover:text-rose-500 transition-colors" />
    <span className="text-[9px] font-bold text-slate-500 group-hover:text-slate-300 uppercase tracking-tighter">{label}</span>
  </button>
);

export default App;

import React from 'react';
import { FileText, Layers, Lock, Type } from 'lucide-react';
import { Annotation } from '../store/useEditorStore';

interface ThumbnailProps {
  index: number;
  isActive: boolean;
  onClick: () => void;
}

const PageListItem = ({ index, isActive, onClick }: ThumbnailProps) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left transition-colors ${isActive ? 'border-rose-500 bg-rose-950/30 text-rose-100' : 'border-slate-800 bg-slate-950/30 text-slate-400 hover:border-slate-700 hover:bg-slate-900'}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <FileText size={13} className={isActive ? 'text-rose-400' : 'text-slate-500'} />
        <span className="truncate text-[11px] font-bold">Page {index + 1}</span>
      </span>
      {isActive && <span className="rounded border border-rose-500/40 px-1.5 py-0.5 text-[9px] font-bold uppercase text-rose-200">Current</span>}
    </button>
  );
};

interface ThumbnailSidebarProps {
  pages: { id: string, dataUrl: string }[];
  currentPage: number;
  onPageSelect: (index: number) => void;
  annotations?: Annotation[];
  selectedAnnotationId?: string | null;
  onLayerSelect?: (annotation: Annotation) => void;
}

const ThumbnailSidebar: React.FC<ThumbnailSidebarProps> = ({ 
  pages, 
  currentPage, 
  onPageSelect,
  annotations = [],
  selectedAnnotationId,
  onLayerSelect
}) => {
  const sortedAnnotations = [...annotations].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const layerLabel = (annotation: Annotation) => {
    if (annotation.type === 'redact') return 'Redaction';
    const text = String(annotation.text || '').trim();
    return text ? text : annotation.type === 'text' ? 'Added text' : 'Existing text';
  };
  const layerState = (annotation: Annotation) => {
    if (annotation.type === 'redact') return 'Redact';
    if (annotation.type === 'text') return 'New';
    const changed = (
      (annotation.text || '') !== (annotation.originalText || '') ||
      Math.round(annotation.x) !== Math.round(annotation.originalX ?? annotation.x) ||
      Math.round(annotation.y) !== Math.round(annotation.originalY ?? annotation.y) ||
      Math.round(annotation.w || 0) !== Math.round(annotation.originalW ?? annotation.w ?? 0) ||
      Math.round(annotation.h || 0) !== Math.round(annotation.originalH ?? annotation.h ?? 0) ||
      Math.round(annotation.fontSize || 0) !== Math.round(annotation.originalFontSize ?? annotation.fontSize ?? 0) ||
      (annotation.color || '#111111').toLowerCase() !== (annotation.originalColor || annotation.color || '#111111').toLowerCase() ||
      annotation.fontWeight === 'bold' ||
      annotation.fontStyle === 'italic' ||
      (annotation.textAlign || 'left') !== 'left'
    );
    return changed ? 'Edited' : 'Text';
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="p-4 flex items-center justify-between border-b border-slate-800/50 bg-[#1a1f29]">
        <div className="flex items-center gap-2">
           <FileText size={14} className="text-rose-500" />
           <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Pages</span>
        </div>
        <div className="text-[9px] text-slate-600 font-bold">{pages.length} Pages</div>
      </div>
      
      <div className="max-h-[38%] overflow-y-auto p-3 space-y-2 border-b border-slate-800/50 scrollbar-thin scrollbar-thumb-slate-800">
        {pages.map((page, index) => (
          <PageListItem
            key={page.id}
            index={index}
            isActive={currentPage === index + 1}
            onClick={() => onPageSelect(index)}
          />
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="p-4 flex items-center justify-between border-b border-slate-800/50 bg-[#1a1f29]">
          <div className="flex items-center gap-2">
            <Layers size={14} className="text-sky-400" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Layers</span>
          </div>
          <div className="text-[9px] text-slate-600 font-bold">{annotations.length} Layers</div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-thin scrollbar-thumb-slate-800">
          {sortedAnnotations.length ? sortedAnnotations.map((annotation) => (
            <button
              key={annotation.id}
              onClick={() => onLayerSelect?.(annotation)}
              className={`flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left transition-colors ${selectedAnnotationId === annotation.id ? 'border-sky-500 bg-sky-950/30 text-sky-100' : 'border-slate-800 bg-slate-950/30 text-slate-400 hover:border-slate-700 hover:bg-slate-900'}`}
              title={layerLabel(annotation)}
            >
              {annotation.type === 'redact' ? <Lock size={13} className="shrink-0 text-red-400" /> : <Type size={13} className="shrink-0 text-emerald-400" />}
              <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{layerLabel(annotation)}</span>
              <span className="shrink-0 rounded border border-slate-800 px-1.5 py-0.5 text-[9px] font-bold text-slate-500">{layerState(annotation)}</span>
              <span className="shrink-0 text-[9px] font-bold text-slate-600">P{annotation.page}</span>
            </button>
          )) : (
            <div className="rounded-md border border-slate-800 bg-slate-950/30 p-3 text-[11px] leading-4 text-slate-500">
              Detected text, added text, and redactions appear here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ThumbnailSidebar;

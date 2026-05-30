import React, { useEffect, useState } from 'react';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  FileText, Layers, Lock, Type, RotateCw, Copy, Trash2, GripVertical,
  FilePlus2, FileInput, FileOutput, Check,
} from 'lucide-react';
import { Annotation } from '../store/useEditorStore';

export interface PagePreview { id: string; index?: number; dataUrl: string }

export type PageOp = 'rotate' | 'delete' | 'duplicate' | 'insert_blank' | 'import' | 'extract';

interface ThumbnailSidebarProps {
  pages: PagePreview[];
  currentPage: number;
  onPageSelect: (index: number) => void;
  onReorder?: (order: number[]) => void;
  onPageOp?: (op: PageOp, params: Record<string, any>) => void;
  busy?: boolean;
  annotations?: Annotation[];
  selectedAnnotationId?: string | null;
  onLayerSelect?: (annotation: Annotation) => void;
}

const SortablePage = ({
  page, pageNumber, isActive, isChecked, onSelect, onToggleCheck, onOp, busy,
}: {
  page: PagePreview;
  pageNumber: number;
  isActive: boolean;
  isChecked: boolean;
  onSelect: () => void;
  onToggleCheck: () => void;
  onOp: (op: PageOp, params: Record<string, any>) => void;
  busy?: boolean;
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative rounded-md border ${isActive ? 'border-rose-500 ring-1 ring-rose-500/40' : 'border-slate-800 hover:border-slate-600'} bg-slate-950/40`}
    >
      <button type="button" onClick={onSelect} className="block w-full p-2 text-left">
        <div className="relative mx-auto aspect-[1/1.3] w-full overflow-hidden rounded bg-white">
          <img src={page.dataUrl} alt={`Page ${pageNumber}`} className="h-full w-full object-contain" draggable={false} />
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className={`text-[11px] font-bold ${isActive ? 'text-rose-200' : 'text-slate-400'}`}>Page {pageNumber}</span>
          {isActive && <span className="rounded border border-rose-500/40 px-1 text-[8px] font-bold uppercase text-rose-200">Current</span>}
        </div>
      </button>

      {/* select checkbox */}
      <button
        type="button"
        onClick={(e) => { stop(e); onToggleCheck(); }}
        title="Select page"
        className={`absolute left-3 top-3 flex h-4 w-4 items-center justify-center rounded border ${isChecked ? 'border-sky-400 bg-sky-500 text-white' : 'border-slate-500 bg-slate-900/80 text-transparent'} `}
      >
        <Check size={11} />
      </button>

      {/* drag handle */}
      <span
        {...attributes}
        {...listeners}
        title="Drag to reorder"
        className="absolute right-2 top-3 cursor-grab text-slate-500 opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
      >
        <GripVertical size={14} />
      </span>

      {/* hover actions */}
      <div className="absolute inset-x-2 bottom-8 flex justify-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <PageActionBtn title="Rotate 90°" disabled={busy} onClick={(e: React.MouseEvent) => { stop(e); onOp('rotate', { pages: [pageNumber], degrees: 90 }); }}><RotateCw size={12} /></PageActionBtn>
        <PageActionBtn title="Duplicate page" disabled={busy} onClick={(e: React.MouseEvent) => { stop(e); onOp('duplicate', { pages: [pageNumber] }); }}><Copy size={12} /></PageActionBtn>
        <PageActionBtn title="Delete page" disabled={busy} danger onClick={(e: React.MouseEvent) => { stop(e); onOp('delete', { pages: [pageNumber] }); }}><Trash2 size={12} /></PageActionBtn>
      </div>
    </div>
  );
};

const PageActionBtn = ({ children, onClick, title, danger, disabled }: any) => (
  <button
    type="button"
    title={title}
    disabled={disabled}
    onClick={onClick}
    className={`flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-slate-900/90 text-slate-200 hover:bg-slate-700 disabled:opacity-40 ${danger ? 'hover:bg-red-600 hover:text-white' : ''}`}
  >
    {children}
  </button>
);

const ThumbnailSidebar: React.FC<ThumbnailSidebarProps> = ({
  pages, currentPage, onPageSelect, onReorder, onPageOp, busy,
  annotations = [], selectedAnnotationId, onLayerSelect,
}) => {
  const [items, setItems] = useState<PagePreview[]>(pages);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  useEffect(() => { setItems(pages); setChecked(new Set()); }, [pages]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((p) => p.id === active.id);
    const newIndex = items.findIndex((p) => p.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(items, oldIndex, newIndex);
    setItems(next);
    // Map each item back to its ORIGINAL 1-based page number to build the order.
    const order = next.map((item) => pages.findIndex((p) => p.id === item.id) + 1);
    onReorder?.(order);
  };

  const toggleCheck = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const checkedPageNumbers = () =>
    items.map((it, i) => (checked.has(it.id) ? i + 1 : 0)).filter((n) => n > 0);

  const sortedAnnotations = [...annotations].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const layerLabel = (annotation: Annotation) => {
    if (annotation.type === 'redact') return 'Redaction';
    if (annotation.type === 'link') return annotation.uri ? `Link: ${annotation.uri}` : annotation.targetPage ? `Link → page ${annotation.targetPage}` : 'Hyperlink';
    const text = String(annotation.text || '').trim();
    return text ? text : annotation.type === 'text' ? 'Added text' : 'Existing text';
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="p-3 flex items-center justify-between border-b border-slate-800/50 bg-[#1a1f29]">
        <div className="flex items-center gap-2">
          <FileText size={14} className="text-rose-500" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Pages</span>
        </div>
        <div className="text-[9px] text-slate-600 font-bold">{items.length} Pages</div>
      </div>

      {/* Organize toolbar */}
      <div className="flex flex-wrap gap-1 border-b border-slate-800/50 bg-[#161b22] p-2">
        <ToolbarMini title="Insert blank page after current" disabled={busy} onClick={() => onPageOp?.('insert_blank', { afterPage: currentPage })}><FilePlus2 size={13} />Blank</ToolbarMini>
        <ToolbarMini title="Import pages from another PDF" disabled={busy} onClick={() => onPageOp?.('import', { afterPage: currentPage })}><FileInput size={13} />Import</ToolbarMini>
        <ToolbarMini title="Extract pages to a new PDF" disabled={busy} onClick={() => onPageOp?.('extract', { pages: checkedPageNumbers().length ? checkedPageNumbers() : [currentPage] })}><FileOutput size={13} />Extract</ToolbarMini>
      </div>

      {checked.size > 0 && (
        <div className="flex items-center justify-between gap-2 border-b border-slate-800/50 bg-sky-950/30 px-3 py-1.5 text-[10px] text-sky-200">
          <span className="font-bold">{checked.size} selected</span>
          <div className="flex gap-1">
            <button disabled={busy} onClick={() => onPageOp?.('rotate', { pages: checkedPageNumbers(), degrees: 90 })} className="rounded bg-slate-800 px-2 py-1 font-bold hover:bg-slate-700 disabled:opacity-40">Rotate</button>
            <button disabled={busy} onClick={() => onPageOp?.('delete', { pages: checkedPageNumbers() })} className="rounded bg-red-700 px-2 py-1 font-bold text-white hover:bg-red-600 disabled:opacity-40">Delete</button>
          </div>
        </div>
      )}

      <div className="max-h-[44%] overflow-y-auto p-2 border-b border-slate-800/50 scrollbar-thin scrollbar-thumb-slate-800">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={items.map((p) => p.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {items.map((page, index) => (
                <SortablePage
                  key={page.id}
                  page={page}
                  pageNumber={index + 1}
                  isActive={currentPage === index + 1}
                  isChecked={checked.has(page.id)}
                  onSelect={() => onPageSelect(index)}
                  onToggleCheck={() => toggleCheck(page.id)}
                  onOp={(op, params) => onPageOp?.(op, params)}
                  busy={busy}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="p-3 flex items-center justify-between border-b border-slate-800/50 bg-[#1a1f29]">
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

const ToolbarMini = ({ children, onClick, title, disabled }: any) => (
  <button
    type="button"
    title={title}
    disabled={disabled}
    onClick={onClick}
    className="flex items-center gap-1 rounded border border-slate-700 bg-slate-900/70 px-2 py-1 text-[10px] font-bold text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-40"
  >
    {children}
  </button>
);

export default ThumbnailSidebar;

import React, { useEffect, useState } from 'react';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, rectSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  X, RotateCw, Copy, Trash2, FilePlus2, FileInput, FileOutput, GripVertical, Check,
} from 'lucide-react';
import { PagePreview, PageOp } from './ThumbnailSidebar';

interface Props {
  open: boolean;
  onClose: () => void;
  pages: PagePreview[];
  onReorder: (order: number[]) => void;
  onPageOp: (op: PageOp, params: Record<string, any>) => void;
  busy?: boolean;
}

const Card = ({ page, pageNumber, checked, onToggle, onOp, busy }: {
  page: PagePreview; pageNumber: number; checked: boolean;
  onToggle: () => void; onOp: (op: PageOp, params: Record<string, any>) => void; busy?: boolean;
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id });
  const style: React.CSSProperties = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div ref={setNodeRef} style={style} className={`group relative rounded-lg border-2 ${checked ? 'border-sky-500' : 'border-zinc-700 hover:border-zinc-500'} bg-zinc-900 p-2`}>
      <div className="relative mx-auto aspect-[1/1.3] w-full overflow-hidden rounded bg-white shadow-lg">
        <img src={page.dataUrl} alt={`Page ${pageNumber}`} className="h-full w-full object-contain" draggable={false} />
      </div>
      <div className="mt-2 text-center text-xs font-bold text-zinc-300">Page {pageNumber}</div>

      <button onClick={(e) => { stop(e); onToggle(); }} title="Select" className={`absolute left-3 top-3 flex h-5 w-5 items-center justify-center rounded border ${checked ? 'border-sky-400 bg-sky-500 text-white' : 'border-zinc-500 bg-zinc-900/80 text-transparent'}`}><Check size={13} /></button>
      <span {...attributes} {...listeners} title="Drag to reorder" className="absolute right-3 top-3 cursor-grab text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"><GripVertical size={16} /></span>

      <div className="absolute inset-x-0 bottom-9 flex justify-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <ActBtn title="Rotate 90°" disabled={busy} onClick={(e: React.MouseEvent) => { stop(e); onOp('rotate', { pages: [pageNumber], degrees: 90 }); }}><RotateCw size={14} /></ActBtn>
        <ActBtn title="Duplicate" disabled={busy} onClick={(e: React.MouseEvent) => { stop(e); onOp('duplicate', { pages: [pageNumber] }); }}><Copy size={14} /></ActBtn>
        <ActBtn title="Delete" disabled={busy} danger onClick={(e: React.MouseEvent) => { stop(e); onOp('delete', { pages: [pageNumber] }); }}><Trash2 size={14} /></ActBtn>
      </div>
    </div>
  );
};

const ActBtn = ({ children, onClick, title, danger, disabled }: any) => (
  <button type="button" title={title} disabled={disabled} onClick={onClick} className={`flex h-8 w-8 items-center justify-center rounded-md border border-zinc-600 bg-zinc-900/90 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 ${danger ? 'hover:bg-red-600 hover:text-white' : ''}`}>{children}</button>
);

const ToolBtn = ({ children, onClick, disabled }: any) => (
  <button type="button" disabled={disabled} onClick={onClick} className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-bold text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">{children}</button>
);

const OrganizePagesModal: React.FC<Props> = ({ open, onClose, pages, onReorder, onPageOp, busy }) => {
  const [items, setItems] = useState<PagePreview[]>(pages);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  useEffect(() => { setItems(pages); setChecked(new Set()); }, [pages]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  if (!open) return null;

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((p) => p.id === active.id);
    const newIndex = items.findIndex((p) => p.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(items, oldIndex, newIndex);
    setItems(next);
    onReorder(next.map((it) => pages.findIndex((p) => p.id === it.id) + 1));
  };

  const toggle = (id: string) => setChecked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectedPages = () => items.map((it, i) => (checked.has(it.id) ? i + 1 : 0)).filter((n) => n > 0);
  const allSelected = checked.size === items.length && items.length > 0;

  return (
    <div className="fixed inset-0 z-[200] flex flex-col bg-[#0e1014]">
      <div className="flex items-center justify-between border-b border-zinc-800 bg-[#15181e] px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-zinc-100">Organize Pages</span>
          <span className="text-xs text-zinc-500">{items.length} pages · {checked.size} selected</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToolBtn disabled={busy} onClick={() => setChecked(allSelected ? new Set() : new Set(items.map((p) => p.id)))}>{allSelected ? 'Clear' : 'Select all'}</ToolBtn>
          <span className="mx-1 h-5 w-px bg-zinc-700" />
          <ToolBtn disabled={busy || !checked.size} onClick={() => onPageOp('rotate', { pages: selectedPages(), degrees: 90 })}><RotateCw size={13} />Rotate</ToolBtn>
          <ToolBtn disabled={busy || !checked.size} onClick={() => onPageOp('duplicate', { pages: selectedPages() })}><Copy size={13} />Duplicate</ToolBtn>
          <ToolBtn disabled={busy || !checked.size} onClick={() => onPageOp('extract', { pages: selectedPages() })}><FileOutput size={13} />Extract</ToolBtn>
          <ToolBtn disabled={busy || !checked.size} onClick={() => onPageOp('delete', { pages: selectedPages() })}><Trash2 size={13} />Delete</ToolBtn>
          <span className="mx-1 h-5 w-px bg-zinc-700" />
          <ToolBtn disabled={busy} onClick={() => onPageOp('insert_blank', { afterPage: selectedPages().slice(-1)[0] ?? items.length })}><FilePlus2 size={13} />Blank</ToolBtn>
          <ToolBtn disabled={busy} onClick={() => onPageOp('import', { afterPage: selectedPages().slice(-1)[0] ?? items.length })}><FileInput size={13} />Import</ToolBtn>
          <span className="mx-1 h-5 w-px bg-zinc-700" />
          <button onClick={onClose} className="flex items-center gap-1.5 rounded-md bg-zinc-200 px-4 py-1.5 text-xs font-bold text-zinc-900 hover:bg-white">Done</button>
          <button onClick={onClose} className="text-zinc-500 hover:text-white"><X size={18} /></button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {items.length ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={items.map((p) => p.id)} strategy={rectSortingStrategy}>
              <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
                {items.map((page, i) => (
                  <Card key={page.id} page={page} pageNumber={i + 1} checked={checked.has(page.id)} onToggle={() => toggle(page.id)} onOp={onPageOp} busy={busy} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">No pages to organize.</div>
        )}
      </div>
    </div>
  );
};

export default OrganizePagesModal;

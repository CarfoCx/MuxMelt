import React, { useRef, useState } from 'react';
import { useEditorStore, Annotation } from '../store/useEditorStore';

interface AnnotationLayerProps {
  pageNumber: number;
  width: number;
  height: number;
  zoom: number;
  onApplyRedaction?: () => void;
  isApplyingRedaction?: boolean;
}

const AnnotationLayer: React.FC<AnnotationLayerProps> = ({ pageNumber, width, height, zoom, onApplyRedaction, isApplyingRedaction }) => {
  const { activeTool, addAnnotation, annotations, selectedAnnotationId, setSelectedAnnotation, updateAnnotation } = useEditorStore();
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [tempRect, setTempRect] = useState<{ x: number, y: number, w: number, h: number } | null>(null);
  const [tempPoints, setTempPoints] = useState<{ x: number; y: number }[]>([]);
  const [dragState, setDragState] = useState<null | {
    id: string;
    mode: 'move' | 'resize';
    handle?: string;
    startX: number;
    startY: number;
    original: Annotation;
  }>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const getPointerPosition = (e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: (e.clientX - rect.left) / zoom,
      y: (e.clientY - rect.top) / zoom
    };
  };

  const isExistingTextChanged = (ann: Annotation) => {
    if (ann.type !== 'replaceText' || ann.source !== 'textMap') return false;
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
      (ann.textAlign || 'left') !== 'left'
    );
  };

  const shouldPreviewTextEdit = (ann: Annotation) => (
    ann.type === 'replaceText' &&
    ann.source === 'textMap' &&
    (selectedAnnotationId === ann.id || isExistingTextChanged(ann) || dragState?.id === ann.id)
  );

  const addQuickAnnotation = (x: number, y: number) => {
    const id = `ann-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (activeTool === 'text') {
      addAnnotation({
        id,
        type: 'text',
        page: pageNumber,
        x,
        y,
        w: 220,
        h: 54,
        text: 'New text',
        fontSize: 14,
        fontFamily: 'Helvetica',
        fontWeight: 'normal',
        fontStyle: 'normal',
        textDecoration: 'none',
        textAlign: 'left',
        color: '#111111',
        fill: 'transparent',
        opacity: 1
      });
      setSelectedAnnotation(id);
      return true;
    }

    return false;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (activeTool === 'select' || activeTool === 'replaceText') {
      if (e.target === containerRef.current) setSelectedAnnotation(null);
      return;
    }

    const pos = getPointerPosition(e);
    if (!pos) return;

    if (addQuickAnnotation(pos.x, pos.y)) return;
    
    setIsDrawing(true);
    setStartPos(pos);
    setTempRect({ ...pos, w: 0, h: 0 });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing || !tempRect) return;
    
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const x = (e.clientX - rect.left) / zoom;
    const y = (e.clientY - rect.top) / zoom;
    
    setTempRect({
      x: Math.min(startPos.x, x),
      y: Math.min(startPos.y, y),
      w: Math.abs(x - startPos.x),
      h: Math.abs(y - startPos.y)
    });
  };

  const handleMouseUp = () => {
    if (!isDrawing || !tempRect) return;
    
    if (tempRect.w > 5 && tempRect.h > 5) {
      if (activeTool === 'redact') {
        const intersectingText = pageAnnotations.filter((ann) => {
          if (!['text', 'replaceText'].includes(ann.type)) return false;
          const target = {
            x: ann.type === 'replaceText' ? (ann.originalX ?? ann.x) : ann.x,
            y: ann.type === 'replaceText' ? (ann.originalY ?? ann.y) : ann.y,
            w: ann.type === 'replaceText' ? (ann.originalW ?? ann.w ?? 0) : (ann.w ?? 0),
            h: ann.type === 'replaceText' ? (ann.originalH ?? ann.h ?? 0) : (ann.h ?? 0),
          };
          return intersects(tempRect, target);
        });

        if (intersectingText.length) {
          let lastId = '';
          intersectingText.forEach((ann) => {
            const target = {
              x: ann.type === 'replaceText' ? (ann.originalX ?? ann.x) : ann.x,
              y: ann.type === 'replaceText' ? (ann.originalY ?? ann.y) : ann.y,
              w: ann.type === 'replaceText' ? (ann.originalW ?? ann.w ?? 0) : (ann.w ?? 0),
              h: ann.type === 'replaceText' ? (ann.originalH ?? ann.h ?? 0) : (ann.h ?? 0),
            };
            const redaction = intersectionRect(tempRect, target);
            if (!redaction || redaction.w <= 1 || redaction.h <= 1) return;
            const id = `ann-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            lastId = id;
            addAnnotation({
              id,
              type: 'redact',
              page: pageNumber,
              x: redaction.x,
              y: redaction.y,
              w: redaction.w,
              h: redaction.h,
              color: '#000000',
              fill: '#000000',
              borderColor: '#000000',
              strokeWidth: 2,
              opacity: 1
            });
          });
          setSelectedAnnotation(lastId || null);
        } else {
          const id = `ann-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          addAnnotation({
            id,
            type: 'redact',
            page: pageNumber,
            x: tempRect.x,
            y: tempRect.y,
            w: tempRect.w,
            h: tempRect.h,
            color: '#000000',
            fill: '#000000',
            borderColor: '#000000',
            strokeWidth: 2,
            opacity: 1
          });
          setSelectedAnnotation(id);
        }
      }
    }
    
    setIsDrawing(false);
    setTempRect(null);
    setTempPoints([]);
  };

  const intersects = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );

  const intersectionRect = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    if (x2 <= x1 || y2 <= y1) return null;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  };

  const handleAnnotationPointerDown = (e: React.MouseEvent, ann: Annotation, mode: 'move' | 'resize', handle?: string) => {
    if (ann.locked) return;
    e.stopPropagation();
    setSelectedAnnotation(ann.id);
    const pos = getPointerPosition(e);
    if (!pos) return;
    setDragState({ id: ann.id, mode, handle, startX: pos.x, startY: pos.y, original: { ...ann, points: ann.points ? [...ann.points] : undefined } });
  };

  const updateInlineText = (ann: Annotation, value: string) => {
    const fontSize = ann.fontSize || 14;
    const estimatedWidth = Math.ceil(value.split(/\r?\n/).reduce((max, line) => Math.max(max, line.length), 0) * fontSize * 0.58) + 10;
    const nextWidth = Math.min(width - ann.x, Math.max(ann.w || 0, estimatedWidth, 24));
    const lineCount = Math.max(value.split(/\r?\n/).length, 1);
    const nextHeight = Math.max(ann.h || 0, Math.ceil(lineCount * fontSize * 1.25) + 6);
    updateAnnotation(ann.id, { text: value, w: nextWidth, h: nextHeight });
  };

  const moveSelected = (e: React.MouseEvent) => {
    if (!dragState) return;
    const pos = getPointerPosition(e);
    if (!pos) return;
    const dx = pos.x - dragState.startX;
    const dy = pos.y - dragState.startY;
    const ann = dragState.original;

    if (dragState.mode === 'move') {
      updateAnnotation(dragState.id, {
        x: Math.max(0, ann.x + dx),
        y: Math.max(0, ann.y + dy),
        points: ann.points?.map((point) => ({ x: point.x + dx, y: point.y + dy }))
      });
      return;
    }

    const minSize = 8;
    let x = ann.x;
    let y = ann.y;
    let w = ann.w || minSize;
    let h = ann.h || minSize;
    if (dragState.handle?.includes('e')) w = Math.max(minSize, (ann.w || minSize) + dx);
    if (dragState.handle?.includes('s')) h = Math.max(minSize, (ann.h || minSize) + dy);
    if (dragState.handle?.includes('w')) {
      x = Math.min(ann.x + (ann.w || minSize) - minSize, ann.x + dx);
      w = Math.max(minSize, (ann.w || minSize) - dx);
    }
    if (dragState.handle?.includes('n')) {
      y = Math.min(ann.y + (ann.h || minSize) - minSize, ann.y + dy);
      h = Math.max(minSize, (ann.h || minSize) - dy);
    }
    updateAnnotation(dragState.id, { x, y, w, h });
  };

  const handleLayerMouseMove = (e: React.MouseEvent) => {
    if (dragState) {
      moveSelected(e);
      return;
    }
    handleMouseMove(e);
  };

  const handleLayerMouseUp = () => {
    if (dragState) {
      setDragState(null);
      return;
    }
    handleMouseUp();
  };

  const pageAnnotations = annotations.filter(a => a.page === pageNumber);

  return (
    <div 
      ref={containerRef}
      className={`absolute inset-0 z-10 overflow-hidden ${activeTool === 'redact' ? 'cursor-crosshair' : 'cursor-default'}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleLayerMouseMove}
      onMouseUp={handleLayerMouseUp}
      onMouseLeave={() => setDragState(null)}
    >
      {pageAnnotations
        .filter((ann) => shouldPreviewTextEdit(ann))
        .map((ann) => (
          <div
            key={`${ann.id}-original-cover`}
            className="absolute pointer-events-none"
            style={{
              left: (ann.originalX ?? ann.x) * zoom,
              top: (ann.originalY ?? ann.y) * zoom,
              width: (ann.originalW ?? ann.w ?? 0) * zoom,
              height: (ann.originalH ?? ann.h ?? 0) * zoom,
              backgroundColor: ann.fill || '#ffffff',
              opacity: ann.opacity ?? 1
            }}
          />
        ))}

      {/* Existing Annotations */}
      {pageAnnotations.map(ann => {
        const isText = ann.type === 'text' || ann.type === 'replaceText';
        const showTextEditor = ann.type === 'text' || shouldPreviewTextEdit(ann);
        return (
          <div
            key={ann.id}
            className={`absolute transition-all group ${selectedAnnotationId === ann.id ? 'ring-2 ring-blue-500' : ''} ${isText ? '' : 'border-2 border-rose-500'}`}
            style={{
              left: ann.x * zoom,
              top: ann.y * zoom,
              width: (ann.w || 0) * zoom,
              height: (ann.h || 0) * zoom,
              backgroundColor: ann.type === 'redact' ? '#000' : (ann.type === 'replaceText' ? (showTextEditor ? '#fff' : 'transparent') : ann.fill),
              borderRadius: '0px',
              opacity: ann.opacity,
              borderColor: ann.borderColor || ann.color,
              cursor: isText ? 'text' : 'move'
            }}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedAnnotation(ann.id);
            }}
            onMouseDown={(e) => {
              if (!isText && ann.type !== 'redact') {
                handleAnnotationPointerDown(e, ann, 'move');
              }
            }}
          >
            {showTextEditor && (
              <textarea
                spellCheck
                value={ann.text || ''}
                className="h-full w-full resize-none outline-none overflow-hidden px-1 py-0.5 cursor-text"
                style={{
                  color: ann.color || '#111111',
                  fontSize: `${(ann.fontSize || 14) * zoom}px`,
                  fontFamily: ann.fontFamily || 'Helvetica, Arial, sans-serif',
                  fontWeight: ann.fontWeight || 'normal',
                  fontStyle: ann.fontStyle || 'normal',
                  textDecoration: ann.textDecoration === 'underline' ? 'underline' : 'none',
                  textAlign: ann.textAlign || 'left',
                  lineHeight: ann.lineHeight || 1.2,
                  border: selectedAnnotationId === ann.id ? `1px dashed ${ann.borderColor || '#38bdf8'}` : '1px dashed transparent',
                  background: 'transparent',
                  pointerEvents: activeTool === 'redact' ? 'none' : 'auto'
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedAnnotation(ann.id);
                }}
                onChange={(e) => updateInlineText(ann, e.currentTarget.value)}
                onBlur={(e) => updateInlineText(ann, e.currentTarget.value)}
              />
            )}
            {ann.type === 'redact' && (
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                 <span className="text-[8px] text-white font-bold uppercase tracking-tighter bg-black/50 px-1 rounded">Redaction area</span>
              </div>
            )}
            {selectedAnnotationId === ann.id && ann.type === 'redact' && (
              <button
                type="button"
                disabled={isApplyingRedaction}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onApplyRedaction?.();
                }}
                className="absolute left-1/2 -top-8 flex h-7 -translate-x-1/2 items-center whitespace-nowrap rounded-md bg-red-600 px-3 text-[10px] font-bold uppercase tracking-wide text-white shadow-lg ring-1 ring-red-300/40 hover:bg-red-500 disabled:cursor-wait disabled:opacity-70"
              >
                {isApplyingRedaction ? 'Applying...' : 'Apply Redaction'}
              </button>
            )}
            {selectedAnnotationId === ann.id && !ann.locked && ann.type !== 'redact' && (
              <>
                <button className="absolute left-1/2 -top-6 flex h-5 -translate-x-1/2 items-center rounded bg-blue-600 px-2 text-[10px] font-bold text-white shadow" onMouseDown={(e) => handleAnnotationPointerDown(e, ann, 'move')} aria-label="Move object">Move</button>
                <button className="absolute -left-1.5 -top-1.5 h-3 w-3 border border-blue-600 bg-white" onMouseDown={(e) => handleAnnotationPointerDown(e, ann, 'resize', 'nw')} aria-label="Resize northwest" />
                <button className="absolute -right-1.5 -top-1.5 h-3 w-3 border border-blue-600 bg-white" onMouseDown={(e) => handleAnnotationPointerDown(e, ann, 'resize', 'ne')} aria-label="Resize northeast" />
                <button className="absolute -left-1.5 -bottom-1.5 h-3 w-3 border border-blue-600 bg-white" onMouseDown={(e) => handleAnnotationPointerDown(e, ann, 'resize', 'sw')} aria-label="Resize southwest" />
                <button className="absolute -right-1.5 -bottom-1.5 h-3 w-3 border border-blue-600 bg-white" onMouseDown={(e) => handleAnnotationPointerDown(e, ann, 'resize', 'se')} aria-label="Resize southeast" />
              </>
            )}
          </div>
        );
      })}

      {/* Temporary Drawing Rect */}
      {tempRect && (
        <div
          className="absolute border-2 border-rose-500 bg-rose-500/20 pointer-events-none"
          style={{
            left: tempRect.x * zoom,
            top: tempRect.y * zoom,
            width: tempRect.w * zoom,
            height: tempRect.h * zoom,
            borderRadius: '0px',
            backgroundColor: activeTool === 'redact' ? 'rgba(0, 0, 0, 0.78)' : undefined,
            borderColor: activeTool === 'redact' ? '#000000' : undefined
          }}
        />
      )}
    </div>
  );
};

export default AnnotationLayer;

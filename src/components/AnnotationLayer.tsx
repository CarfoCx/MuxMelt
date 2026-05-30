import React, { useRef, useState } from 'react';
import { useEditorStore, Annotation, BOX_TOOLS, SEGMENT_TOOLS } from '../store/useEditorStore';
import { annotationFontCss } from '../lib/fonts';

interface AnnotationLayerProps {
  pageNumber: number;
  width: number;
  height: number;
  zoom: number;
  onApplyRedaction?: () => void;
  isApplyingRedaction?: boolean;
}

const POINT_TYPES = ['line', 'arrow', 'ink'];
const newId = () => `ann-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function hexToRgba(hex: string, alpha: number) {
  const v = String(hex || '#000000').replace('#', '');
  if (v.length < 6) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const AnnotationLayer: React.FC<AnnotationLayerProps> = ({ pageNumber, width, height, zoom, onApplyRedaction, isApplyingRedaction }) => {
  const {
    activeTool, addAnnotation, annotations, selectedAnnotationId, setSelectedAnnotation,
    updateAnnotation, commitHistory, drawColor, drawFill, drawWidth, drawOpacity,
  } = useEditorStore();
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [tempRect, setTempRect] = useState<{ x: number, y: number, w: number, h: number } | null>(null);
  const [tempPoints, setTempPoints] = useState<{ x: number; y: number }[]>([]);
  const [dragState, setDragState] = useState<null | {
    id: string; mode: 'move' | 'resize'; handle?: string; startX: number; startY: number; original: Annotation;
  }>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const isBoxTool = (BOX_TOOLS as string[]).includes(activeTool);
  const isSegmentTool = (SEGMENT_TOOLS as string[]).includes(activeTool);
  const isInkTool = activeTool === 'ink';
  const isDrawingTool = isBoxTool || isSegmentTool || isInkTool;

  const getPointerPosition = (e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
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
      (ann.fontFamily || 'Helvetica') !== (ann.originalFontFamily || ann.fontFamily || 'Helvetica') ||
      (ann.color || '#111111').toLowerCase() !== (ann.originalColor || ann.color || '#111111').toLowerCase() ||
      ann.fontWeight === 'bold' || ann.fontStyle === 'italic' || ann.textDecoration === 'underline' ||
      (ann.textAlign || 'left') !== 'left'
    );
  };

  const shouldPreviewTextEdit = (ann: Annotation) => (
    ann.type === 'replaceText' && ann.source === 'textMap' &&
    (selectedAnnotationId === ann.id || isExistingTextChanged(ann) || dragState?.id === ann.id)
  );

  const isOcrText = (ann: Annotation) => ann.type === 'replaceText' && ann.sourceType === 'ocr';

  const styleForNewBox = (type: string) => ({
    color: drawColor, fill: drawFill, borderColor: drawColor, strokeWidth: drawWidth,
    opacity: type === 'highlight' ? Math.min(drawOpacity, 0.45) : drawOpacity,
  });

  const addQuickAnnotation = (x: number, y: number) => {
    if (activeTool === 'text') {
      const id = newId();
      addAnnotation({
        id, type: 'text', page: pageNumber, x, y, w: 220, h: 54, text: 'New text',
        fontSize: 14, fontFamily: 'Helvetica', fontWeight: 'normal', fontStyle: 'normal',
        textDecoration: 'none', textAlign: 'left', color: '#111111', fill: 'transparent', opacity: 1,
      });
      setSelectedAnnotation(id);
      return true;
    }
    if (activeTool === 'note') {
      const text = window.prompt('Note text:') || '';
      const id = newId();
      addAnnotation({ id, type: 'note', page: pageNumber, x, y, w: 22, h: 22, text, color: drawColor || '#ffcc00', opacity: 1 });
      setSelectedAnnotation(id);
      return true;
    }
    return false;
  };

  const intersects = (a: any, b: any) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const intersectionRect = (a: any, b: any) => {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    if (x2 <= x1 || y2 <= y1) return null;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (activeTool === 'select' || activeTool === 'replaceText') {
      if (e.target === containerRef.current) setSelectedAnnotation(null);
      return;
    }
    const pos = getPointerPosition(e);
    if (!pos) return;
    if (addQuickAnnotation(pos.x, pos.y)) return;
    if (!isDrawingTool) return;
    setIsDrawing(true);
    setStartPos(pos);
    if (isInkTool) setTempPoints([pos]);
    else if (isSegmentTool) setTempPoints([pos, pos]);
    else setTempRect({ ...pos, w: 0, h: 0 });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing) return;
    const pos = getPointerPosition(e);
    if (!pos) return;
    if (isInkTool) { setTempPoints((prev) => [...prev, pos]); return; }
    if (isSegmentTool) { setTempPoints([startPos, pos]); return; }
    setTempRect({
      x: Math.min(startPos.x, pos.x), y: Math.min(startPos.y, pos.y),
      w: Math.abs(pos.x - startPos.x), h: Math.abs(pos.y - startPos.y),
    });
  };

  const finishBox = () => {
    if (!tempRect || tempRect.w <= 4 || tempRect.h <= 4) return;
    if (activeTool === 'redact') {
      const intersecting = pageAnnotations.filter((ann) => {
        if (!['text', 'replaceText'].includes(ann.type)) return false;
        const t = {
          x: ann.type === 'replaceText' ? (ann.originalX ?? ann.x) : ann.x,
          y: ann.type === 'replaceText' ? (ann.originalY ?? ann.y) : ann.y,
          w: ann.type === 'replaceText' ? (ann.originalW ?? ann.w ?? 0) : (ann.w ?? 0),
          h: ann.type === 'replaceText' ? (ann.originalH ?? ann.h ?? 0) : (ann.h ?? 0),
        };
        return intersects(tempRect, t);
      });
      if (intersecting.length) {
        let lastId = '';
        intersecting.forEach((ann) => {
          const t = {
            x: ann.type === 'replaceText' ? (ann.originalX ?? ann.x) : ann.x,
            y: ann.type === 'replaceText' ? (ann.originalY ?? ann.y) : ann.y,
            w: ann.type === 'replaceText' ? (ann.originalW ?? ann.w ?? 0) : (ann.w ?? 0),
            h: ann.type === 'replaceText' ? (ann.originalH ?? ann.h ?? 0) : (ann.h ?? 0),
          };
          const red = intersectionRect(tempRect, t);
          if (!red || red.w <= 1 || red.h <= 1) return;
          const id = newId();
          lastId = id;
          addAnnotation({ id, type: 'redact', page: pageNumber, x: red.x, y: red.y, w: red.w, h: red.h, color: '#000000', fill: '#000000', borderColor: '#000000', strokeWidth: 2, opacity: 1 });
        });
        setSelectedAnnotation(lastId || null);
        return;
      }
      const id = newId();
      addAnnotation({ id, type: 'redact', page: pageNumber, x: tempRect.x, y: tempRect.y, w: tempRect.w, h: tempRect.h, color: '#000000', fill: '#000000', borderColor: '#000000', strokeWidth: 2, opacity: 1 });
      setSelectedAnnotation(id);
      return;
    }
    const id = newId();
    if (activeTool === 'link') {
      addAnnotation({ id, type: 'link', page: pageNumber, x: tempRect.x, y: tempRect.y, w: tempRect.w, h: tempRect.h, uri: '', color: '#3b82f6', borderColor: '#3b82f6', opacity: 1 });
    } else {
      addAnnotation({ id, type: activeTool as any, page: pageNumber, x: tempRect.x, y: tempRect.y, w: tempRect.w, h: tempRect.h, ...styleForNewBox(activeTool) });
    }
    setSelectedAnnotation(id);
  };

  const finishSegment = () => {
    const p1 = startPos;
    const p2 = tempPoints[tempPoints.length - 1] || startPos;
    if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 5) return;
    const id = newId();
    addAnnotation({
      id, type: activeTool as any, page: pageNumber,
      x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y),
      points: [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }],
      color: drawColor, borderColor: drawColor, strokeWidth: drawWidth, opacity: drawOpacity,
    });
    setSelectedAnnotation(id);
  };

  const finishInk = () => {
    if (tempPoints.length < 2) return;
    const xs = tempPoints.map((p) => p.x), ys = tempPoints.map((p) => p.y);
    const id = newId();
    addAnnotation({
      id, type: 'ink', page: pageNumber,
      x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
      points: tempPoints.map((p) => ({ x: p.x, y: p.y })),
      color: drawColor, borderColor: drawColor, strokeWidth: drawWidth, opacity: drawOpacity,
    });
    setSelectedAnnotation(id);
  };

  const handleMouseUp = () => {
    if (!isDrawing) return;
    if (isInkTool) finishInk();
    else if (isSegmentTool) finishSegment();
    else finishBox();
    setIsDrawing(false);
    setTempRect(null);
    setTempPoints([]);
  };

  const handleAnnotationPointerDown = (e: React.MouseEvent, ann: Annotation, mode: 'move' | 'resize', handle?: string) => {
    if (ann.locked) return;
    e.stopPropagation();
    setSelectedAnnotation(ann.id);
    const pos = getPointerPosition(e);
    if (!pos) return;
    commitHistory();
    setDragState({ id: ann.id, mode, handle, startX: pos.x, startY: pos.y, original: { ...ann, points: ann.points ? [...ann.points] : undefined } });
  };

  // Added text grows its box to fit (label-like behaviour).
  const updateInlineText = (ann: Annotation, value: string) => {
    const fontSize = ann.fontSize || 14;
    const estimatedWidth = Math.ceil(value.split(/\r?\n/).reduce((max, line) => Math.max(max, line.length), 0) * fontSize * 0.58) + 10;
    const nextWidth = Math.min(width - ann.x, Math.max(ann.w || 0, estimatedWidth, 24));
    const lineCount = Math.max(value.split(/\r?\n/).length, 1);
    const nextHeight = Math.max(ann.h || 0, Math.ceil(lineCount * fontSize * 1.25) + 6);
    updateAnnotation(ann.id, { text: value, w: nextWidth, h: nextHeight });
  };

  // Existing-paragraph editing: column width stays fixed; the text wraps and the
  // box auto-grows vertically (the textarea ref handles the visual height), so it
  // reflows like Acrobat. We only persist the new text — height is derived.
  const handleTextEdit = (ann: Annotation, el: HTMLTextAreaElement) => {
    if (ann.type === 'replaceText') updateAnnotation(ann.id, { text: el.value });
    else updateInlineText(ann, el.value);
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
        x: Math.max(0, ann.x + dx), y: Math.max(0, ann.y + dy),
        points: ann.points?.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      });
      return;
    }
    const minSize = 8;
    let x = ann.x, y = ann.y, w = ann.w || minSize, h = ann.h || minSize;
    if (dragState.handle?.includes('e')) w = Math.max(minSize, (ann.w || minSize) + dx);
    if (dragState.handle?.includes('s')) h = Math.max(minSize, (ann.h || minSize) + dy);
    if (dragState.handle?.includes('w')) { x = Math.min(ann.x + (ann.w || minSize) - minSize, ann.x + dx); w = Math.max(minSize, (ann.w || minSize) - dx); }
    if (dragState.handle?.includes('n')) { y = Math.min(ann.y + (ann.h || minSize) - minSize, ann.y + dy); h = Math.max(minSize, (ann.h || minSize) - dy); }
    updateAnnotation(dragState.id, { x, y, w, h });
  };

  const handleLayerMouseMove = (e: React.MouseEvent) => { if (dragState) { moveSelected(e); return; } handleMouseMove(e); };
  const handleLayerMouseUp = () => { if (dragState) { setDragState(null); return; } handleMouseUp(); };

  const pageAnnotations = annotations.filter((a) => a.page === pageNumber);

  // Visual body for shape/markup/ink annotations (everything that is not text).
  const renderShapeBody = (ann: Annotation) => {
    const w = (ann.w || 0) * zoom, h = (ann.h || 0) * zoom;
    const stroke = ann.color || ann.borderColor || '#e23b3b';
    const sw = (ann.strokeWidth || 2) * zoom;
    if (ann.type === 'line' || ann.type === 'arrow') {
      const pts = ann.points || [{ x: ann.x, y: ann.y }, { x: ann.x + (ann.w || 0), y: ann.y + (ann.h || 0) }];
      const x0 = ann.x, y0 = ann.y;
      const mid = `mm-arrow-${pageNumber}`;
      return (
        <svg className="pointer-events-none absolute" style={{ left: 0, top: 0, width: Math.max(w, 1), height: Math.max(h, 1), overflow: 'visible', opacity: ann.opacity ?? 1 }}>
          {ann.type === 'arrow' && (
            <defs>
              <marker id={mid} markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L7,3 L0,6 z" fill={stroke} />
              </marker>
            </defs>
          )}
          <line x1={(pts[0].x - x0) * zoom} y1={(pts[0].y - y0) * zoom} x2={(pts[1].x - x0) * zoom} y2={(pts[1].y - y0) * zoom} stroke={stroke} strokeWidth={sw} markerEnd={ann.type === 'arrow' ? `url(#${mid})` : undefined} />
        </svg>
      );
    }
    if (ann.type === 'ink') {
      const x0 = ann.x, y0 = ann.y;
      const d = (ann.points || []).map((p, i) => `${i === 0 ? 'M' : 'L'}${(p.x - x0) * zoom},${(p.y - y0) * zoom}`).join(' ');
      return (
        <svg className="pointer-events-none absolute" style={{ left: 0, top: 0, width: Math.max(w, 1), height: Math.max(h, 1), overflow: 'visible', opacity: ann.opacity ?? 1 }}>
          <path d={d} fill="none" stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    }
    if (ann.type === 'note') {
      return <div className="flex h-full w-full items-center justify-center rounded-sm text-white" style={{ background: ann.color || '#ffcc00' }} title={ann.text}>📝</div>;
    }
    if (ann.type === 'image' || ann.type === 'signature') {
      return <img src={ann.imageData} alt="" className="pointer-events-none h-full w-full object-contain" draggable={false} />;
    }
    if (ann.type === 'link') {
      const label = ann.targetPage ? `→ p${ann.targetPage}` : (ann.uri || 'set link');
      return <div className="pointer-events-none flex h-full w-full items-center gap-1 overflow-hidden bg-blue-500/10 px-1 text-[10px] font-bold text-blue-300" title={ann.uri || ''}>🔗 <span className="truncate">{label}</span></div>;
    }
    return null; // box shapes styled via container
  };

  const containerStyleFor = (ann: Annotation): React.CSSProperties => {
    const base: React.CSSProperties = {
      left: ann.x * zoom, top: ann.y * zoom, width: (ann.w || 0) * zoom, height: (ann.h || 0) * zoom,
      opacity: ann.opacity ?? 1, cursor: 'move',
    };
    const stroke = ann.color || ann.borderColor || '#e23b3b';
    const sw = Math.max((ann.strokeWidth || 2) * zoom, 1);
    switch (ann.type) {
      case 'redact': return { ...base, background: '#000', opacity: 1 };
      case 'highlight': return { ...base, background: hexToRgba(ann.color || '#ffe000', ann.opacity ?? 0.4) };
      case 'underline': return { ...base, borderBottom: `${sw}px solid ${stroke}` };
      case 'strikeout': return base; // line drawn as child
      case 'rect': return { ...base, border: `${sw}px solid ${stroke}`, background: ann.fill && ann.fill !== 'transparent' ? hexToRgba(ann.fill, 0.3) : 'transparent' };
      case 'ellipse': return { ...base, border: `${sw}px solid ${stroke}`, borderRadius: '50%', background: ann.fill && ann.fill !== 'transparent' ? hexToRgba(ann.fill, 0.3) : 'transparent' };
      case 'link': return { ...base, border: '1.5px dashed #3b82f6' };
      default: return base;
    }
  };

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 z-10 overflow-hidden ${isDrawingTool ? 'cursor-crosshair' : activeTool === 'note' || activeTool === 'text' ? 'cursor-copy' : 'cursor-default'}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleLayerMouseMove}
      onMouseUp={handleLayerMouseUp}
      onMouseLeave={() => { if (dragState) setDragState(null); }}
    >
      {/* white cover over original text while editing detected text */}
      {pageAnnotations.filter((ann) => shouldPreviewTextEdit(ann)).map((ann) => (
        <div key={`${ann.id}-cover`} className="absolute pointer-events-none" style={{
          left: (ann.originalX ?? ann.x) * zoom, top: (ann.originalY ?? ann.y) * zoom,
          width: (ann.originalW ?? ann.w ?? 0) * zoom, height: (ann.originalH ?? ann.h ?? 0) * zoom,
          backgroundColor: ann.fill || '#ffffff', opacity: ann.opacity ?? 1,
        }} />
      ))}

      {pageAnnotations.map((ann) => {
        const isText = ann.type === 'text' || ann.type === 'replaceText';
        const isShape = !isText;
        const showTextEditor = ann.type === 'text' || shouldPreviewTextEdit(ann);
        const isPointShape = POINT_TYPES.includes(ann.type);

        if (isShape) {
          return (
            <div
              key={ann.id}
              className={`group absolute ${selectedAnnotationId === ann.id ? 'ring-2 ring-blue-500' : ''}`}
              style={containerStyleFor(ann)}
              onClick={(e) => { e.stopPropagation(); if (activeTool === 'select') setSelectedAnnotation(ann.id); }}
              onMouseDown={(e) => { if (activeTool === 'select' && ann.type !== 'redact') handleAnnotationPointerDown(e, ann, 'move'); }}
            >
              {renderShapeBody(ann)}
              {ann.type === 'strikeout' && <div className="pointer-events-none absolute left-0 right-0" style={{ top: '50%', borderTop: `${Math.max((ann.strokeWidth || 2) * zoom, 1)}px solid ${ann.color || '#dc2626'}` }} />}
              {ann.type === 'redact' && (
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="text-[8px] text-white font-bold uppercase tracking-tighter bg-black/50 px-1 rounded">Redaction area</span>
                </div>
              )}
              {selectedAnnotationId === ann.id && ann.type === 'redact' && (
                <button type="button" disabled={isApplyingRedaction} onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onApplyRedaction?.(); }}
                  className="absolute left-1/2 -top-8 flex h-7 -translate-x-1/2 items-center whitespace-nowrap rounded-md bg-red-600 px-3 text-[10px] font-bold uppercase tracking-wide text-white shadow-lg ring-1 ring-red-300/40 hover:bg-red-500 disabled:cursor-wait disabled:opacity-70">
                  {isApplyingRedaction ? 'Applying...' : 'Apply Redaction'}
                </button>
              )}
              {selectedAnnotationId === ann.id && !ann.locked && ann.type !== 'redact' && (
                <>
                  <button className="absolute left-1/2 -top-6 flex h-5 -translate-x-1/2 items-center rounded bg-blue-600 px-2 text-[10px] font-bold text-white shadow" onMouseDown={(e) => handleAnnotationPointerDown(e, ann, 'move')} aria-label="Move object">Move</button>
                  {!isPointShape && (
                    <>
                      <button className="absolute -left-1.5 -top-1.5 h-3 w-3 border border-blue-600 bg-white" onMouseDown={(e) => handleAnnotationPointerDown(e, ann, 'resize', 'nw')} aria-label="Resize nw" />
                      <button className="absolute -right-1.5 -top-1.5 h-3 w-3 border border-blue-600 bg-white" onMouseDown={(e) => handleAnnotationPointerDown(e, ann, 'resize', 'ne')} aria-label="Resize ne" />
                      <button className="absolute -left-1.5 -bottom-1.5 h-3 w-3 border border-blue-600 bg-white" onMouseDown={(e) => handleAnnotationPointerDown(e, ann, 'resize', 'sw')} aria-label="Resize sw" />
                      <button className="absolute -right-1.5 -bottom-1.5 h-3 w-3 border border-blue-600 bg-white" onMouseDown={(e) => handleAnnotationPointerDown(e, ann, 'resize', 'se')} aria-label="Resize se" />
                    </>
                  )}
                </>
              )}
            </div>
          );
        }

        // text / replaceText — Acrobat-style: edit the text in place, matching
        // the original font/size/colour. The white-out cover (rendered above)
        // sits exactly over the original glyphs, so the editor reads as the live
        // text rather than a separate box you have to reposition.
        const fontSizePx = (ann.fontSize || 14) * zoom;
        const displayLineHeight = ann.lineHeight || 1.2;
        const editableHover = ann.type === 'replaceText' && !showTextEditor && activeTool === 'select';
        // While editing, the box auto-sizes to the wrapped text so a paragraph
        // reflows (wrap within its width, grow downward) like Acrobat.
        return (
          <div
            key={ann.id}
            className={`absolute group ${selectedAnnotationId === ann.id ? 'ring-1 ring-blue-500/70' : ''} ${editableHover ? 'cursor-text rounded-[1px] hover:bg-sky-400/10 hover:ring-1 hover:ring-sky-400/60' : ''}`}
            style={{
              left: ann.x * zoom, top: ann.y * zoom, width: (ann.w || 0) * zoom,
              height: showTextEditor ? 'auto' : (ann.h || 0) * zoom,
              minHeight: showTextEditor ? (ann.h || 0) * zoom : undefined,
              backgroundColor: ann.type === 'text' ? ann.fill : 'transparent',
              opacity: ann.opacity, cursor: 'text',
            }}
            onClick={(e) => { e.stopPropagation(); setSelectedAnnotation(ann.id); }}
          >
            {showTextEditor && (
              <textarea
                spellCheck
                autoFocus
                ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }}
                value={ann.text || ''}
                className="block w-full resize-none border-0 bg-transparent p-0 outline-none overflow-hidden cursor-text"
                style={{
                  color: ann.color || '#111111', fontSize: `${fontSizePx}px`,
                  fontFamily: annotationFontCss(ann), fontWeight: ann.fontWeight || 'normal',
                  fontStyle: ann.fontStyle || 'normal', textDecoration: ann.textDecoration === 'underline' ? 'underline' : 'none',
                  textAlign: ann.textAlign || 'left', lineHeight: displayLineHeight,
                  background: isOcrText(ann) ? 'rgba(255, 255, 255, 0.18)' : 'transparent',
                  pointerEvents: activeTool === 'redact' ? 'none' : 'auto',
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setSelectedAnnotation(ann.id); }}
                onFocus={(e) => { const el = e.currentTarget; el.setSelectionRange(el.value.length, el.value.length); }}
                onChange={(e) => handleTextEdit(ann, e.currentTarget)}
                onBlur={(e) => handleTextEdit(ann, e.currentTarget)}
              />
            )}
          </div>
        );
      })}

      {/* live drawing previews */}
      {tempRect && isBoxTool && (
        <div className="absolute border-2 pointer-events-none" style={{
          left: tempRect.x * zoom, top: tempRect.y * zoom, width: tempRect.w * zoom, height: tempRect.h * zoom,
          borderColor: activeTool === 'redact' ? '#000' : drawColor,
          background: activeTool === 'redact' ? 'rgba(0,0,0,0.78)' : (activeTool === 'highlight' ? hexToRgba(drawColor, 0.35) : 'transparent'),
          borderRadius: activeTool === 'ellipse' ? '50%' : 0,
        }} />
      )}
      {tempPoints.length >= 2 && (isSegmentTool || isInkTool) && (
        <svg className="pointer-events-none absolute inset-0" style={{ overflow: 'visible' }}>
          {isSegmentTool ? (
            <line x1={tempPoints[0].x * zoom} y1={tempPoints[0].y * zoom} x2={tempPoints[tempPoints.length - 1].x * zoom} y2={tempPoints[tempPoints.length - 1].y * zoom} stroke={drawColor} strokeWidth={drawWidth * zoom} />
          ) : (
            <path d={tempPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x * zoom},${p.y * zoom}`).join(' ')} fill="none" stroke={drawColor} strokeWidth={drawWidth * zoom} strokeLinecap="round" strokeLinejoin="round" />
          )}
        </svg>
      )}
    </div>
  );
};

export default AnnotationLayer;

import { create } from 'zustand';

export type AnnotationType =
  | 'text' | 'replaceText' | 'redact'
  | 'highlight' | 'underline' | 'strikeout'
  | 'rect' | 'ellipse' | 'line' | 'arrow' | 'ink' | 'note'
  | 'image' | 'signature' | 'link';

// Box-drag tools that create an x/y/w/h annotation on mouse-up.
export const BOX_TOOLS: AnnotationType[] = ['redact', 'highlight', 'underline', 'strikeout', 'rect', 'ellipse', 'link'];
// Click-drag tools that create a directed segment.
export const SEGMENT_TOOLS: AnnotationType[] = ['line', 'arrow'];

export interface Annotation {
  id: string;
  type: AnnotationType;
  page: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontName?: string;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  textDecoration?: 'none' | 'underline';
  textAlign?: 'left' | 'center' | 'right';
  lineHeight?: number;
  color?: string;
  fill?: string;
  borderColor?: string;
  opacity?: number;
  strokeWidth?: number;
  fieldName?: string;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
  checked?: boolean;
  radioGroup?: string;
  points?: { x: number; y: number }[];
  imageData?: string;
  uri?: string;
  targetPage?: number;
  locked?: boolean;
  source?: 'textMap' | 'manual';
  sourceType?: 'pdf' | 'ocr' | 'widget';
  originalText?: string;
  originalX?: number;
  originalY?: number;
  originalW?: number;
  originalH?: number;
  originalFontSize?: number;
  originalFontFamily?: string;
  originalFontName?: string;
  originalColor?: string;
  originalLineHeight?: number;
}

const MAX_HISTORY = 50;

function pushHistory(history: Annotation[][], current: Annotation[]): Annotation[][] {
  const next = [...history, current];
  if (next.length > MAX_HISTORY) next.splice(0, next.length - MAX_HISTORY);
  return next;
}

interface EditorState {
  activeTool: AnnotationType | 'select';
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  zoom: number;
  currentPage: number;
  totalPages: number;
  // Default style applied to newly drawn markup/shape annotations.
  drawColor: string;
  drawFill: string;
  drawWidth: number;
  drawOpacity: number;
  _history: Annotation[][];
  _redoStack: Annotation[][];

  // Actions
  setTool: (tool: AnnotationType | 'select') => void;
  setDrawStyle: (style: Partial<Pick<EditorState, 'drawColor' | 'drawFill' | 'drawWidth' | 'drawOpacity'>>) => void;
  addAnnotation: (annotation: Annotation) => void;
  updateAnnotation: (id: string, updates: Partial<Annotation>) => void;
  removeAnnotation: (id: string) => void;
  setSelectedAnnotation: (id: string | null) => void;
  setZoom: (zoom: number) => void;
  setCurrentPage: (page: number) => void;
  setTotalPages: (total: number) => void;
  duplicateSelected: () => void;
  replaceAnnotations: (annotations: Annotation[]) => void;
  commitHistory: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clear: () => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  activeTool: 'select',
  annotations: [],
  selectedAnnotationId: null,
  zoom: 1.0,
  currentPage: 1,
  totalPages: 0,
  drawColor: '#e23b3b',
  drawFill: 'transparent',
  drawWidth: 2,
  drawOpacity: 1,
  _history: [],
  _redoStack: [],

  setTool: (activeTool) => set({ activeTool, selectedAnnotationId: null }),

  setDrawStyle: (style) => set((state) => ({ ...state, ...style })),

  addAnnotation: (annotation) => set((state) => ({
    annotations: [...state.annotations, annotation],
    _history: pushHistory(state._history, state.annotations),
    _redoStack: [],
  })),

  // Raw update — does not push history. Call commitHistory() before bulk updates
  // (e.g., drag start) or wrap via updateAnnotationWithHistory in App.tsx for
  // discrete inspector changes.
  updateAnnotation: (id, updates) => set((state) => ({
    annotations: state.annotations.map((a) => a.id === id ? { ...a, ...updates } : a),
  })),

  removeAnnotation: (id) => set((state) => ({
    annotations: state.annotations.filter((a) => a.id !== id),
    selectedAnnotationId: state.selectedAnnotationId === id ? null : state.selectedAnnotationId,
    _history: pushHistory(state._history, state.annotations),
    _redoStack: [],
  })),

  setSelectedAnnotation: (selectedAnnotationId) => set({ selectedAnnotationId }),

  setZoom: (zoom) => set({ zoom }),

  setCurrentPage: (currentPage) => set({ currentPage }),

  setTotalPages: (totalPages) => set({ totalPages }),

  duplicateSelected: () => set((state) => {
    const source = state.annotations.find((a) => a.id === state.selectedAnnotationId);
    if (!source) return state;
    const clone = {
      ...source,
      id: `ann-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      type: source.type === 'replaceText' ? 'text' as const : source.type,
      x: source.x + 16,
      y: source.y + 16,
      source: source.type === 'replaceText' ? 'manual' as const : source.source,
      originalText: undefined,
      originalX: undefined,
      originalY: undefined,
      originalW: undefined,
      originalH: undefined,
      originalFontSize: undefined,
      originalFontFamily: undefined,
      originalColor: undefined,
    };
    return {
      annotations: [...state.annotations, clone],
      selectedAnnotationId: clone.id,
      _history: pushHistory(state._history, state.annotations),
      _redoStack: [],
    };
  }),

  // Replace the whole annotation set (used when page structure changes remap
  // annotations to new page numbers). Pushes a history snapshot.
  replaceAnnotations: (annotations) => set((state) => ({
    annotations,
    selectedAnnotationId: null,
    _history: pushHistory(state._history, state.annotations),
    _redoStack: [],
  })),

  // Snapshot current annotations into history (call before a batch of raw updates)
  commitHistory: () => set((state) => ({
    _history: pushHistory(state._history, state.annotations),
    _redoStack: [],
  })),

  undo: () => set((state) => {
    if (state._history.length === 0) return state;
    const prev = state._history[state._history.length - 1];
    return {
      annotations: prev,
      _history: state._history.slice(0, -1),
      _redoStack: [...state._redoStack, state.annotations],
      selectedAnnotationId: null,
    };
  }),

  redo: () => set((state) => {
    if (state._redoStack.length === 0) return state;
    const next = state._redoStack[state._redoStack.length - 1];
    return {
      annotations: next,
      _history: [...state._history, state.annotations],
      _redoStack: state._redoStack.slice(0, -1),
      selectedAnnotationId: null,
    };
  }),

  canUndo: () => get()._history.length > 0,
  canRedo: () => get()._redoStack.length > 0,

  clear: () => set({ annotations: [], selectedAnnotationId: null, _history: [], _redoStack: [] }),
}));

import { create } from 'zustand';

export type AnnotationType = 'text' | 'replaceText' | 'redact';

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
  locked?: boolean;
  source?: 'textMap' | 'manual';
  originalText?: string;
  originalX?: number;
  originalY?: number;
  originalW?: number;
  originalH?: number;
  originalFontSize?: number;
  originalColor?: string;
}

interface EditorState {
  activeTool: AnnotationType | 'select';
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  zoom: number;
  currentPage: number;
  totalPages: number;
  
  // Actions
  setTool: (tool: AnnotationType | 'select') => void;
  addAnnotation: (annotation: Annotation) => void;
  updateAnnotation: (id: string, updates: Partial<Annotation>) => void;
  removeAnnotation: (id: string) => void;
  setSelectedAnnotation: (id: string | null) => void;
  setZoom: (zoom: number) => void;
  setCurrentPage: (page: number) => void;
  setTotalPages: (total: number) => void;
  duplicateSelected: () => void;
  undo: () => void;
  clear: () => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  activeTool: 'select',
  annotations: [],
  selectedAnnotationId: null,
  zoom: 1.0,
  currentPage: 1,
  totalPages: 0,

  setTool: (activeTool) => set({ activeTool, selectedAnnotationId: null }),
  
  addAnnotation: (annotation) => set((state) => ({ 
    annotations: [...state.annotations, annotation] 
  })),
  
  updateAnnotation: (id, updates) => set((state) => ({
    annotations: state.annotations.map((a) => a.id === id ? { ...a, ...updates } : a)
  })),
  
  removeAnnotation: (id) => set((state) => ({
    annotations: state.annotations.filter((a) => a.id !== id),
    selectedAnnotationId: state.selectedAnnotationId === id ? null : state.selectedAnnotationId
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
      originalColor: undefined,
    };
    return {
      annotations: [...state.annotations, clone],
      selectedAnnotationId: clone.id,
    };
  }),
  
  undo: () => set((state) => ({
    annotations: state.annotations.slice(0, -1)
  })),
  
  clear: () => set({ annotations: [], selectedAnnotationId: null })
}));

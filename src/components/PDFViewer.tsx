import React, { useEffect, useState, useRef, forwardRef, useImperativeHandle } from 'react';
import * as pdfjs from 'pdfjs-dist';
import AnnotationLayer from './AnnotationLayer';

// @ts-ignore
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Set worker source
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;

interface PDFViewerProps {
  url?: string;
  data?: Uint8Array | null;
  renderedPages?: PageInfo[];
  zoom: number;
  onPageChange?: (page: number) => void;
  onTotalPages?: (total: number) => void;
  onPagesRendered?: (pages: PageInfo[]) => void;
  onTextExtracted?: (pages: { page: number; text: string }[]) => void;
  onLoadError?: (message: string) => void;
  onApplyRedaction?: () => void;
  isApplyingRedaction?: boolean;
}

export interface PageInfo {
  id: string;
  index: number;
  width: number;
  height: number;
  dataUrl: string;
}

const PageRenderer = ({ page, zoom, onApplyRedaction, isApplyingRedaction }: { page: pdfjs.PDFPageProxy, zoom: number; onApplyRedaction?: () => void; isApplyingRedaction?: boolean }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let renderTask: any = null;
    
    const render = async () => {
      if (!canvasRef.current) return;
      setLoading(true);
      
      const viewport = page.getViewport({ scale: zoom * 1.5 });
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return;

      canvas.height = viewport.height;
      canvas.width = viewport.width;

      const renderContext = {
        canvasContext: context,
        viewport: viewport,
      };

      try {
        renderTask = page.render(renderContext);
        await renderTask.promise;
        setLoading(false);
      } catch (err) {
        console.error('Render error:', err);
      }
    };
    
    render();
    
    return () => {
      if (renderTask) renderTask.cancel();
    };
  }, [page, zoom]);

  const viewport = page.getViewport({ scale: 1.0 });

  return (
    <div 
      id={`page-container-${page.pageNumber}`}
      className="relative shadow-2xl bg-white transition-all duration-200 overflow-hidden"
      style={{
        width: (viewport.width * zoom),
        height: (viewport.height * zoom)
      }}
    >
      <canvas 
        ref={canvasRef} 
        style={{ width: '100%', height: '100%' }} 
      />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900/10 backdrop-blur-[2px]">
           <div className="w-8 h-8 border-2 border-rose-500/20 border-t-rose-500 rounded-full animate-spin" />
        </div>
      )}
      <AnnotationLayer 
        pageNumber={page.pageNumber}
        width={viewport.width}
        height={viewport.height}
        zoom={zoom}
        onApplyRedaction={onApplyRedaction}
        isApplyingRedaction={isApplyingRedaction}
      />
      <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[10px] font-bold text-slate-500 uppercase tracking-widest">
         Page {page.pageNumber}
      </div>
    </div>
  );
};

const ImagePageRenderer = ({ page, zoom, onApplyRedaction, isApplyingRedaction }: { page: PageInfo; zoom: number; onApplyRedaction?: () => void; isApplyingRedaction?: boolean }) => (
  <div
    id={`page-container-${page.index}`}
    className="relative shadow-2xl bg-white transition-all duration-200 overflow-hidden"
    style={{
      width: page.width * zoom,
      height: page.height * zoom
    }}
  >
    <img
      src={page.dataUrl}
      alt={`Page ${page.index}`}
      className="absolute inset-0 h-full w-full select-none"
      draggable={false}
    />
    <AnnotationLayer
      pageNumber={page.index}
      width={page.width}
      height={page.height}
      zoom={zoom}
      onApplyRedaction={onApplyRedaction}
      isApplyingRedaction={isApplyingRedaction}
    />
    <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[10px] font-bold text-slate-500 uppercase tracking-widest">
      Page {page.index}
    </div>
  </div>
);

const PDFViewer = forwardRef<any, PDFViewerProps>(({ url, data, renderedPages, zoom, onPageChange, onTotalPages, onPagesRendered, onTextExtracted, onLoadError, onApplyRedaction, isApplyingRedaction }, ref) => {
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pdfPages, setPdfPages] = useState<pdfjs.PDFPageProxy[]>([]);
  const activePageCount = renderedPages?.length || pdfPages.length;

  useImperativeHandle(ref, () => ({
    scrollToPage: (index: number) => {
      const el = document.getElementById(`page-container-${index + 1}`);
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }
  }));

  useEffect(() => {
    if (!renderedPages?.length) return;
    setPdf(null);
    setPdfPages([]);
    onTotalPages?.(renderedPages.length);
    onPagesRendered?.(renderedPages);
  }, [renderedPages, onTotalPages, onPagesRendered]);

  useEffect(() => {
    if (renderedPages?.length) return;
    const loadPdf = async () => {
      try {
        const loadingTask = pdfjs.getDocument(data ? { data } : url!);
        const pdfDoc = await loadingTask.promise;
        setPdf(pdfDoc);
        if (onTotalPages) onTotalPages(pdfDoc.numPages);
        
        const loadedPages: pdfjs.PDFPageProxy[] = [];
        const pageInfos: PageInfo[] = [];
        const textPages: { page: number; text: string }[] = [];

        for (let i = 1; i <= pdfDoc.numPages; i++) {
          const page = await pdfDoc.getPage(i);
          loadedPages.push(page);
          const textContent = await page.getTextContent();
          textPages.push({
            page: i,
            text: textContent.items.map((item: any) => item.str || '').join(' ')
          });
          
          const viewport = page.getViewport({ scale: 1.0 });
          
          // Generate small thumbnail for sidebar
          const thumbViewport = page.getViewport({ scale: 0.3 });
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          let thumbData = '';
          if (context) {
            canvas.height = thumbViewport.height;
            canvas.width = thumbViewport.width;
            await page.render({ canvasContext: context, viewport: thumbViewport }).promise;
            thumbData = canvas.toDataURL();
          }

          pageInfos.push({
            id: `page-${i}`,
            index: i,
            width: viewport.width,
            height: viewport.height,
            dataUrl: thumbData
          });
        }
        setPdfPages(loadedPages);
        if (onPagesRendered) onPagesRendered(pageInfos);
        if (onTextExtracted) onTextExtracted(textPages);
      } catch (error) {
        console.error('Error loading PDF:', error);
        if (onLoadError) onLoadError(error instanceof Error ? error.message : 'The PDF could not be rendered.');
      }
    };

    if (url || data) loadPdf();
  }, [url, data, renderedPages, onTotalPages, onPagesRendered, onTextExtracted, onLoadError]);

  useEffect(() => {
    if (!onPageChange || activePageCount === 0) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const page = visible?.target.id.match(/page-container-(\d+)/)?.[1];
      if (page) onPageChange(Number(page));
    }, { threshold: [0.35, 0.55, 0.75] });

    for (let pageNumber = 1; pageNumber <= activePageCount; pageNumber++) {
      const el = document.getElementById(`page-container-${pageNumber}`);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [activePageCount, onPageChange]);

  return (
    <div className="flex flex-col items-center p-12 gap-16 min-h-full w-full">
      {renderedPages?.length
        ? renderedPages.map((page) => <ImagePageRenderer key={page.id} page={page} zoom={zoom} onApplyRedaction={onApplyRedaction} isApplyingRedaction={isApplyingRedaction} />)
        : pdfPages.map((page) => <PageRenderer key={page.pageNumber} page={page} zoom={zoom} onApplyRedaction={onApplyRedaction} isApplyingRedaction={isApplyingRedaction} />)}
    </div>
  );
});

export default PDFViewer;

import React, { useRef, useState, useEffect } from 'react';
import { X, Eraser, Check } from 'lucide-react';

interface SignaturePadProps {
  onSave: (dataUrl: string) => void;
  onClose: () => void;
}

const SignaturePad: React.FC<SignaturePadProps> = ({ onSave, onClose }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    setIsDrawing(true);
    draw(e);
  };

  const stopDrawing = () => {
    setIsDrawing(false);
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.beginPath();
    }
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const rect = canvas.getBoundingClientRect();
    let x, y;

    if ('touches' in e) {
      x = e.touches[0].clientX - rect.left;
      y = e.touches[0].clientY - rect.top;
    } else {
      x = e.clientX - rect.left;
      y = e.clientY - rect.top;
    }

    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    if (canvas) {
      onSave(canvas.toDataURL());
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#151921] border border-slate-800 rounded-2xl shadow-2xl w-[500px] overflow-hidden animate-in fade-in zoom-in duration-200">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
           <h3 className="text-sm font-bold text-slate-200 uppercase tracking-widest">Draw Signature</h3>
           <button onClick={onClose} className="p-1 hover:bg-slate-800 rounded-md text-slate-500 hover:text-white transition-all">
              <X size={18} />
           </button>
        </div>
        
        <div className="p-8 bg-[#0b0e14]">
           <canvas
             ref={canvasRef}
             width={440}
             height={200}
             className="bg-white rounded-lg cursor-crosshair shadow-inner"
             onMouseDown={startDrawing}
             onMouseMove={draw}
             onMouseUp={stopDrawing}
             onMouseLeave={stopDrawing}
             onTouchStart={startDrawing}
             onTouchMove={draw}
             onTouchEnd={stopDrawing}
           />
           <div className="mt-2 text-[10px] text-slate-600 text-center uppercase font-bold tracking-tighter">
              Sign above using your mouse or touch screen
           </div>
        </div>

        <div className="p-4 bg-[#1a1f29] border-t border-slate-800 flex justify-between gap-4">
           <button 
             onClick={clear}
             className="flex items-center gap-2 px-4 py-2 text-xs font-bold text-slate-500 hover:text-rose-500 hover:bg-rose-500/10 rounded-lg transition-all"
           >
              <Eraser size={14} />
              Clear
           </button>
           <div className="flex gap-2">
              <button 
                onClick={onClose}
                className="px-6 py-2 text-xs font-bold text-slate-400 hover:text-white transition-all"
              >
                 Cancel
              </button>
              <button 
                onClick={handleSave}
                className="flex items-center gap-2 px-6 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-lg shadow-lg shadow-rose-900/20 transition-all"
              >
                 <Check size={14} />
                 Insert Signature
              </button>
           </div>
        </div>
      </div>
    </div>
  );
};

export default SignaturePad;

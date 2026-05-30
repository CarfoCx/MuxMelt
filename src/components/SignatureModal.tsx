import React, { useEffect, useRef, useState } from 'react';
import { PenLine, Type as TypeIcon, Upload, X, Eraser, Check } from 'lucide-react';

interface SignatureModalProps {
  open: boolean;
  onClose: () => void;
  onInsert: (dataUrl: string) => void;
  pickImage: () => Promise<string | null>;
}

type Tab = 'draw' | 'type' | 'image';

const TYPE_FONTS = [
  { label: 'Signature', css: "'Brush Script MT', 'Segoe Script', cursive" },
  { label: 'Formal', css: "'Palatino Linotype', Palatino, serif" },
  { label: 'Print', css: "Arial, Helvetica, sans-serif" },
];

const SignatureModal: React.FC<SignatureModalProps> = ({ open, onClose, onInsert, pickImage }) => {
  const [tab, setTab] = useState<Tab>('draw');
  const [typed, setTyped] = useState('');
  const [typeFont, setTypeFont] = useState(TYPE_FONTS[0].css);
  const [inkColor, setInkColor] = useState('#10243f');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);

  useEffect(() => {
    if (!open) { setTyped(''); hasInk.current = false; }
  }, [open]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || tab !== 'draw') return;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInk.current = false;
  }, [tab, open]);

  const pos = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const startDraw = (e: React.PointerEvent) => {
    drawing.current = true;
    const ctx = canvasRef.current!.getContext('2d')!;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.strokeStyle = inkColor;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  };
  const moveDraw = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext('2d')!;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    hasInk.current = true;
  };
  const endDraw = () => { drawing.current = false; };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
    hasInk.current = false;
  };

  const renderTypedToDataUrl = (): string | null => {
    const text = typed.trim();
    if (!text) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 600; canvas.height = 200;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = inkColor;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    let size = 90;
    do {
      ctx.font = `${size}px ${typeFont}`;
      if (ctx.measureText(text).width <= canvas.width - 40) break;
      size -= 4;
    } while (size > 20);
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    return canvas.toDataURL('image/png');
  };

  const handleInsert = async () => {
    if (tab === 'draw') {
      if (!hasInk.current) { onClose(); return; }
      const url = canvasRef.current!.toDataURL('image/png');
      onInsert(url);
    } else if (tab === 'type') {
      const url = renderTypedToDataUrl();
      if (url) onInsert(url);
    } else {
      const url = await pickImage();
      if (url) onInsert(url);
    }
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div className="w-[640px] max-w-[92vw] rounded-lg border border-zinc-700 bg-[#1c2027] shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-bold text-zinc-100"><PenLine size={16} className="text-cyan-400" /> Add your signature</div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white"><X size={18} /></button>
        </div>

        <div className="flex gap-1 border-b border-zinc-800 px-3 pt-3">
          <TabBtn active={tab === 'draw'} onClick={() => setTab('draw')} icon={PenLine}>Draw</TabBtn>
          <TabBtn active={tab === 'type'} onClick={() => setTab('type')} icon={TypeIcon}>Type</TabBtn>
          <TabBtn active={tab === 'image'} onClick={() => setTab('image')} icon={Upload}>Upload</TabBtn>
        </div>

        <div className="p-4">
          <div className="mb-3 flex items-center gap-3 text-xs text-zinc-400">
            <label className="flex items-center gap-1.5">Ink color <input type="color" value={inkColor} onChange={(e) => setInkColor(e.target.value)} className="h-6 w-8 cursor-pointer rounded bg-transparent" /></label>
          </div>

          {tab === 'draw' && (
            <div>
              <canvas
                ref={canvasRef}
                width={592}
                height={200}
                className="w-full cursor-crosshair touch-none rounded-md border border-dashed border-zinc-600 bg-white"
                onPointerDown={startDraw}
                onPointerMove={moveDraw}
                onPointerUp={endDraw}
                onPointerLeave={endDraw}
              />
              <button onClick={clearCanvas} className="mt-2 flex items-center gap-1 text-xs text-zinc-400 hover:text-white"><Eraser size={13} /> Clear</button>
            </div>
          )}

          {tab === 'type' && (
            <div>
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="Type your name"
                className="mb-3 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-500"
              />
              <div className="flex gap-2">
                {TYPE_FONTS.map((f) => (
                  <button key={f.label} onClick={() => setTypeFont(f.css)} className={`rounded border px-2 py-1 text-xs ${typeFont === f.css ? 'border-cyan-500 text-cyan-200' : 'border-zinc-700 text-zinc-400'}`}>{f.label}</button>
                ))}
              </div>
              <div className="mt-3 flex h-[140px] items-center justify-center rounded-md border border-dashed border-zinc-600 bg-white">
                <span style={{ fontFamily: typeFont, color: inkColor, fontSize: 56 }}>{typed || 'Preview'}</span>
              </div>
            </div>
          )}

          {tab === 'image' && (
            <div className="flex h-[200px] flex-col items-center justify-center gap-3 rounded-md border border-dashed border-zinc-600 text-zinc-400">
              <Upload size={28} />
              <span className="text-xs">Insert will open a file picker for a PNG/JPG signature.</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <button onClick={onClose} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-bold text-zinc-300 hover:bg-zinc-800">Cancel</button>
          <button onClick={handleInsert} className="flex items-center gap-1.5 rounded-md bg-cyan-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-cyan-500"><Check size={14} /> Place signature</button>
        </div>
      </div>
    </div>
  );
};

const TabBtn = ({ active, onClick, icon: Icon, children }: any) => (
  <button onClick={onClick} className={`flex items-center gap-1.5 rounded-t-md px-3 py-2 text-xs font-bold ${active ? 'bg-[#1c2027] text-cyan-300 border-b-2 border-cyan-400' : 'text-zinc-500 hover:text-zinc-300'}`}>
    <Icon size={13} />{children}
  </button>
);

export default SignatureModal;

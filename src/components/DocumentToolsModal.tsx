import React, { useEffect, useState } from 'react';
import {
  X, Info, Lock, Droplets, Hash, Bookmark, Minimize2, Loader2, Plus, Trash2, FileImage,
} from 'lucide-react';

type DocResult = any;
interface Props {
  open: boolean;
  onClose: () => void;
  onRun: (docOp: string, params?: Record<string, any>) => Promise<DocResult>;
  currentPage: number;
  totalPages: number;
}

type Section = 'metadata' | 'security' | 'watermark' | 'numbering' | 'bookmarks' | 'optimize';

const NAV: { id: Section; label: string; icon: any }[] = [
  { id: 'metadata', label: 'Properties', icon: Info },
  { id: 'security', label: 'Security', icon: Lock },
  { id: 'watermark', label: 'Watermark', icon: Droplets },
  { id: 'numbering', label: 'Page Numbers', icon: Hash },
  { id: 'bookmarks', label: 'Bookmarks', icon: Bookmark },
  { id: 'optimize', label: 'Optimize & Export', icon: Minimize2 },
];

const DocumentToolsModal: React.FC<Props> = ({ open, onClose, onRun, currentPage, totalPages }) => {
  const [section, setSection] = useState<Section>('metadata');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>('');

  const [meta, setMeta] = useState({ title: '', author: '', subject: '', keywords: '' });
  const [toc, setToc] = useState<[number, string, number][]>([]);
  const [bmTitle, setBmTitle] = useState('');

  // security
  const [userPw, setUserPw] = useState('');
  const [ownerPw, setOwnerPw] = useState('');
  const [perms, setPerms] = useState({ allowPrint: true, allowCopy: true, allowModify: true });
  const [removePw, setRemovePw] = useState('');

  // watermark
  const [wmText, setWmText] = useState('CONFIDENTIAL');
  const [wmColor, setWmColor] = useState('#888888');
  const [wmOpacity, setWmOpacity] = useState(0.18);

  // numbering
  const [numTemplate, setNumTemplate] = useState('Page {n} of {N}');
  const [numPos, setNumPos] = useState('bottom-center');
  const [numStart, setNumStart] = useState(1);
  const [batesPrefix, setBatesPrefix] = useState('');

  // export
  const [exportDpi, setExportDpi] = useState(150);
  const [exportFmt, setExportFmt] = useState('png');

  useEffect(() => {
    if (!open) return;
    setStatus('');
    onRun('get_info').then((res) => {
      if (res?.metadata) setMeta({ title: res.metadata.title || '', author: res.metadata.author || '', subject: res.metadata.subject || '', keywords: res.metadata.keywords || '' });
      if (Array.isArray(res?.toc)) setToc(res.toc.map((t: any) => [t[0], t[1], t[2]]));
    }).catch(() => {});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const run = async (docOp: string, params: Record<string, any>, doneMsg: string) => {
    setBusy(true); setStatus('');
    try {
      const res = await onRun(docOp, params);
      setStatus(res?.success === false ? (res.error || 'Operation failed.') : doneMsg);
    } catch (e: any) {
      setStatus(e?.message || 'Operation failed.');
    } finally {
      setBusy(false);
    }
  };

  const Field = ({ label, value, onChange, type = 'text', placeholder }: any) => (
    <label className="block space-y-1">
      <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">{label}</span>
      <input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-500" />
    </label>
  );

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div className="flex h-[560px] w-[820px] max-w-[94vw] overflow-hidden rounded-lg border border-zinc-700 bg-[#1c2027] shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="w-52 shrink-0 border-r border-zinc-800 bg-[#15181e] p-2">
          <div className="px-2 py-3 text-sm font-bold text-zinc-100">Document tools</div>
          {NAV.map((n) => (
            <button key={n.id} onClick={() => setSection(n.id)} className={`mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-bold ${section === n.id ? 'bg-cyan-600/20 text-cyan-200' : 'text-zinc-400 hover:bg-zinc-800'}`}>
              <n.icon size={14} />{n.label}
            </button>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <span className="text-sm font-bold text-zinc-100">{NAV.find((n) => n.id === section)?.label}</span>
            <button onClick={onClose} className="text-zinc-500 hover:text-white"><X size={18} /></button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            {section === 'metadata' && (
              <>
                <Field label="Title" value={meta.title} onChange={(v: string) => setMeta({ ...meta, title: v })} />
                <Field label="Author" value={meta.author} onChange={(v: string) => setMeta({ ...meta, author: v })} />
                <Field label="Subject" value={meta.subject} onChange={(v: string) => setMeta({ ...meta, subject: v })} />
                <Field label="Keywords" value={meta.keywords} onChange={(v: string) => setMeta({ ...meta, keywords: v })} />
                <ApplyBtn busy={busy} onClick={() => run('set_metadata', meta, 'Document properties updated.')}>Save properties</ApplyBtn>
              </>
            )}

            {section === 'security' && (
              <>
                <div className="rounded-md border border-zinc-800 p-3 space-y-3">
                  <div className="text-xs font-bold text-zinc-300">Password-protect (AES-256)</div>
                  <Field label="Open password (user)" value={userPw} onChange={setUserPw} type="password" placeholder="Required to open the file" />
                  <Field label="Permissions password (owner)" value={ownerPw} onChange={setOwnerPw} type="password" placeholder="Defaults to the open password" />
                  <div className="flex flex-wrap gap-3 text-xs text-zinc-300">
                    {(['allowPrint', 'allowCopy', 'allowModify'] as const).map((k) => (
                      <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={(perms as any)[k]} onChange={(e) => setPerms({ ...perms, [k]: e.target.checked })} className="accent-cyan-500" />{k.replace('allow', 'Allow ')}</label>
                    ))}
                  </div>
                  <ApplyBtn busy={busy} onClick={() => run('encrypt', { userPassword: userPw, ownerPassword: ownerPw, ...perms }, 'Encrypted copy saved.')} disabled={!userPw && !ownerPw}>Save protected copy</ApplyBtn>
                </div>
                <div className="rounded-md border border-zinc-800 p-3 space-y-3">
                  <div className="text-xs font-bold text-zinc-300">Remove protection</div>
                  <Field label="Current password" value={removePw} onChange={setRemovePw} type="password" />
                  <ApplyBtn busy={busy} onClick={() => run('decrypt', { password: removePw }, 'Unlocked copy saved.')}>Save unlocked copy</ApplyBtn>
                </div>
              </>
            )}

            {section === 'watermark' && (
              <>
                <Field label="Watermark text" value={wmText} onChange={setWmText} />
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-xs text-zinc-300">Color <input type="color" value={wmColor} onChange={(e) => setWmColor(e.target.value)} className="h-7 w-9 rounded bg-transparent" /></label>
                  <label className="flex flex-1 items-center gap-2 text-xs text-zinc-300">Opacity <input type="range" min={5} max={80} value={Math.round(wmOpacity * 100)} onChange={(e) => setWmOpacity(Number(e.target.value) / 100)} className="flex-1" /><span className="w-9 text-right">{Math.round(wmOpacity * 100)}%</span></label>
                </div>
                <ApplyBtn busy={busy} onClick={() => run('watermark', { text: wmText, color: wmColor, opacity: wmOpacity }, 'Watermark applied to all pages.')}>Apply watermark</ApplyBtn>
              </>
            )}

            {section === 'numbering' && (
              <>
                <Field label="Text template" value={numTemplate} onChange={setNumTemplate} placeholder="Use {n}, {N}, {bates}" />
                <p className="text-[11px] text-zinc-500">Placeholders: <b>{'{n}'}</b> page number, <b>{'{N}'}</b> total pages, <b>{'{bates}'}</b> Bates number.</p>
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1"><span className="text-[11px] font-bold uppercase text-zinc-500">Position</span>
                    <select value={numPos} onChange={(e) => setNumPos(e.target.value)} className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-100">
                      {['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'].map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </label>
                  <Field label="Start at" value={numStart} onChange={(v: string) => setNumStart(Number(v) || 1)} type="number" />
                </div>
                <Field label="Bates prefix (optional)" value={batesPrefix} onChange={setBatesPrefix} placeholder="e.g. ACME-" />
                <ApplyBtn busy={busy} onClick={() => run('stamp', { text: numTemplate, position: numPos, startNumber: numStart, batesPrefix }, 'Page numbering applied.')}>Apply numbering</ApplyBtn>
              </>
            )}

            {section === 'bookmarks' && (
              <>
                <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-zinc-800 p-2">
                  {toc.length ? toc.map((b, i) => (
                    <div key={i} className="flex items-center gap-2 rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
                      <span className="text-zinc-600" style={{ paddingLeft: (b[0] - 1) * 12 }}>•</span>
                      <span className="flex-1 truncate">{b[1]}</span>
                      <span className="text-zinc-500">p{b[2]}</span>
                      <button onClick={() => setToc(toc.filter((_, j) => j !== i))} className="text-zinc-500 hover:text-red-400"><Trash2 size={12} /></button>
                    </div>
                  )) : <div className="px-2 py-3 text-xs text-zinc-500">No bookmarks yet.</div>}
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1"><Field label={`New bookmark (page ${currentPage})`} value={bmTitle} onChange={setBmTitle} placeholder="Bookmark title" /></div>
                  <button onClick={() => { if (bmTitle.trim()) { setToc([...toc, [1, bmTitle.trim(), currentPage]]); setBmTitle(''); } }} className="mb-0.5 flex h-9 items-center gap-1 rounded-md border border-zinc-700 px-3 text-xs font-bold text-zinc-200 hover:bg-zinc-800"><Plus size={13} />Add</button>
                </div>
                <ApplyBtn busy={busy} onClick={() => run('set_bookmarks', { toc }, 'Bookmarks saved.')}>Save bookmarks</ApplyBtn>
              </>
            )}

            {section === 'optimize' && (
              <>
                <div className="rounded-md border border-zinc-800 p-3 space-y-2">
                  <div className="text-xs font-bold text-zinc-300">Reduce file size</div>
                  <p className="text-[11px] text-zinc-500">Recompress images, subset fonts, and clean unused objects into a new copy.</p>
                  <ApplyBtn busy={busy} onClick={() => run('compress', {}, 'Compressed copy saved.')}><Minimize2 size={13} />Compress PDF</ApplyBtn>
                </div>
                <div className="rounded-md border border-zinc-800 p-3 space-y-2">
                  <div className="text-xs font-bold text-zinc-300">Flatten</div>
                  <p className="text-[11px] text-zinc-500">Bake annotations and form fields into the page so they can't be edited.</p>
                  <ApplyBtn busy={busy} onClick={() => run('flatten', {}, 'Document flattened.')}>Flatten annotations & forms</ApplyBtn>
                </div>
                <div className="rounded-md border border-zinc-800 p-3 space-y-2">
                  <div className="text-xs font-bold text-zinc-300">Export pages as images</div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 text-xs text-zinc-300">DPI <input type="number" value={exportDpi} onChange={(e) => setExportDpi(Number(e.target.value) || 150)} className="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm" /></label>
                    <label className="flex items-center gap-2 text-xs text-zinc-300">Format
                      <select value={exportFmt} onChange={(e) => setExportFmt(e.target.value)} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"><option value="png">PNG</option><option value="jpg">JPG</option></select>
                    </label>
                  </div>
                  <ApplyBtn busy={busy} onClick={() => run('export_images', { dpi: exportDpi, format: exportFmt }, 'Images exported.')}><FileImage size={13} />Export images</ApplyBtn>
                </div>
              </>
            )}
          </div>

          {status && <div className="border-t border-zinc-800 px-5 py-2 text-xs text-cyan-300">{status}</div>}
        </div>
      </div>
    </div>
  );
};

const ApplyBtn = ({ children, onClick, busy, disabled }: any) => (
  <button onClick={onClick} disabled={busy || disabled} className="flex items-center justify-center gap-1.5 rounded-md bg-cyan-600 px-4 py-2 text-xs font-bold text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50">
    {busy ? <Loader2 size={14} className="animate-spin" /> : null}{children}
  </button>
);

export default DocumentToolsModal;

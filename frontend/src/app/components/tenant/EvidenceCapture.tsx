import { useEffect, useId, useRef, useState } from 'react';
import { Camera, Check, ChevronDown, Loader2, ShieldAlert, Video, X } from 'lucide-react';
import { toast } from 'sonner';
import { EvidenceAPI, type EvidenceAsset } from '../../api/client';
import { getEvidenceGuide } from './evidenceGuides';
import { useTenantPresentation } from './tenantPresentation';

const MAX_BYTES = 25 * 1024 * 1024; // keep in sync with the upload route

type Pending = { id: string; previewUrl: string; label: string | null };

function validate(file: File): string | null {
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
    return 'Only photos and videos can be added.';
  }
  if (file.size > MAX_BYTES) {
    return 'That file is too large (max 25MB).';
  }
  return null;
}

export default function EvidenceCapture({
  category,
  assets,
  onChange,
  disabled,
}: {
  category: string;
  assets: EvidenceAsset[];
  onChange: (assets: EvidenceAsset[]) => void;
  disabled?: boolean;
}) {
  const guide = getEvidenceGuide(category);
  const disclosureId = useId();
  const [pending, setPending] = useState<Pending[]>([]);
  const [open, setOpen] = useState(false);
  const tenantPresentation = useTenantPresentation();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const removalFocus = useRef(false);
  useEffect(() => {
    if (!tenantPresentation || !removalFocus.current) return;
    const frame = requestAnimationFrame(() => {
      if (!document.querySelector('[role=dialog],[role=alertdialog]') &&
          [document.body, document.documentElement].includes(document.activeElement as HTMLElement)) toggleRef.current?.focus();
      removalFocus.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [tenantPresentation, assets]);
  // A single hidden input is reused; the label for the next capture is staged here.
  const inputRef = useRef<HTMLInputElement | null>(null);
  const nextLabelRef = useRef<string | null>(null);

  const hasAsset = (label: string) => assets.some((a) => a.label === label);

  const openPicker = (label: string | null) => {
    if (disabled) return;
    nextLabelRef.current = label;
    inputRef.current?.click();
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const label = nextLabelRef.current;
    nextLabelRef.current = null;

    for (const file of Array.from(files)) {
      const error = validate(file);
      if (error) {
        toast.error(error);
        continue;
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const previewUrl = URL.createObjectURL(file);
      setPending((p) => [...p, { id, previewUrl, label }]);
      try {
        const asset = await EvidenceAPI.upload(file, label || undefined);
        onChange([...assets, asset]);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Upload failed');
      } finally {
        URL.revokeObjectURL(previewUrl);
        setPending((p) => p.filter((item) => item.id !== id));
      }
    }
  };

  const removeAsset = (asset: EvidenceAsset) => {
    onChange(assets.filter((a) => a !== asset));
  };

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={(e) => {
          void handleFiles(e.target.files);
          e.target.value = '';
        }}
      />

      <button
        ref={toggleRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="evidence-toggle"
        aria-expanded={tenantPresentation ? open : undefined}
        aria-controls={tenantPresentation ? disclosureId : undefined}
        className="flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 transition hover:text-slate-700 in-[.lichen-d5]:text-meta in-[.lichen-d5]:hover:text-ink in-[.lichen-d5]:flex-wrap in-[.lichen-d5]:text-left"
      >
        <Camera className="h-3.5 w-3.5 in-[.lichen-d5]:shrink-0" /> <span className="in-[.lichen-d5]:min-w-0 in-[.lichen-d5]:flex-1 in-[.lichen-d5]:basis-40">Add photos to help diagnose</span>
        {assets.length > 0 && (
          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 in-[.lichen-d5]:bg-mist-tint in-[.lichen-d5]:text-mist-text">
            {assets.length}
          </span>
        )}
        <ChevronDown
          className={`ml-auto h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Thumbnails stay visible even when collapsed so the tenant sees what's attached. */}
      {(assets.length > 0 || pending.length > 0) && (
        <div className="flex flex-wrap gap-2" data-testid="evidence-previews">
          {assets.map((asset, i) => (
            <div
              key={`${asset.url}-${i}`}
              className="group relative h-14 w-14 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-well"
            >
              {asset.type === 'video' ? (
                <div className="flex h-full w-full items-center justify-center text-slate-400 in-[.lichen-d5]:text-meta">
                  <Video className="h-5 w-5" />
                </div>
              ) : (
                <img src={asset.url} alt={asset.label || 'evidence'} className="h-full w-full object-cover" />
              )}
              <button
                type="button"
                onClick={() => removeAsset(asset)}
                onClickCapture={tenantPresentation ? () => { removalFocus.current = true; } : undefined}
                disabled={disabled}
                aria-label="Remove"
                className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 in-[.lichen-d5]:right-1.5 in-[.lichen-d5]:top-1.5 in-[.lichen-d5]:min-h-6 in-[.lichen-d5]:min-w-6 in-[.lichen-d5]:bg-ink in-[.lichen-d5]:text-card in-[.lichen-d5]:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {pending.map((p) => (
            <div
              key={p.id}
              className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-well"
            >
              <img src={p.previewUrl} alt="uploading" className="h-full w-full object-cover opacity-50" />
              <Loader2 className="absolute h-5 w-5 animate-spin text-[#137fec] in-[.lichen-d5]:text-lichen-text" />
            </div>
          ))}
        </div>
      )}

      {!open ? null : (
      <div id={disclosureId} className="max-h-36 space-y-2 overflow-y-auto pr-1 in-[.lichen-d5]:max-h-none">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {guide.map((item) => {
          const captured = hasAsset(item.label);
          return (
            <button
              key={item.key}
              type="button"
              disabled={disabled}
              onClick={() => openPicker(item.label)}
              data-testid={`evidence-guide-${item.key}`}
              className={`flex items-start gap-2.5 rounded-xl border p-2.5 text-left transition disabled:opacity-60 in-[.lichen-d5]:rounded-md in-[.lichen-d5]:flex-wrap ${
                captured
                  ? "border-emerald-200 bg-emerald-50 in-[.lichen-d5]:border-mist-line in-[.lichen-d5]:bg-mist-tint"
                  : "border-slate-200 bg-white hover:border-[#137fec] hover:bg-sky-50/40 in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-card in-[.lichen-d5]:hover:border-control-border in-[.lichen-d5]:hover:bg-well"
              }`}
            >
              <div
                className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                  captured ? "bg-emerald-100 text-emerald-600 in-[.lichen-d5]:bg-mist-tint in-[.lichen-d5]:text-mist-text" : "bg-[#137fec]/10 text-[#137fec] in-[.lichen-d5]:bg-chip in-[.lichen-d5]:text-chip-icon"
                }`}
              >
                {captured ? <Check className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
              </div>
              <div className="min-w-0 in-[.lichen-d5]:flex-1 in-[.lichen-d5]:basis-40">
                <div className="flex items-center gap-1 text-sm font-semibold text-slate-900 in-[.lichen-d5]:text-ink">
                  {item.label}
                  {item.safetyGated ? <ShieldAlert className="h-3.5 w-3.5 text-amber-500 in-[.lichen-d5]:text-lichen-text" /> : null}
                </div>
                <div className="text-xs text-slate-500 in-[.lichen-d5]:text-meta">
                  {item.safetyGated ? 'Only if safe to reach. ' : ''}
                  {item.hint}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        disabled={disabled}
        onClick={() => openPicker(null)}
        data-testid="evidence-add-more"
        className="text-xs font-semibold text-[#137fec] hover:underline disabled:opacity-60 in-[.lichen-d5]:text-lichen-text"
      >
        + Add another photo or video
      </button>
      </div>
      )}
    </div>
  );
}

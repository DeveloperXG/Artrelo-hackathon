import { useId } from "react";

// The Artrelo arrow. Under Lichen it is flattened to one colour: Lichen on dark
// grounds (the primary lockup), graphite on light grounds, because Lichen on
// white is 1.86:1. Never Lichen on light.
export const LOGO_MARK_COLORS = {
  lichen: "#b8c65a",
  graphite: "#0f1215",
} as const;

export type LogoTone = keyof typeof LOGO_MARK_COLORS;

export const LOGO_ARROW_PATH = `M50 8
           C52 8 53.5 9 54.4 10.8
           L77 70
           C78.2 73 76 76 73 74.5
           L51.6 58
           C50.6 57.2 49.4 57.2 48.4 58
           L27 74.5
           C24 76.5 21.5 73.5 23 70.5
           L45.6 10.8
           C46.5 9 48 8 50 8 Z`;

interface AstreloLogoProps {
  className?: string;
  // Pin the flat mark. Left unset, the mark follows its context: Lichen inside
  // a .lichen scope (theme.css sets --logo-mark), and the original gradient
  // artwork on screens not yet migrated, which are a mix of dark and light
  // grounds that a single flat colour cannot serve.
  tone?: LogoTone;
}

export default function AstreloLogo({ className = "w-5 h-5", tone }: AstreloLogoProps) {
  // Per instance: two logos on one page must not share a gradient id.
  const gradientId = `astreloGradient-${useId().replace(/:/g, "")}`;
  const fill = tone ? LOGO_MARK_COLORS[tone] : `var(--logo-mark, url(#${gradientId}))`;
  return (
    <svg viewBox="0 0 100 100" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      {!tone && (
        <defs>
          <linearGradient id={gradientId} x1="20%" y1="0%" x2="90%" y2="100%">
            <stop offset="0%" stopColor="#7dd3fc" />
            <stop offset="45%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#6366f1" />
          </linearGradient>
        </defs>
      )}
      <path d={LOGO_ARROW_PATH} style={{ fill }} />
    </svg>
  );
}

interface AstreloLockupProps {
  className?: string;
  markClassName?: string;
}

// Primary lockup for dark Lichen grounds: Lichen mark + Ink wordmark, IBM Plex
// Sans Bold at -2.5% tracking. The wordmark is real text, so it names the
// product to assistive technology; the mark beside it is decorative.
export function AstreloLockup({ className = "", markClassName = "h-6 w-6" }: AstreloLockupProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <AstreloLogo className={markClassName} tone="lichen" />
      <span className="font-sans font-bold tracking-[-0.025em] text-ink">Artrelo</span>
    </span>
  );
}

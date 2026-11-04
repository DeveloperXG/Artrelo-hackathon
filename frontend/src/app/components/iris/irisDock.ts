/**
 * Docked Iris on wide screens: the panel sits beside the page and the page
 * reflows, instead of a modal sheet covering it. Pure sizing rules here; the
 * provider measures, the shell reserves the space and the panel draws it.
 *
 * Width is in memory only (provider state): it survives child navigation and
 * resets at sign-out or a new identity. Nothing is stored or sent.
 */
export const DOCK = {
  defaultWidth: 560,
  minWidth: 400,
  maxWidth: 760,
  /** The page keeps at least this much usable width beside the panel. */
  minPage: 600,
  divider: 8,
  step: 16,
  bigStep: 64,
} as const;

export interface DockLayout {
  docked: boolean;
  /** The width actually used, clamped to fit. */
  width: number;
  /** The bounds the separator reports and enforces right now. */
  min: number;
  max: number;
}

/**
 * `available` is the page column's usable width with no panel: the viewport
 * minus the sidebar offset and the page padding. Those do not change when the
 * panel docks, so docking cannot feed back into its own breakpoint.
 */
export function dockLayout(available: number, requested: number): DockLayout {
  const max = Math.min(DOCK.maxWidth, Math.floor(available - DOCK.minPage - DOCK.divider));
  if (!Number.isFinite(available) || max < DOCK.minWidth) {
    return { docked: false, width: DOCK.defaultWidth, min: DOCK.minWidth, max: DOCK.maxWidth };
  }
  return { docked: true, width: clampWidth(requested, DOCK.minWidth, max), min: DOCK.minWidth, max };
}

export function clampWidth(width: number, min: number, max: number) {
  return Math.round(Math.min(max, Math.max(min, Number.isFinite(width) ? width : DOCK.defaultWidth)));
}

/**
 * Keyboard resizing for the separator, which sits on the panel's left edge:
 * Left widens the panel, Right narrows it (Shift for bigger steps), Home and
 * End jump to the smallest and largest width. Null for any other key.
 */
export function keyResize(width: number, key: string, shift: boolean, min: number, max: number): number | null {
  const step = shift ? DOCK.bigStep : DOCK.step;
  switch (key) {
    case 'ArrowLeft':
      return clampWidth(width + step, min, max);
    case 'ArrowRight':
      return clampWidth(width - step, min, max);
    case 'Home':
      return min;
    case 'End':
      return max;
    default:
      return null;
  }
}

/** Dragging the left edge: moving the pointer left by N px widens the panel by N. */
export function dragResize(startWidth: number, startX: number, x: number, min: number, max: number) {
  return clampWidth(startWidth + (startX - x), min, max);
}

/**
 * The platform's classic scrollbar width (0 for overlay scrollbars), measured
 * once. The dock decision always reserves it, so a scrollbar appearing when
 * the docked page gets taller can neither eat into the page minimum nor flip
 * the mode back.
 */
let scrollbar: number | null = null;
export function scrollbarAllowance(): number {
  if (scrollbar !== null) return scrollbar;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll';
  document.body.appendChild(probe);
  scrollbar = Math.max(0, probe.offsetWidth - probe.clientWidth);
  probe.remove();
  return scrollbar;
}

/** Usable page width with no panel, from the page column's own box. */
export function availablePageWidth(main: HTMLElement | null, viewport: number): number {
  if (!main) return Number.NaN;
  const style = getComputedStyle(main);
  const px = (v: string) => Number.parseFloat(v) || 0;
  return viewport - px(style.marginLeft) - px(style.paddingLeft) - px(style.paddingRight);
}

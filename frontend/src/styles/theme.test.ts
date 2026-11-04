import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Reads the real stylesheet, so a token edit that breaks the owner palette or
// an approved accessibility role fails here rather than in a screenshot.
// Line endings are normalised once here, so the block parsers below match on a
// CRLF (Windows) checkout exactly as on an LF one.
const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8').replace(/\r\n?/g, '\n');

// Owner record ARTRELO_OWNER_PALETTE_LICHEN.md, verbatim.
const OWNER = {
  ground: '#0f1215', sidebar: '#0a0c0e', surface: '#161a1e', inset: '#12161a',
  hairline: '#22272c', border: '#262c32', chip: '#1e2328', 'chip-ring': '#2b3238',
  ink: '#e8ebee', muted: '#98a0a8', faint: '#6d757d', nav: '#adb4bb', 'chip-icon': '#c2c9d0',
  lichen: '#b8c65a', 'on-lichen': '#0f1215', 'lichen-text': '#cbd87a', 'lichen-tint': '#22281a',
  'lichen-wash': '#1d2214', 'lichen-line': '#4a5426', 'focus-ring': 'rgba(184, 198, 90, 0.15)',
  mist: '#7fa3bd', 'mist-text': '#9cc0da', 'mist-tint': '#1c2833', 'mist-line': '#2c3a44',
  alert: '#ee8b78', 'alert-tint': '#2d1c1a', 'alert-line': '#4a2a26', closed: '#363d44',
} as const;

function declarations(block: string) {
  const map = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) map.set(name, value.trim());
  return map;
}

const rootBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/)![1];
const root = declarations(rootBlock);
const lichenBlock = css.match(/\n\.lichen\s*\{([\s\S]*?)\n\}/)![1];
const lichen = declarations(lichenBlock);
// The --role-* layer: dark on :root and every .lichen, light on .lichen.lichen-light.
const darkRolesBlock = css.match(/\n:root,\n\.lichen\s*\{([\s\S]*?)\n\}/)![1];
const darkRoles = declarations(darkRolesBlock);
const lightBlock = css.match(/\n\.lichen\.lichen-light\s*\{([\s\S]*?)\n\}/)![1];
const light = declarations(lightBlock);
const themeInline = declarations(css.match(/@theme inline\s*\{([\s\S]*?)\n\}/)![1]);

type Context = 'legacy' | 'lichen' | 'light';

// Follow var() chains down to a literal value, the way the cascade would for
// an element at :root (legacy), inside a dark .lichen scope, or inside a
// .lichen.lichen-light scope (which out-specifies .lichen on the same element).
function lookup(name: string, context: Context) {
  return (context === 'light' ? light.get(name) : undefined)
    ?? (context !== 'legacy' ? lichen.get(name) : undefined)
    ?? darkRoles.get(name) ?? root.get(name) ?? themeInline.get(name);
}
function resolve(value: string, context: Context): string {
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (!ref) return value;
  const next = lookup(ref[1], context);
  if (!next) throw new Error(`unresolved ${ref[1]}`);
  return resolve(next, context);
}
const token = (name: string, context: Context = 'lichen') => resolve(lookup(name, context)!, context);
const color = (name: string, context: Context = 'lichen') => resolve(themeInline.get(`--color-${name}`)!, context);

// Source-over composite of a translucent colour on an opaque one, for the
// alpha hovers (bg-hairline/60, bg-lichen/90).
function over(hex: string, alpha: number, bg: string) {
  const ch = (v: string, i: number) => parseInt(v.slice(i, i + 2), 16);
  return '#' + [1, 3, 5].map((i) => Math.round(ch(hex, i) * alpha + ch(bg, i) * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}

// WCAG 2.x relative luminance and contrast. Handles #rrggbb and the legacy
// achromatic oklch(L 0 0) values, whose linear luminance is L cubed.
function luminance(value: string) {
  const gray = value.match(/^oklch\(([\d.]+) 0 0\)$/);
  if (gray) return Number(gray[1]) ** 3;
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`cannot measure ${value}`);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('owner primitives', () => {
  it('declares all 28 owner tokens verbatim', () => {
    for (const [name, value] of Object.entries(OWNER)) {
      expect(root.get(`--artrelo-${name}`), name).toBe(value);
    }
  });

  it('defines the primitives globally, so any scope can use them', () => {
    expect(lichenBlock).not.toMatch(/--artrelo-[\w-]+:/);
  });
});

describe('semantic bridge inside a .lichen scope', () => {
  it('resolves the shadcn roles to the approved mapping', () => {
    expect(token('--background')).toBe(OWNER.ground);
    expect(token('--foreground')).toBe(OWNER.ink);
    expect(token('--card')).toBe(OWNER.surface);
    expect(token('--popover')).toBe(OWNER.surface);
    expect(token('--primary')).toBe(OWNER.lichen);
    expect(token('--primary-foreground')).toBe(OWNER['on-lichen']);
    expect(token('--sidebar')).toBe(OWNER.sidebar);
    expect(token('--sidebar-foreground')).toBe(OWNER.nav);
    expect(token('--border')).toBe(OWNER.border);
  });

  it('keeps --muted a background and maps owner muted to text (collision resolved)', () => {
    expect(token('--muted')).toBe(OWNER.chip);
    expect(token('--muted-foreground')).toBe(OWNER.muted);
    expect(color('meta')).toBe(OWNER.muted);
  });

  it('separates the field outline (--input) from its fill (--input-background)', () => {
    expect(token('--input')).toBe(OWNER.faint);
    expect(token('--input-background')).toBe(OWNER.inset);
    expect(color('control-border')).toBe(OWNER.faint);
  });

  it('keeps --accent a neutral hover surface, not Lichen', () => {
    expect(token('--accent')).toBe(OWNER.hairline);
    expect(token('--accent-foreground')).toBe(OWNER.ink);
  });

  it('labels the Alert fill in graphite, never white', () => {
    expect(token('--destructive')).toBe(OWNER.alert);
    expect(token('--destructive-foreground')).toBe(OWNER['on-lichen']);
  });

  it('turns on dark native controls and the flat Lichen logo', () => {
    expect(lichenBlock).toMatch(/color-scheme: dark;/);
    expect(token('--logo-mark')).toBe(OWNER.lichen);
  });

  it('uses solid Lichen for --ring and keeps the 15% primitive out of Tailwind', () => {
    expect(token('--ring')).toBe(OWNER.lichen);
    expect(css).not.toMatch(/--color-focus-ring/);
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/ring-ring\/50|outline-ring\/50/);
  });

  it('does not expose faint as a text colour', () => {
    expect(themeInline.has('--color-faint')).toBe(false);
  });

  it('sets 8px cards and 6px controls', () => {
    expect(lichen.get('--radius')).toMatch(/^0\.5rem/);
    expect(themeInline.get('--radius-md')).toBe('calc(var(--radius) - 2px)');
  });
});

describe('contrast of the roles in use', () => {
  const surfaces = [OWNER.ground, OWNER.surface, OWNER.inset];

  it('normal text roles reach 4.5:1 on every primary background', () => {
    for (const fg of [token('--foreground'), token('--muted-foreground'), color('nav'), color('chip-icon'),
      color('lichen'), color('lichen-text'), color('mist'), color('mist-text'), color('alert')]) {
      for (const bg of surfaces) expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the owner status pills and fills pass 4.5:1', () => {
    const pairs: [string, string][] = [
      [color('lichen-text'), color('lichen-tint')],
      [color('lichen-text'), color('lichen-wash')],
      [color('mist-text'), color('mist-tint')],
      [color('chip-icon'), color('hairline')],
      [color('meta'), color('chip')],
      [color('alert'), color('alert-tint')],
      [token('--primary-foreground'), token('--primary')],
      [token('--destructive-foreground'), token('--destructive')],
    ];
    for (const [fg, bg] of pairs) expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it('focus and required field boundaries reach 3:1', () => {
    for (const bg of [...surfaces, OWNER.sidebar, OWNER.chip, OWNER['lichen-tint'], OWNER['mist-tint'], OWNER['alert-tint']]) {
      expect(contrast(token('--ring'), bg), `ring on ${bg}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(token('--input'), OWNER.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(token('--input'), token('--input-background'))).toBeGreaterThanOrEqual(3);
    expect(contrast(token('--destructive'), token('--input-background'))).toBeGreaterThanOrEqual(3);
  });

  it('documents why faint and white are not used as labels', () => {
    expect(contrast(OWNER.faint, OWNER.surface)).toBeLessThan(4.5);
    expect(contrast('#ffffff', OWNER.alert)).toBeLessThan(4.5);
  });
});

describe('legacy context (:root) until every surface is migrated', () => {
  // The pre-Lichen light values, verbatim: un-migrated pages wrap the shared
  // primitives in hard-coded light markup and must keep rendering as before.
  const LEGACY = {
    '--background': '#ffffff', '--foreground': 'oklch(0.145 0 0)', '--card': '#ffffff',
    '--card-foreground': 'oklch(0.145 0 0)', '--popover': 'oklch(1 0 0)', '--popover-foreground': 'oklch(0.145 0 0)',
    '--primary': '#030213', '--primary-foreground': 'oklch(1 0 0)', '--muted': '#ececf0', '--muted-foreground': '#717182',
    '--accent': '#e9ebef', '--accent-foreground': '#030213', '--destructive': '#d4183d', '--destructive-foreground': '#ffffff',
    '--border': 'rgba(0, 0, 0, 0.1)', '--input': 'transparent', '--input-background': '#f3f3f5',
    '--radius': '0.625rem',
  };

  it('keeps the legacy semantic values (except --ring) and no global dark scheme or logo colour', () => {
    for (const [name, value] of Object.entries(LEGACY)) expect(root.get(name), name).toBe(value);
    expect(rootBlock).not.toMatch(/color-scheme|--logo-mark/);
    expect(css).not.toMatch(/\.dark\s*\{/);
  });

  it('keeps every shared primitive readable on the light pages that still use them', () => {
    // [what, foreground token, background token]
    const pairs: [string, string, string][] = [
      ['ghost/link button and card text (inherited)', '--foreground', '--card'],
      ['outline button', '--foreground', '--background'],
      ['card', '--card-foreground', '--card'],
      ['dialog and menu', '--popover-foreground', '--popover'],
      ['input text', '--foreground', '--input-background'],
      ['default button', '--primary-foreground', '--primary'],
      ['destructive button', '--destructive-foreground', '--destructive'],
      ['menu hover', '--accent-foreground', '--accent'],
    ];
    for (const [what, fg, bg] of pairs) {
      expect(contrast(token(fg, 'legacy'), token(bg, 'legacy')), what).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('draws legacy focus in an existing neutral that reaches 3:1 where focus lands', () => {
    // Deliberate D1 correction: the shadcn grey was ~2.6:1 on white once it
    // became the solid focus outline of the shared primitives.
    expect(contrast('oklch(0.708 0 0)', '#ffffff')).toBeLessThan(3);
    const ring = token('--ring', 'legacy');
    expect(ring).toBe(token('--muted-foreground', 'legacy'));
    const grounds: [string, string][] = [
      ['background', token('--background', 'legacy')],
      ['card', token('--card', 'legacy')],
      ['popover', token('--popover', 'legacy')],
      ['field fill', token('--input-background', 'legacy')],
      ['muted', token('--muted', 'legacy')],
      ['accent hover', token('--accent', 'legacy')],
      ['dark auth ground', '#0a0f14'],
      ['dark auth card (rgba(18,24,31,0.8) on ground)', '#10161d'],
    ];
    for (const [what, bg] of grounds) expect(contrast(ring, bg), what).toBeGreaterThanOrEqual(3);
  });
});

// Owner Lichen LIGHT record (LICHEN_LIGHT_TASK.md), verbatim.
const LIGHT = {
  page: '#ffffff', surface: '#ffffff', inset: '#f6f7f8', hairline: '#eceef0', border: '#e1e4e8',
  chip: '#f1f3f5', 'chip-ring': '#e1e4e8', 'chip-icon': '#3b434b', ink: '#0f1215', muted: '#545c64', faint: '#6b737b',
  'lichen-text': '#56620f', 'pill-text': '#4f5a10', 'lichen-tint': '#eef2d2', 'lichen-wash': '#f6f8e6',
  'lichen-line': '#d6de9c', 'lichen-icon': '#6b7a12', 'new-row': '#fafbf0', halo: 'rgba(184, 198, 90, 0.35)',
  'mist-text': '#2f5a78', 'mist-tint': '#e6eef4', 'mist-line': '#c9d9e5',
  alert: '#b8432e', 'alert-text': '#9c3826', 'alert-tint': '#fbebe7', 'alert-line': '#f0c8bf',
  closed: '#d3d8dc', 'pill-neutral': '#eef0f2', 'card-shadow': '0 1px 2px rgba(15, 18, 21, 0.04)',
} as const;

describe('scoped split: dark chrome and Lichen light content', () => {
  const roleNames = [...darkRoles.keys()];

  it('declares the light primitives verbatim and globally, plus the dark sidebar sub-label', () => {
    for (const [name, value] of Object.entries(LIGHT)) expect(root.get(`--artrelo-light-${name}`), name).toBe(value);
    expect(root.get('--artrelo-sidebar-sub')).toBe('#848c94');
    expect(lightBlock).not.toMatch(/--artrelo-[\w-]+:/);
    expect(darkRolesBlock).not.toMatch(/--artrelo-[\w-]+:/);
  });

  it('routes every Lichen Tailwind colour through a --role-* variable', () => {
    for (const [name, value] of themeInline) {
      if (!name.startsWith('--color-') || value.startsWith('var(--role-')) continue;
      // shadcn bridge colours and the chrome-only sub-label are the only exceptions.
      expect(value, name).toMatch(/^var\(--(?!artrelo-)[\w-]+\)$|^var\(--artrelo-sidebar-sub\)$/);
    }
    for (const [, value] of themeInline) {
      const role = value.match(/^var\((--role-[\w-]+)\)$/)?.[1];
      if (role) expect(darkRoles.has(role), role).toBe(true);
    }
  });

  it('declares the dark roles explicitly on .lichen, so light never leaks into dark chrome', () => {
    expect(css).toMatch(/\n:root,\n\.lichen\s*\{/);
    for (const role of roleNames) expect(darkRoles.get(role), role).toMatch(/^var\(--artrelo-(?!light-)[\w-]+\)$|^none$/);
  });

  it('gives the light scope a value for every role and every shadcn bridge role', () => {
    for (const role of roleNames) expect(light.has(role), role).toBe(true);
    for (const name of lichen.keys()) {
      if (name.startsWith('--sidebar') || name === '--radius') continue;
      expect(light.has(name), name).toBe(true);
    }
    // Light lives only on the compound selector, never on :root or bare .lichen.
    expect(css.match(/--artrelo-light-/g)!.length).toBeGreaterThan(0);
    const outside = css.replace(lightBlock, '').replace(rootBlock, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(outside).not.toMatch(/var\(--artrelo-light-/);
  });

  it('resolves a lichen colour to dark in .lichen and light in .lichen.lichen-light', () => {
    const pairs: [string, string, string][] = [
      ['ground', OWNER.ground, LIGHT.page], ['surface', OWNER.surface, LIGHT.surface], ['well', OWNER.inset, LIGHT.inset],
      ['hairline', OWNER.hairline, LIGHT.hairline], ['chip', OWNER.chip, LIGHT.chip], ['ink', OWNER.ink, LIGHT.ink],
      ['meta', OWNER.muted, LIGHT.muted], ['chip-icon', OWNER['chip-icon'], LIGHT['chip-icon']],
      ['control-border', OWNER.faint, LIGHT.faint], ['lichen', OWNER.lichen, OWNER.lichen],
      ['on-lichen', OWNER['on-lichen'], OWNER['on-lichen']], ['lichen-text', OWNER['lichen-text'], LIGHT['lichen-text']],
      ['lichen-pill', OWNER['lichen-text'], LIGHT['pill-text']], ['lichen-icon', OWNER.lichen, LIGHT['lichen-icon']],
      ['lichen-tint', OWNER['lichen-tint'], LIGHT['lichen-tint']], ['lichen-wash', OWNER['lichen-wash'], LIGHT['lichen-wash']],
      ['lichen-line', OWNER['lichen-line'], LIGHT['lichen-line']], ['new-row', OWNER['lichen-wash'], LIGHT['new-row']],
      ['mist', OWNER.mist, OWNER.mist], ['mist-text', OWNER['mist-text'], LIGHT['mist-text']],
      ['mist-tint', OWNER['mist-tint'], LIGHT['mist-tint']], ['alert', OWNER.alert, LIGHT.alert],
      ['alert-text', OWNER.alert, LIGHT['alert-text']], ['alert-tint', OWNER['alert-tint'], LIGHT['alert-tint']],
      ['closed', OWNER.closed, LIGHT.closed], ['pill-neutral', OWNER.hairline, LIGHT['pill-neutral']],
    ];
    for (const [name, dark, lightValue] of pairs) {
      expect(color(name, 'lichen'), `${name} dark`).toBe(dark);
      expect(color(name, 'light'), `${name} light`).toBe(lightValue);
    }
    expect(color('sidebar-sub', 'lichen')).toBe('#848c94');
    expect(token('--role-card-shadow', 'lichen')).toBe('none');
    expect(token('--role-card-shadow', 'light')).toBe(LIGHT['card-shadow']);
  });

  it('maps the light shadcn bridge, native controls and the graphite logo', () => {
    expect(lightBlock).toMatch(/color-scheme: light;/);
    expect(token('--logo-mark', 'light')).toBe(OWNER['on-lichen']);
    expect(token('--background', 'light')).toBe(LIGHT.page);
    expect(token('--foreground', 'light')).toBe(LIGHT.ink);
    expect(token('--card', 'light')).toBe(LIGHT.surface);
    expect(token('--popover', 'light')).toBe(LIGHT.surface);
    expect(token('--primary', 'light')).toBe(OWNER.lichen);
    expect(token('--primary-foreground', 'light')).toBe(OWNER['on-lichen']);
    expect(token('--muted', 'light')).toBe(LIGHT.chip);
    expect(token('--muted-foreground', 'light')).toBe(LIGHT.muted);
    expect(token('--accent', 'light')).toBe(LIGHT.hairline);
    expect(token('--border', 'light')).toBe(LIGHT.border);
    expect(token('--input', 'light')).toBe(LIGHT.faint);
    expect(token('--input-background', 'light')).toBe(LIGHT.inset);
    expect(token('--ring', 'light')).toBe(LIGHT['lichen-text']);
    expect(token('--destructive', 'light')).toBe(LIGHT.alert);
    expect(token('--destructive-foreground', 'light')).toBe('#ffffff');
  });

  it('keeps the light scope off the global :root', () => {
    expect(rootBlock).not.toMatch(/color-scheme|--logo-mark|--role-/);
    expect(css).not.toMatch(/^\.lichen-light\s*\{/m);
  });
});

describe('contrast of the light roles in use', () => {
  const grounds = { white: LIGHT.page, inset: LIGHT.inset, chip: LIGHT.chip, hairline: LIGHT.hairline, 'new-row': LIGHT['new-row'] };

  it('normal text roles reach 4.5:1 on every light ground', () => {
    for (const name of ['ink', 'meta', 'nav', 'chip-icon', 'lichen-text', 'lichen-pill', 'mist-text', 'alert-text']) {
      for (const [where, bg] of Object.entries(grounds)) {
        expect(contrast(color(name, 'light'), bg), `${name} on ${where}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(token('--muted-foreground', 'light'), LIGHT.page)).toBeGreaterThanOrEqual(4.5);
  });

  it('the light pills and fills pass 4.5:1', () => {
    const pairs: [string, string, string][] = [
      ['In progress / Needs approval', color('lichen-pill', 'light'), color('lichen-tint', 'light')],
      ['Approved / Contacting', color('mist-text', 'light'), color('mist-tint', 'light')],
      ['Assigned / Queued', color('chip-icon', 'light'), color('pill-neutral', 'light')],
      ['Completed', color('meta', 'light'), color('chip', 'light')],
      ['Rejected', color('alert-text', 'light'), color('alert-tint', 'light')],
      ['banner text on wash', color('lichen-text', 'light'), color('lichen-wash', 'light')],
      ['primary button', token('--primary-foreground', 'light'), token('--primary', 'light')],
      ['primary hover (bg-lichen/90 on white)', OWNER['on-lichen'], over(OWNER.lichen, 0.9, LIGHT.page)],
      ['destructive button', token('--destructive-foreground', 'light'), token('--destructive', 'light')],
      ['on-alert fill', color('on-alert', 'light'), color('alert', 'light')],
      ['row hover (bg-hairline/60 on white)', LIGHT.ink, over(LIGHT.hairline, 0.6, LIGHT.page)],
    ];
    for (const [what, fg, bg] of pairs) expect(contrast(fg, bg), what).toBeGreaterThanOrEqual(4.5);
  });

  it('icons, focus and required field boundaries reach 3:1', () => {
    const backgrounds = [...Object.values(grounds), LIGHT['lichen-tint'], LIGHT['lichen-wash'], LIGHT['mist-tint'], LIGHT['alert-tint']];
    for (const bg of backgrounds) {
      expect(contrast(token('--ring', 'light'), bg), `ring on ${bg}`).toBeGreaterThanOrEqual(3);
      expect(contrast(color('lichen-icon', 'light'), bg), `icon on ${bg}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(token('--input', 'light'), LIGHT.page)).toBeGreaterThanOrEqual(3);
    expect(contrast(token('--input', 'light'), token('--input-background', 'light'))).toBeGreaterThanOrEqual(3);
    expect(contrast(token('--destructive', 'light'), token('--input-background', 'light'))).toBeGreaterThanOrEqual(3);
  });

  it('documents why Lichen is a fill only on light, and graphite cannot label the light Alert', () => {
    expect(contrast(OWNER.lichen, LIGHT.page)).toBeLessThan(3);
    expect(contrast(OWNER['on-lichen'], LIGHT.alert)).toBeLessThan(4.5);
  });
});

describe('dark chrome tokens', () => {
  it('keeps the sidebar sub-label and nav readable on the sidebar ground', () => {
    expect(contrast(color('sidebar-sub'), OWNER.sidebar)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color('nav'), OWNER.sidebar)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color('lichen'), OWNER.hairline)).toBeGreaterThanOrEqual(3);
  });
});

describe('typography', () => {
  it('maps the Tailwind families to IBM Plex with system fallbacks', () => {
    const theme = declarations(css.match(/@theme\s*\{([\s\S]*?)\n\}/)![1]);
    expect(theme.get('--font-sans')).toMatch(/^'IBM Plex Sans', ui-sans-serif, system-ui/);
    expect(theme.get('--font-mono')).toMatch(/^'IBM Plex Mono', ui-monospace/);
    expect(theme.get('--font-sans')).toMatch(/Emoji/);
    expect(css).toMatch(/font-synthesis: style;/);
  });
});

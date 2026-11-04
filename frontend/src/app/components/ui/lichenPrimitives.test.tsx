import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from './button';
import { Input } from './input';
import { Textarea } from './textarea';
import { Badge } from './badge';
import { Card } from './card';
import { FieldError, invalidFieldClass } from './FieldError';
import AstreloLogo, { AstreloLockup } from '../AstreloLogo';

const html = (element: ReactElement) => renderToStaticMarkup(element);
const classOf = (markup: string) => markup.match(/class="([^"]*)"/)![1].split(/\s+/);

// outline-solid matters: outline-none sets --tw-outline-style to none, which a
// bare outline-2 would inherit, painting nothing.
const SOLID_FOCUS = ['focus-visible:outline-solid', 'focus-visible:outline-2', 'focus-visible:outline-offset-2', 'focus-visible:outline-ring'];
// A translucent ring as the focus cue, a glow, or a dark: override that would
// dilute the owner fills once a .dark ancestor exists.
const FORBIDDEN = /ring-ring\/50|ring-\[3px\]|ring-destructive\/|shadow-|dark:|text-white/;

describe('shared controls', () => {
  const controls = {
    'button default': html(<Button>Save</Button>),
    'button destructive': html(<Button variant="destructive">Remove</Button>),
    'button outline': html(<Button variant="outline">Cancel</Button>),
    'button ghost': html(<Button variant="ghost">More</Button>),
    input: html(<Input placeholder="Email" />),
    textarea: html(<Textarea placeholder="Notes" />),
  };

  it('uses the solid Lichen outline as the focus cue and no glow or white labels', () => {
    for (const [name, markup] of Object.entries(controls)) {
      const classes = classOf(markup);
      for (const cls of SOLID_FOCUS) expect(classes, name).toContain(cls);
      expect(markup, name).not.toMatch(FORBIDDEN);
    }
  });

  it('labels the destructive fill in graphite (destructive-foreground)', () => {
    const classes = classOf(controls['button destructive']);
    expect(classes).toContain('bg-destructive');
    expect(classes).toContain('text-destructive-foreground');
  });

  it('gives fields a visible boundary, inset fill and readable placeholder', () => {
    for (const name of ['input', 'textarea'] as const) {
      const classes = classOf(controls[name]);
      expect(classes, name).toEqual(expect.arrayContaining([
        'border-input', 'bg-input-background', 'text-foreground', 'placeholder:text-muted-foreground', 'aria-invalid:border-destructive',
      ]));
    }
  });

  it('keeps native behaviour and ARIA passthrough', () => {
    const markup = html(<Input aria-invalid aria-describedby="email-error" disabled data-testid="signin-email-input" />);
    expect(markup).toMatch(/aria-invalid="true"/);
    expect(markup).toMatch(/aria-describedby="email-error"/);
    expect(markup).toMatch(/disabled=""/);
    expect(markup).toMatch(/data-testid="signin-email-input"/);
    expect(html(<Button disabled>Save</Button>)).toMatch(/disabled=""/);
  });

  it('rounds controls at 6px and, inside a Lichen scope, cards at 8px with only the scoped card shadow', () => {
    // rounded-md is 6px under the Lichen --radius; legacy keeps its own radius.
    expect(classOf(controls['button default'])).toContain('rounded-md');
    expect(classOf(controls.input)).toContain('rounded-md');
    const card = html(<Card>Body</Card>);
    expect(classOf(card)).toEqual(expect.arrayContaining(['rounded-xl', 'lichen:rounded-lg']));
    // shadow-lichen-card is none in dark and the owner's 1px shadow on light.
    expect(classOf(card)).toContain('lichen:shadow-lichen-card');
    expect(card.replace('lichen:shadow-lichen-card', '')).not.toMatch(/shadow/);
  });

  it('leaves ghost buttons inheriting the surrounding text colour (readable on legacy white cards)', () => {
    const textColours = classOf(controls['button ghost']).filter((c) => /^text-(?!sm$)/.test(c));
    expect(textColours).toEqual([]);
    expect(classOf(controls['button outline'])).toEqual(expect.arrayContaining(['bg-background', 'text-foreground', 'lichen:bg-transparent']));
  });
});

describe('status badges', () => {
  it('renders as full pills (inside a Lichen scope) with the owner status colours', () => {
    const expected: Record<string, string[]> = {
      live: ['bg-lichen-tint', 'text-lichen-pill'],
      confirmed: ['bg-mist-tint', 'text-mist-text'],
      queued: ['bg-pill-neutral', 'text-chip-icon'],
      done: ['bg-chip', 'text-meta'],
      alert: ['bg-alert-tint', 'text-alert-text'],
      destructive: ['bg-destructive', 'text-destructive-foreground'],
    };
    for (const [variant, classes] of Object.entries(expected)) {
      const markup = html(<Badge variant={variant as 'live'}>{variant}</Badge>);
      expect(classOf(markup), variant).toEqual(expect.arrayContaining(['lichen:rounded-full', ...classes]));
      expect(markup, variant).not.toMatch(FORBIDDEN);
    }
  });

  it('keeps the label in the DOM, so the state is never colour alone', () => {
    expect(html(<Badge variant="live">Needs approval</Badge>)).toMatch(/>Needs approval</);
  });
});

describe('inline field errors', () => {
  it('announces in Alert inside a Lichen scope (legacy rose elsewhere), with an icon', () => {
    const markup = html(<FieldError id="email-error">Enter an email address</FieldError>);
    expect(markup).toMatch(/id="email-error"/);
    expect(markup).toMatch(/role="alert"/);
    expect(classOf(markup)).toEqual(expect.arrayContaining(['text-rose-600', 'lichen:text-destructive']));
    expect(markup).toMatch(/<svg/);
    expect(html(<FieldError id="none" />)).toBe('');
  });

  it('marks invalid fields with a solid Alert border and no glow inside a Lichen scope', () => {
    const classes = invalidFieldClass.split(' ');
    expect(classes).toEqual(expect.arrayContaining(['lichen:border-destructive!', 'lichen:focus:border-destructive!', 'lichen:focus:ring-0!']));
    // Unchanged outside the scope.
    expect(classes).toEqual(expect.arrayContaining(['border-rose-300!', 'focus:border-rose-400!', 'focus:ring-rose-300/30!']));
  });
});

describe('logo', () => {
  it('follows its context: --logo-mark (Lichen in a scope), else the original artwork', () => {
    const markup = html(<AstreloLogo />);
    expect(markup.match(/<path/g)).toHaveLength(1);
    const id = markup.match(/<linearGradient id="([^"]+)"/)![1];
    expect(markup).toContain(`fill:var(--logo-mark, url(#${id}))`);
    expect(markup).toMatch(/aria-hidden="true"/);
  });

  it('gives each instance its own gradient id', () => {
    const markup = html(<><AstreloLogo /><AstreloLogo /></>);
    const ids = [...markup.matchAll(/<linearGradient id="([^"]+)"/g)].map(([, id]) => id);
    expect(new Set(ids).size).toBe(2);
  });

  it('draws one flat colour when pinned: Lichen for dark, graphite for light grounds', () => {
    for (const [tone, hex] of [['lichen', '#b8c65a'], ['graphite', '#0f1215']] as const) {
      const markup = html(<AstreloLogo tone={tone} />);
      expect(markup, tone).not.toMatch(/Gradient|url\(#/);
      expect(markup, tone).toContain(`fill:${hex}`);
    }
  });

  it('pairs the mark with an Ink Plex Bold wordmark at -2.5%', () => {
    const markup = html(<AstreloLockup />);
    expect(markup).toContain('fill:#b8c65a');
    expect(markup).toMatch(/class="font-sans font-bold tracking-\[-0\.025em\] text-ink">Artrelo</);
  });
});

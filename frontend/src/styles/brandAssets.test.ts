import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const fontsCss = readFileSync(new URL('./fonts.css', import.meta.url), 'utf8');
const fontDir = new URL('../assets/fonts/ibm-plex/', import.meta.url);
const provenance = readFileSync(new URL('PROVENANCE.md', fontDir), 'utf8');

const faces = [...fontsCss.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)].map(([, body]) => ({
  family: body.match(/font-family:\s*'([^']+)'/)![1],
  weight: Number(body.match(/font-weight:\s*(\d+)/)![1]),
  style: body.match(/font-style:\s*(\w+)/)![1],
  display: body.match(/font-display:\s*(\w+)/)?.[1],
  src: body.match(/src:\s*([^;]+);/)![1],
}));

describe('IBM Plex @font-face declarations', () => {
  it('declares exactly 400/500/600/700 upright for each family', () => {
    for (const family of ['IBM Plex Sans', 'IBM Plex Mono']) {
      const weights = faces.filter((f) => f.family === family).map((f) => f.weight).sort();
      expect(weights, family).toEqual([400, 500, 600, 700]);
    }
    expect(faces).toHaveLength(8);
    expect(faces.every((f) => f.style === 'normal' && f.display === 'swap')).toBe(true);
  });

  it('loads only bundled, source-relative WOFF2 (no local(), CDN or root URL)', () => {
    for (const face of faces) {
      expect(face.src).toMatch(/^url\('\.\.\/assets\/fonts\/ibm-plex\/IBMPlex(Sans|Mono)-\w+\.woff2'\) format\('woff2'\)$/);
    }
  });
});

describe('pinned font files', () => {
  // Rows of the PROVENANCE.md file table: | file | family | weight | bytes | `sha256` |
  const rows = [...provenance.matchAll(/^\| (IBMPlex\S+\.woff2) \| [^|]+ \| (\d+) \| [\d ]+ \| `([0-9a-f]{64})` \|$/gm)];

  it('lists every declared face in PROVENANCE.md', () => {
    const listed = rows.map(([, file]) => file).sort();
    const declared = faces.map((f) => f.src.match(/(IBMPlex[\w-]+\.woff2)/)![1]).sort();
    expect(listed).toEqual(declared);
  });

  it('ships the files byte-for-byte as pinned (unmodified upstream)', () => {
    for (const [, file, , sha] of rows) {
      const bytes = readFileSync(new URL(file, fontDir));
      expect(bytes.subarray(0, 4).toString('latin1'), file).toBe('wOF2');
      expect(createHash('sha256').update(bytes).digest('hex'), file).toBe(sha);
    }
  });

  it('keeps the OFL notice with the files', () => {
    const license = readFileSync(new URL('LICENSE.txt', fontDir), 'utf8');
    expect(license).toMatch(/^Copyright © 2017 IBM Corp\. with Reserved Font Name "Plex"/);
    expect(license).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
  });
});

describe('app-owned icons in index.html', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const links = [...html.matchAll(/<link rel="(icon|apple-touch-icon)"([^>]*)href="([^"]+)"/g)].map(([, rel, attrs, href]) => ({
    rel,
    href,
    sizes: attrs.match(/sizes="(\d+)x(\d+)"/)?.slice(1).map(Number),
  }));

  it('references only bundled src/assets/brand files, never a root URL shared with marketing', () => {
    expect(links.length).toBeGreaterThanOrEqual(5);
    for (const { href } of links) expect(href).toMatch(/^\/src\/assets\/brand\//);
    expect(html).not.toMatch(/href="\/(favicon|apple-touch-icon|logo)/);
  });

  it('declares 16/32/48 favicons whose PNG headers match their sizes', () => {
    const declared = links.filter((l) => l.sizes);
    expect(declared.map((l) => l.sizes![0]).sort((a, b) => a - b)).toEqual([16, 32, 48, 180]);
    for (const { href, sizes } of declared) {
      const file = new URL(`../..${href}`, import.meta.url);
      expect(existsSync(file), href).toBe(true);
      const png = readFileSync(file);
      expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], href).toEqual(sizes);
    }
  });

  it('sets the browser chrome to ground, without forcing a global dark first paint', () => {
    expect(html).toMatch(/<meta name="theme-color" content="#0f1215"/);
    // :root stays on the legacy light theme until every surface is migrated;
    // a dark first paint would flash before every white page.
    expect(html).not.toMatch(/color-scheme|<style>/);
  });
});

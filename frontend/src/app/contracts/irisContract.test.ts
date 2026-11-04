import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import contractJson from './iris.v2.json';
import fixtures from './iris.v2.fixtures.json';
import { createIrisContract, type IrisContractJson } from './irisContract';

// The frozen hashes from M5_V2_FREEZE.md, with the contract at revision 2.3
// (M5_V2_3_FREEZE.md, Principal d98d060: ExplanationBlock, model_planned
// provenance, no_change_needed / explanation_unavailable / current_value_differs,
// on top of 2.2's pagehide close, process cap and confirm/close order). A copy
// that drifts from the canonical bytes fails here before any parser can
// quietly disagree.
const FROZEN = {
  'iris.v2.json': '1457ee3d12cff1102d0d2651a0b5a2d3313e8c8f0eb2fccedeafe95d54473067',
  'iris.v2.fixtures.json': 'ac262abdc5b53de1c0be20c7bfe935da88682575e353430f9ebe9603e8111d03',
  'validate.cjs': 'edb8e16afe431b7157affbb65da6173570f7779c02e5af3c8539ad6ce601d623',
};

const contract = createIrisContract(contractJson as unknown as IrisContractJson);
const require = createRequire(import.meta.url);
const canonical = require('./validate.cjs') as {
  errors: (schema: unknown, value: unknown, defs: unknown) => string[];
};
type Case = { name: string; schema: string; valid: boolean; value: unknown };
const cases = (fixtures as unknown as { cases: Case[] }).cases;

describe('frontend copy of the frozen Iris v2 contract', () => {
  it('is byte-identical to the canonical artifacts', () => {
    for (const [file, hash] of Object.entries(FROZEN)) {
      // Line endings are normalised to LF first: a Windows checkout may write
      // CRLF, and the frozen artifacts are LF. Any other byte change still fails.
      const bytes = readFileSync(new URL(`./${file}`, import.meta.url)).toString('utf8').replace(/\r\n/g, '\n');
      expect(createHash('sha256').update(bytes, 'utf8').digest('hex'), file).toBe(hash);
    }
  });

  it('has all 76 shared fixture cases', () => {
    expect(cases).toHaveLength(76);
    expect(cases.filter((c) => !c.valid).length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s: matches its valid flag', (_name, c) => {
    const problems = contract.errorsFor(c.schema, c.value);
    expect(problems.length === 0, problems.join('; ')).toBe(c.valid);
  });

  it('agrees with the canonical validate.cjs on every case, error for error', () => {
    const defs = contractJson.$defs as Record<string, unknown>;
    for (const c of cases) {
      expect(contract.errorsFor(c.schema, c.value), c.name).toEqual(canonical.errors(defs[c.schema], c.value, defs));
    }
  });

  it('rejects a payload that check() is asked to trust without leaking it', () => {
    const bad = cases.find((c) => c.name === 'block_arbitrary_html')!;
    expect(() => contract.check('Block', bad.value)).toThrow(/did not match the frozen contract/);
    try {
      contract.check('Block', bad.value);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('<script>');
    }
  });

  it('validates every success envelope fixture against its endpoint', () => {
    const f = fixtures as unknown as Record<string, unknown>;
    const pairs: [string, string, unknown][] = [
      ['POST', '/conversations', f.conversation],
      ['POST', '/conversations/:id/context', f.contextAccount],
      ['POST', '/conversations/:id/turns', f.accepted],
      ['GET', '/turns/:id', f.history],
      ['GET', '/turns/:id', f.help],
      ['GET', '/turns/:id', f.preview],
      ['GET', '/policy-changes/:id', f.applied],
      ['POST', '/policy-changes/:id/discard', f.discarded],
      ['GET', '/policy-changes/:id/impact', f.impact],
      ['GET', '/turns/:id', f.cancelled],
      ['GET', '/turns/:id', f.trimmed],
      ['GET', '/turns/:id', f.onlineExplanation],
      ['GET', '/turns/:id', f.quotaParaphrase],
      ['GET', '/turns/:id', f.currentValueDiffers],
      ['GET', '/turns/:id', f.noChangeNeeded],
      ['GET', '/turns/:id', f.explanationFallback],
    ];
    for (const [method, path, data] of pairs) {
      const ep = contract.endpoint(method as 'GET' | 'POST', path);
      expect(contract.checkEnvelope(ep, { success: true, data }), `${method} ${path}`).toBe(data);
    }
  });

  it('has exactly one valid HttpError fixture per closed error code, at its frozen status', () => {
    const httpErrors = (fixtures as unknown as { httpErrors: { status: number; body: { code: string } }[] }).httpErrors;
    const registry = contractJson.errors as Record<string, number>;
    expect(httpErrors.map((e) => e.body.code).sort()).toEqual(Object.keys(registry).sort());
    for (const e of httpErrors) {
      expect(contract.errorsFor('HttpError', e.body), e.body.code).toEqual([]);
      expect(e.status, e.body.code).toBe(registry[e.body.code]);
    }
  });

  describe('revision 2.3 explanation position (narration.validation)', () => {
    const f = fixtures as unknown as Record<string, { answer: { blocks: { kind: string }[] } }>;
    const turnEp = contract.endpoint('GET', '/turns/:id');
    /** The online explanation turn with its blocks replaced. */
    const withBlocks = (pick: (blocks: { kind: string }[]) => unknown[]) => {
      const turn = structuredClone(f.onlineExplanation);
      turn.answer.blocks = pick(turn.answer.blocks) as { kind: string }[];
      return { success: true, data: turn };
    };

    it('accepts one explanation first, and answers with none', () => {
      expect(f.onlineExplanation.answer.blocks[0].kind).toBe('explanation');
      expect(() => contract.checkEnvelope(turnEp, withBlocks((b) => b))).not.toThrow();
      expect(() => contract.checkEnvelope(turnEp, withBlocks((b) => b.slice(1)))).not.toThrow();
    });

    it('rejects an explanation that is not first', () => {
      const payload = withBlocks(([explanation, facts]) => [facts, explanation]);
      // The shape alone is valid: only the position rule catches it.
      expect(contract.errorsFor('TurnView', payload.data)).toEqual([]);
      expect(() => contract.checkEnvelope(turnEp, payload)).toThrow(/explanation not first/);
    });

    it('rejects a second explanation', () => {
      const payload = withBlocks(([explanation, facts]) => [
        explanation,
        facts,
        { ...(explanation as object), id: 'b_explanation_2' },
      ]);
      expect(contract.errorsFor('TurnView', payload.data)).toEqual([]);
      expect(() => contract.checkEnvelope(turnEp, payload)).toThrow(/more than one explanation/);
      expect(() => contract.check('TurnView', payload.data)).toThrow(/more than one explanation/);
    });
  });
});

import { useMemo, useState } from 'react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { FieldLabel, fieldClass } from '../landlordUi';
import {
  describeSample,
  generateUnits,
  type SequenceKind,
  type UnitPattern,
} from './unitPatterns';

/**
 * The three ways landlords actually describe their buildings, over one engine.
 *
 * "Number range" and "Prefix & suffix" are the same sequence primitive — the
 * first just hides the affix fields, because a landlord numbering units 1 to 24
 * should not have to look at a prefix box to do it. "Floors" runs that same
 * primitive once per floor. Nothing here knows what "PH" or "G01" mean; they
 * fall out of prefixes and padding.
 *
 * The preview is the point. A pattern that silently means something other than
 * what the landlord intended is worth catching before 300 units exist, so the
 * generated scheme is on screen, live, before the review table and long before
 * the database.
 */
type Strategy = 'range' | 'floors' | 'affix';

const STRATEGIES: { id: Strategy; label: string }[] = [
  { id: 'range', label: 'Number range' },
  { id: 'floors', label: 'Floors' },
  { id: 'affix', label: 'Prefix & suffix' },
];

export interface UnitGeneratorFormProps {
  /** Hands the generated identifiers to the shared review pipeline. */
  onGenerated: (units: string[]) => void;
}

export default function UnitGeneratorForm({ onGenerated }: UnitGeneratorFormProps) {
  const [strategy, setStrategy] = useState<Strategy>('range');
  const [range, setRange] = useState({ from: '1', to: '24' });
  const [floors, setFloors] = useState({
    from: '1',
    to: '8',
    perFloor: '6',
    unitFrom: '01',
    separator: '',
  });
  const [affix, setAffix] = useState<{
    prefix: string;
    suffix: string;
    kind: SequenceKind;
    from: string;
    to: string;
  }>({ prefix: 'A', suffix: '', kind: 'number', from: '1', to: '10' });

  const pattern: UnitPattern = useMemo(() => {
    if (strategy === 'floors') {
      return {
        strategy: 'floors',
        prefix: '',
        suffix: '',
        floors: { kind: 'number', from: floors.from, to: floors.to },
        unitsPerFloor: Number(floors.perFloor),
        unitFrom: floors.unitFrom,
        separator: floors.separator,
      };
    }
    if (strategy === 'affix') {
      return {
        strategy: 'sequence',
        prefix: affix.prefix,
        suffix: affix.suffix,
        sequence: { kind: affix.kind, from: affix.from, to: affix.to },
      };
    }
    return {
      strategy: 'sequence',
      prefix: '',
      suffix: '',
      sequence: { kind: 'number', from: range.from, to: range.to },
    };
  }, [strategy, range, floors, affix]);

  const result = useMemo(() => generateUnits(pattern), [pattern]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {STRATEGIES.map((option) => {
          const active = strategy === option.id;
          return (
            <button
              key={option.id}
              type="button"
              data-testid={`generator-strategy-${option.id}`}
              aria-pressed={active}
              onClick={() => setStrategy(option.id)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                active
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {strategy === 'range' ? (
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1.5">
            <FieldLabel>Start</FieldLabel>
            <Input
              data-testid="range-from"
              className="h-10 bg-white"
              inputMode="numeric"
              value={range.from}
              onChange={(event) => setRange({ ...range, from: event.target.value })}
            />
          </label>
          <label className="space-y-1.5">
            <FieldLabel>End</FieldLabel>
            <Input
              data-testid="range-to"
              className="h-10 bg-white"
              inputMode="numeric"
              value={range.to}
              onChange={(event) => setRange({ ...range, to: event.target.value })}
            />
          </label>
        </div>
      ) : null}

      {strategy === 'floors' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5">
              <FieldLabel>First floor</FieldLabel>
              <Input
                data-testid="floors-from"
                className="h-10 bg-white"
                inputMode="numeric"
                value={floors.from}
                onChange={(event) => setFloors({ ...floors, from: event.target.value })}
              />
            </label>
            <label className="space-y-1.5">
              <FieldLabel>Last floor</FieldLabel>
              <Input
                data-testid="floors-to"
                className="h-10 bg-white"
                inputMode="numeric"
                value={floors.to}
                onChange={(event) => setFloors({ ...floors, to: event.target.value })}
              />
            </label>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <label className="space-y-1.5">
              <FieldLabel>Units / floor</FieldLabel>
              <Input
                data-testid="floors-per-floor"
                className="h-10 bg-white"
                inputMode="numeric"
                value={floors.perFloor}
                onChange={(event) => setFloors({ ...floors, perFloor: event.target.value })}
              />
            </label>
            <label className="space-y-1.5">
              <FieldLabel>Units start at</FieldLabel>
              <Input
                data-testid="floors-unit-from"
                className="h-10 bg-white"
                value={floors.unitFrom}
                onChange={(event) => setFloors({ ...floors, unitFrom: event.target.value })}
              />
            </label>
            <label className="space-y-1.5">
              <FieldLabel>Separator</FieldLabel>
              <Input
                data-testid="floors-separator"
                className="h-10 bg-white"
                placeholder="none"
                value={floors.separator}
                onChange={(event) => setFloors({ ...floors, separator: event.target.value })}
              />
            </label>
          </div>
          <p className="text-xs text-slate-400">
            Write the starting unit the way it should appear — <code>01</code> pads to two digits,{' '}
            <code>1</code> does not.
          </p>
        </div>
      ) : null}

      {strategy === 'affix' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5">
              <FieldLabel>Prefix</FieldLabel>
              <Input
                data-testid="affix-prefix"
                className="h-10 bg-white"
                placeholder="e.g. A, Unit-, G"
                value={affix.prefix}
                onChange={(event) => setAffix({ ...affix, prefix: event.target.value })}
              />
            </label>
            <label className="space-y-1.5">
              <FieldLabel>Suffix</FieldLabel>
              <Input
                data-testid="affix-suffix"
                className="h-10 bg-white"
                placeholder="none"
                value={affix.suffix}
                onChange={(event) => setAffix({ ...affix, suffix: event.target.value })}
              />
            </label>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <label className="space-y-1.5">
              <FieldLabel>Sequence</FieldLabel>
              <select
                data-testid="affix-kind"
                className={fieldClass}
                value={affix.kind}
                onChange={(event) =>
                  setAffix({
                    ...affix,
                    kind: event.target.value as SequenceKind,
                    // The other alphabet's bounds are meaningless here.
                    from: event.target.value === 'letter' ? 'A' : '1',
                    to: event.target.value === 'letter' ? 'F' : '10',
                  })
                }
              >
                <option value="number">Numbers</option>
                <option value="letter">Letters</option>
              </select>
            </label>
            <label className="space-y-1.5">
              <FieldLabel>From</FieldLabel>
              <Input
                data-testid="affix-from"
                className="h-10 bg-white"
                value={affix.from}
                onChange={(event) => setAffix({ ...affix, from: event.target.value })}
              />
            </label>
            <label className="space-y-1.5">
              <FieldLabel>To</FieldLabel>
              <Input
                data-testid="affix-to"
                className="h-10 bg-white"
                value={affix.to}
                onChange={(event) => setAffix({ ...affix, to: event.target.value })}
              />
            </label>
          </div>
        </div>
      ) : null}

      <div
        data-testid="generator-preview"
        role="status"
        aria-live="polite"
        className={`rounded-xl border px-3.5 py-3 text-sm ${
          result.error
            ? 'border-rose-200 bg-rose-50 text-rose-700'
            : 'border-slate-200 bg-slate-50/70 text-slate-600'
        }`}
      >
        {result.error ? (
          result.error
        ) : (
          <>
            <div className="font-mono text-slate-900">{describeSample(result.units)}</div>
            <div className="mt-1 text-xs text-slate-500">
              {result.units.length} unit{result.units.length === 1 ? '' : 's'}
            </div>
          </>
        )}
      </div>

      <Button
        data-testid="review-generated-units"
        disabled={result.units.length === 0}
        onClick={() => onGenerated(result.units)}
        className="w-full bg-[#137fec] hover:bg-[#137fec]/90"
      >
        Review {result.units.length} unit{result.units.length === 1 ? '' : 's'}
      </Button>
    </div>
  );
}

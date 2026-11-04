const { id, error, hash, validate } = require('./contract.service');
// Private pointers are never serialized into model input or source peeks.
class Registry {
  constructor(subjectId) { this.subjectId = String(subjectId); this.refs = new Map(); this.facts = new Map(); this.sources = new Map(); this.cursors = new Map(); this.contexts = new Map(); this.nextContext = 0; }
  scoped(scope, turnRef, value) {
    let key = [...this.contexts].find(([, c]) => c.scope === scope && c.turnRef === turnRef)?.[0];
    if (key === undefined) { key = this.nextContext++;this.contexts.set(key, Object.freeze({ scope, turnRef })); }
    // Scope/turn remain immutable, individually checked properties. Store their
    // long identifiers once per context rather than once per fact and source.
    return Object.defineProperties({ ...value, contextId: key }, {
      scope: { get: () => this.contexts.get(key)?.scope },
      turnRef: { get: () => this.contexts.get(key)?.turnRef }
    });
  }
  reference(kind, value, scope) {
    const key = id(kind);
    this.refs.set(key, { kind, value, scope });
    return key;
  }
  resolve(key, kind, scope) {
    const row = this.refs.get(key);
    if (!row || row.kind !== kind || row.scope !== scope) throw error('record_not_found', 'This record is not available.');
    return row.value;
  }
  source(evidence, privatePointer, scope, turnRef) {
    const ref = id('ev');
    const value = validate('Evidence', { ...evidence, ref });
    // Keep one canonical fact value. Source peeks resolve IDs rather than
    // retaining a second serialized copy of every fact in each source.
    this.sources.set(ref, this.scoped(scope, turnRef, { evidence: Object.freeze(value), pointer: privatePointer, factIds: [] }));
    return ref;
  }
  fact({ code, text, evidenceRefs, observedAt }, scope, turnRef, metadata = {}) {
    const fact = validate('Fact', { factId: id('fact'), code, text, evidenceRefs, observedAt });
    this.facts.set(fact.factId, this.scoped(scope, turnRef, { value: Object.freeze(fact), metadata }));
    for (const ev of evidenceRefs) this.sources.get(ev)?.factIds.push(fact.factId);
    return fact;
  }
  factsFor(turnRef) { return [...this.facts.values()].filter(row => row.turnRef === turnRef).map(row => row.value); }
  factsForSource(source) {
    return source.factIds.map(key => this.facts.get(key))
      .filter(row => row && row.scope === source.scope && row.turnRef === source.turnRef).map(row => row.value);
  }
  page(rows, { cursor = null, limit, scope, version }) {
    let offset = 0;
    if (cursor !== null) {
      const entry = this.cursors.get(cursor);
      if (!entry || entry.scope !== scope || entry.version !== version) throw error('invalid_input', 'This page is out of date. Read the current records again.');
      offset = entry.offset;
    }
    const selected = rows.slice(offset, offset + limit);
    let nextCursor = null;
    if (offset + limit < rows.length) {
      nextCursor = id('cursor');
      this.cursors.set(nextCursor, { scope, version, offset: offset + limit });
    }
    return { selected, nextCursor, complete: nextCursor === null };
  }
  dropSegments(scopes) {
    for (const [key, row] of this.refs) if ([...scopes].some(scope => row.scope === scope || row.scope.startsWith(scope + ':'))) this.refs.delete(key);
    for (const [key, row] of this.sources) if (scopes.has(row.scope)) this.sources.delete(key);
    for (const [key, row] of this.facts) if (scopes.has(row.scope)) this.facts.delete(key);
    for (const [key, row] of this.cursors) if ([...scopes].some(scope => row.scope === scope || row.scope.startsWith(scope + ':'))) this.cursors.delete(key);
    for (const [key, row] of this.contexts) if (scopes.has(row.scope)) this.contexts.delete(key);
  }
}
module.exports = { Registry };

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { contract } = require('./contract.service');
const IDS = ['policy-auto-next-vendor', 'policy-max-vendors', 'policy-low-medium-autopilot', 'policy-default-quota'];
const SOURCES = ['services/vendor/autopilotPolicy.service.js', 'services/vendor/vendorOutreachSweeper.service.js',
  'services/vendor/routingSetup.service.js', 'services/vendor/routingDecision.service.js', 'services/quotes/quoteCheckpoint.service.js'];
const PUBLIC_KEYS = ['articleId', 'articleRevision', 'audience', 'status', 'title', 'summary', 'aliases', 'lastVerifiedAt', 'publishedAt', 'publicRouteKind'];
const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function checkBundle(bundle, verification, read = file => fs.readFileSync(path.resolve(__dirname, '../..', file))) {
  if (!bundle || Object.keys(bundle).some(k => !['bundleVersion', 'articles'].includes(k)) || typeof bundle.bundleVersion !== 'string' || bundle.bundleVersion !== verification?.bundleVersion || bundle.articles?.length !== 4) return false;
  const seen = new Set();
  for (const a of bundle.articles) {
    if (!a || Object.keys(a).some(k => !PUBLIC_KEYS.includes(k)) || PUBLIC_KEYS.some(k => !Object.hasOwn(a, k)) || !IDS.includes(a.articleId) || seen.has(a.articleId)) return false;
    seen.add(a.articleId);
    if (a.audience !== 'landlord_client' || a.status !== 'published' || a.publicRouteKind !== 'policy' || !Number.isSafeInteger(a.articleRevision) || a.articleRevision < 1) return false;
    if (typeof a.title !== 'string' || !a.title.length || a.title.length > 120 || typeof a.summary !== 'string' || !a.summary.length || a.summary.length > 800) return false;
    if (!Array.isArray(a.aliases) || a.aliases.length > 12 || a.aliases.some(x => typeof x !== 'string' || x.length > 80)) return false;
    if (![a.lastVerifiedAt, a.publishedAt].every(x => typeof x === 'string' && Number.isFinite(Date.parse(x)))) return false;
  }
  if (verification.backendSources?.length !== SOURCES.length || new Set(verification.backendSources.map(x => x.file)).size !== SOURCES.length) return false;
  for (const row of verification.backendSources) {
    if (!SOURCES.includes(row.file)) return false; // Never read a manifest-supplied arbitrary path.
    if (crypto.createHash('sha256').update(read(row.file)).digest('hex') !== row.sha256) return false;
  }
  return true;
}
function createKnowledge({ bundle, verification, read } = {}) {
  let valid = false;
  try { valid = checkBundle(bundle, verification, read); } catch { /* unavailable, never use unchecked content */ }
  const byId = new Map(valid ? bundle.articles.map(a => [a.articleId, Object.freeze({ ...a })]) : []);
  function search(query, limit = 2) {
    if (!valid) return { status: 'stale', articles: [] };
    const text = normalize(query);
    if (/\b(backend|frontend|source code|api key|password|jwt|database|infrastructure|admin|secret)\b/.test(text)) return { status: 'restricted', articles: [] };
    const tokens = new Set(text.split(' ').filter(x => x.length > 2));
    const scored = [...byId.values()].map(article => {
      const aliases = article.aliases.map(normalize);
      const exact = aliases.some(a => text.includes(a)) ? 20 : 0;
      const words = new Set(normalize(article.title + ' ' + article.aliases.join(' ')).split(' '));
      const score = exact + [...tokens].filter(t => words.has(t)).length;
      return { article, score };
    }).filter(x => x.score >= 2).sort((a, b) => b.score - a.score || a.article.articleId.localeCompare(b.article.articleId));
    return { status: 'ok', articles: scored.slice(0, Math.min(2, Math.max(1, limit))).map(x => x.article), partial: scored.length > limit };
  }
  function get(articleId, revision) {
    const a = byId.get(articleId);
    return a && a.articleRevision === revision ? a : null;
  }
  return { search, get, valid, bundleVersion: valid ? bundle.bundleVersion : null };
}
function loadKnowledge() {
  try {
    return createKnowledge({ bundle: JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../content/landlord-help/demo-policy.v1.json'), 'utf8')),
      verification: JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../contracts/knowledge.verification.json'), 'utf8')) });
  } catch { return createKnowledge(); }
}
module.exports = { loadKnowledge, createKnowledge, checkBundle, IDS, normalize };

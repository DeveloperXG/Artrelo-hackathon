const crypto = require('crypto');
const contract = require('../../contracts/iris.v2.json');
const { assertValid } = require('../../contracts/validate.cjs');
function validate(name, value) {
  if (!Object.hasOwn(contract.$defs, name)) throw new Error('Unknown owned contract shape');
  return assertValid(contract.$defs[name], value, contract.$defs);
}
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const id = prefix => prefix + '_' + crypto.randomUUID();
const error = (code, message, extras = {}) => Object.assign(new Error(message), { code, status: contract.errors[code] || 503, ...extras });
const iso = value => value ? new Date(value).toISOString() : null;
function safeText(value, max = 800) {
  return String(value || '').replace(/https?:\/\/\S+/gi, '[link omitted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[credential omitted]')
    .replace(/\b(?:sk-(?:proj-)?|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{10,}/g, '[credential omitted]')
    .replace(/\b(?:api[_ -]?key|password|secret|token)\s*[:=]\s*["']?[^\s"']+/gi, '[credential omitted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[contact omitted]')
    .replace(/(?:\+?\d[\d ()-]{7,}\d)/g, '[contact omitted]').slice(0, max);
}
module.exports = { contract, validate, hash, id, error, iso, safeText };

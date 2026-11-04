// Small validator for the closed JSON-schema subset used by these owned contracts.
// Schemas are trusted artifacts, never customer-supplied executable validation.
function errors(schema, value, defs, at = '$') {
  if (schema.$ref) {
    const key = schema.$ref.replace('#/$defs/', '');
    if (!Object.hasOwn(defs, key)) throw new Error('Unknown contract schema: ' + key);
    return errors(defs[key], value, defs, at);
  }
  if (schema.anyOf) return schema.anyOf.some(s => errors(s, value, defs, at).length === 0) ? [] : [at + ': no allowed type'];
  if (schema.oneOf) return schema.oneOf.filter(s => errors(s, value, defs, at).length === 0).length === 1 ? [] : [at + ': expected one tagged shape'];
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return [at + ': invalid constant'];
  if (schema.enum && !schema.enum.includes(value)) return [at + ': invalid enum'];
  const type = schema.type;
  if (type === 'null') return value === null ? [] : [at + ': expected null'];
  if (type === 'string') {
    if (typeof value !== 'string') return [at + ': expected string'];
    if (value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? Infinity)) return [at + ': string length'];
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return [at + ': pattern'];
    if (schema.format === 'date-time' && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))) return [at + ': timestamp'];
  } else if (type === 'integer' || type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isSafeInteger(value))) return [at + ': expected safe number'];
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return [at + ': number range'];
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return [at + ': expected boolean'];
  } else if (type === 'array') {
    if (!Array.isArray(value)) return [at + ': expected array'];
    if (value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? Infinity)) return [at + ': array length'];
    return value.flatMap((item, i) => errors(schema.items, item, defs, at + '[' + i + ']'));
  } else if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [at + ': expected object'];
    const result = [];
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) result.push(at + ': missing ' + key);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) {
        if (schema.additionalProperties === false) result.push(at + ': unknown ' + key);
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') result.push(...errors(schema.additionalProperties, value[key], defs, at + '.' + key));
      } else result.push(...errors(schema.properties[key], value[key], defs, at + '.' + key));
    }
    return result;
  }
  return [];
}
function assertValid(schema, value, defs) {
  const list = errors(schema, value, defs);
  if (list.length) throw Object.assign(new Error(list.slice(0, 5).join('; ')), { code: 'invalid_input', status: 400 });
  return value;
}
module.exports = { errors, assertValid };

/**
 * TypeScript port of the frozen contract validator (validate.cjs, sha256
 * edb8e16a…d623). Same closed JSON-schema subset, same error strings, so the
 * contract test can prove the two agree on every shared fixture. Schemas are
 * the trusted frozen artifact, never data from a response.
 */
export type JsonSchema = {
  $ref?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  const?: unknown;
  enum?: unknown[];
  type?: 'null' | 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchema;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
};

export type SchemaDefs = Record<string, JsonSchema>;

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const patternCache = new Map<string, RegExp>();

function pattern(source: string) {
  let compiled = patternCache.get(source);
  if (!compiled) {
    compiled = new RegExp(source);
    patternCache.set(source, compiled);
  }
  return compiled;
}

const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export function schemaErrors(schema: JsonSchema, value: unknown, defs: SchemaDefs, at = '$'): string[] {
  if (schema.$ref) {
    const key = schema.$ref.replace('#/$defs/', '');
    if (!has(defs, key)) throw new Error('Unknown contract schema: ' + key);
    return schemaErrors(defs[key], value, defs, at);
  }
  if (schema.anyOf) {
    return schema.anyOf.some((s) => schemaErrors(s, value, defs, at).length === 0) ? [] : [at + ': no allowed type'];
  }
  if (schema.oneOf) {
    return schema.oneOf.filter((s) => schemaErrors(s, value, defs, at).length === 0).length === 1
      ? []
      : [at + ': expected one tagged shape'];
  }
  if (has(schema, 'const') && value !== schema.const) return [at + ': invalid constant'];
  if (schema.enum && !schema.enum.includes(value)) return [at + ': invalid enum'];
  const type = schema.type;
  if (type === 'null') return value === null ? [] : [at + ': expected null'];
  if (type === 'string') {
    if (typeof value !== 'string') return [at + ': expected string'];
    if (value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? Infinity)) {
      return [at + ': string length'];
    }
    if (schema.pattern && !pattern(schema.pattern).test(value)) return [at + ': pattern'];
    if (schema.format === 'date-time' && (!TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value)))) {
      return [at + ': timestamp'];
    }
  } else if (type === 'integer' || type === 'number') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (type === 'integer' && !Number.isSafeInteger(value))
    ) {
      return [at + ': expected safe number'];
    }
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return [at + ': number range'];
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return [at + ': expected boolean'];
  } else if (type === 'array') {
    if (!Array.isArray(value)) return [at + ': expected array'];
    if (value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? Infinity)) {
      return [at + ': array length'];
    }
    return value.flatMap((item, i) => schemaErrors(schema.items ?? {}, item, defs, at + '[' + i + ']'));
  } else if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [at + ': expected object'];
    const record = value as Record<string, unknown>;
    const result: string[] = [];
    for (const key of schema.required || []) if (!has(record, key)) result.push(at + ': missing ' + key);
    for (const key of Object.keys(record)) {
      if (!has(schema.properties || {}, key)) {
        if (schema.additionalProperties === false) result.push(at + ': unknown ' + key);
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          result.push(...schemaErrors(schema.additionalProperties, record[key], defs, at + '.' + key));
        }
      } else {
        result.push(...schemaErrors(schema.properties![key], record[key], defs, at + '.' + key));
      }
    }
    return result;
  }
  return [];
}

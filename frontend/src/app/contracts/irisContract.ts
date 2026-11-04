import { schemaErrors, type JsonSchema, type SchemaDefs } from './irisValidate';

/**
 * The frozen Iris v2 contract, read from the frontend-owned copy of the
 * canonical artifact (contracts/iris.v2.json). It is loaded on first use so the
 * ~150 KB schema stays out of the shell chunk until a landlord opens Iris.
 */
export interface IrisEndpoint {
  method: 'GET' | 'POST';
  path: string;
  input: JsonSchema | null;
  output: JsonSchema;
  status: number;
  envelope: JsonSchema;
}

export interface IrisContractJson {
  contractVersion: number;
  basePath: string;
  $defs: SchemaDefs;
  endpoints: IrisEndpoint[];
  errors: Record<string, number>;
  limits: Record<string, number>;
  navigation: Record<string, unknown>;
  transport: { pollingMs: [number, number] };
}

export class IrisContractViolation extends Error {
  readonly problems: string[];
  constructor(what: string, problems: string[]) {
    // Paths only (e.g. "$.answer.blocks[0]: unknown html"); never the payload,
    // which can hold a confirmation token.
    super(`Iris ${what} did not match the frozen contract: ${problems.slice(0, 3).join('; ')}`);
    this.problems = problems;
  }
}

export interface IrisContract {
  json: IrisContractJson;
  errorsFor(defName: string, value: unknown): string[];
  /** Throws IrisContractViolation unless `value` is exactly a `defName`. */
  check<T>(defName: string, value: unknown): T;
  endpoint(method: IrisEndpoint['method'], path: string): IrisEndpoint;
  /** Validates a `{success:true,data}` envelope for an endpoint and returns data. */
  checkEnvelope<T>(endpoint: IrisEndpoint, payload: unknown): T;
  checkInput(endpoint: IrisEndpoint, body: unknown): void;
}

/**
 * Rules the schema subset cannot state (contract narration.validation): an
 * answer carries at most one explanation, and only as its first block, so the
 * model's prose always reads as an introduction to the records, never mixed in
 * among them. Answer.blocks is the only place a Block can appear.
 */
export function semanticErrors(value: unknown, at = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => semanticErrors(item, `${at}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  if (Array.isArray(record.blocks)) {
    const positions = record.blocks.flatMap((block, i) =>
      block && typeof block === 'object' && (block as { kind?: unknown }).kind === 'explanation' ? [i] : []
    );
    if (positions.length > 1) problems.push(`${at}.blocks: more than one explanation`);
    else if (positions.length === 1 && positions[0] !== 0) problems.push(`${at}.blocks[${positions[0]}]: explanation not first`);
  }
  for (const [key, child] of Object.entries(record)) problems.push(...semanticErrors(child, `${at}.${key}`));
  return problems;
}

export function createIrisContract(json: IrisContractJson): IrisContract {
  const defs = json.$defs;
  const endpoint = (method: IrisEndpoint['method'], path: string) => {
    const found = json.endpoints.find((e) => e.method === method && e.path === path);
    if (!found) throw new Error(`No frozen Iris endpoint ${method} ${path}`);
    return found;
  };
  return {
    json,
    errorsFor: (defName, value) => {
      const schema = defs[defName];
      if (!schema) throw new Error('Unknown contract schema: ' + defName);
      return schemaErrors(schema, value, defs);
    },
    check<T>(defName: string, value: unknown) {
      const problems = schemaErrors({ $ref: `#/$defs/${defName}` }, value, defs);
      if (!problems.length) problems.push(...semanticErrors(value));
      if (problems.length) throw new IrisContractViolation(defName, problems);
      return value as T;
    },
    endpoint,
    checkEnvelope<T>(ep: IrisEndpoint, payload: unknown) {
      const problems = schemaErrors(ep.envelope, payload, defs);
      if (!problems.length) problems.push(...semanticErrors(payload));
      if (problems.length) throw new IrisContractViolation(`${ep.method} ${ep.path} response`, problems);
      return (payload as { data: T }).data;
    },
    checkInput(ep: IrisEndpoint, body: unknown) {
      if (!ep.input) return;
      const problems = schemaErrors(ep.input, body, defs);
      if (problems.length) throw new IrisContractViolation(`${ep.method} ${ep.path} request`, problems);
    },
  };
}

let loading: Promise<IrisContract> | null = null;

export function loadIrisContract(): Promise<IrisContract> {
  if (!loading) {
    loading = import('./iris.v2.json').then((mod) =>
      createIrisContract(((mod as { default?: unknown }).default ?? mod) as IrisContractJson)
    );
    // A failed chunk load must be retryable rather than cached forever.
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

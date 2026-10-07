/**
 * How a feature adds an endpoint to the API without touching the server itself: it returns a list of `Route`s, and
 * `createApi` serves them (rate limited like the other market endpoints, sold by session like them, and described in
 * `/v1/openapi.json` from `doc`). A handler returns the JSON body, or throws `RouteError` for a refused request.
 */

export class RouteError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** A response that is not JSON (a CSV download, say): return one of these from a handler. */
export class Raw {
  body: string;
  contentType: string;
  /** Offered as the download's file name. */
  filename?: string;
  constructor(body: string, contentType: string, filename?: string) {
    this.body = body;
    this.contentType = contentType;
    this.filename = filename;
  }
}

/** The OpenAPI description of one endpoint. */
export interface RouteDoc {
  summary: string;
  description?: string;
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, { description: string }>;
}

export interface Route {
  method: "GET" | "POST";
  /** For example "/v1/health". */
  path: string;
  /** Rate limited for callers without a key (the default). Set false for something cheap. */
  limited?: boolean;
  /** Only for QMax's own API key (`x-api-key`, the server's API_KEY): everyone else gets a 401. Left out of the public OpenAPI file. */
  keyed?: boolean;
  /** Its own per-IP limit (calls a minute) instead of the shared free quota, for a cheap endpoint the app calls often. Use with `limited: false`. */
  rate?: { perMin: number };
  doc: RouteDoc;
  /** `query` is the URL's search parameters; `body` the parsed JSON of a POST. Returns the JSON response (or a `Raw`). */
  handler(req: { query: URLSearchParams; body: unknown }): Promise<unknown> | unknown;
}

/** Reads a query parameter that must be one of a few values, falling back to a default. Throws a 400 otherwise. */
export function oneOf<T extends string>(query: URLSearchParams, name: string, allowed: readonly T[], fallback: T): T {
  const v = query.get(name);
  if (v === null || v === "") return fallback;
  if (!(allowed as readonly string[]).includes(v)) throw new RouteError(400, `${name} must be one of ${allowed.join(", ")}`);
  return v as T;
}

/**
 * A number written the plain way: digits with an optional sign and fraction. JavaScript's own `Number()` also takes "0x10", "1e3", " ", "Infinity" and
 * the like, so what a person (or a script) meant by a quantity or a limit would depend on a quirk; here those are not numbers (NaN), and callers refuse them.
 * `scientific` also takes "1e9", for the few parameters (sizes in QU) where writing it that way is natural.
 */
export function plainNumber(v: unknown, scientific = false): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  return (scientific ? /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/ : /^[+-]?\d+(\.\d+)?$/).test(v.trim()) ? Number(v) : NaN;
}

/** Reads a required, non-empty query parameter. Throws a 400 if it is missing. */
export function required(query: URLSearchParams, name: string): string {
  const v = (query.get(name) ?? "").trim();
  if (!v) throw new RouteError(400, `${name} is required`);
  return v;
}

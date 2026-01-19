
export interface Env {
  CLARITY_ENDPOINT?: string;         // Required: The endpoint URL to send logs to

  BATCH_MS?: string;                 // default: "20000"
  BATCH_MAX_REQUESTS?: string;       // default: "200"

  BACKOFF_BASE_MS?: string;          // default: "2000"
  BACKOFF_MAX_MS?: string;           // default: "60000"
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 1) Proxy request to origin
    const response = await fetch(request);

    // 2) Log asynchronously (no impact on response latency)
    ctx.waitUntil(logAndBatch(request, response, env, ctx));

    // 3) Return origin response
    return response;
  }
};

// ===== Config (with sensible defaults, env-overridable) =====
const defaults = {
  BATCH_MS: 20000,
  BATCH_MAX_REQUESTS: 200,
  BACKOFF_BASE_MS: 2000,
  BACKOFF_MAX_MS: 60000
};

function cfg(env: Env) {
  // CLARITY_ENDPOINT must be provided via environment variable
  const clarityEndpoint = env.CLARITY_ENDPOINT?.trim() ?? "";

  const batchMs = toNumber(env.BATCH_MS, defaults.BATCH_MS);
  const batchMax = toNumber(env.BATCH_MAX_REQUESTS, defaults.BATCH_MAX_REQUESTS);
  const backoffBase = toNumber(env.BACKOFF_BASE_MS, defaults.BACKOFF_BASE_MS);
  const backoffMax = toNumber(env.BACKOFF_MAX_MS, defaults.BACKOFF_MAX_MS);

  return { clarityEndpoint, batchMs, batchMax, backoffBase, backoffMax };
}

function toNumber(v: string | undefined, fallback: number): number {
  const n = v != null ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// ===== State (per isolate) =====
let batch: any[] = [];
let flushScheduled = false;
let backoffUntil = 0; // epoch millis
let backoffMs = 0;

// ===== Logging + batching =====
async function logAndBatch(
  request: Request,
  response: Response,
  env: Env,
  ctx: ExecutionContext
) {
  batch.push(buildLogObject(request, response));

  const { batchMax } = cfg(env);

  // Flush immediately if max size reached
  if (batch.length >= batchMax) {
    ctx.waitUntil(flush(env));
    return;
  }

  // Ensure only one timer runs
  if (!flushScheduled) {
    flushScheduled = true;
    ctx.waitUntil(scheduleFlush(env));
  }
}

function buildLogObject(request: Request, response: Response) {
  const u = new URL(request.url);

  // Cloudflare provides extra metadata on request.cf when available
  const cf: any = (request as any).cf || {};

  const protocol =
    (u.protocol || "").replace(":", "") ||
    (cf.httpProtocol ? "https" : "");

  return {
    EdgeStartTimestamp: new Date().toISOString(),

    ClientIP:
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-real-ip") ||
      "",

    ClientCountry: cf.country || "",
    ClientCity: cf.city || "",

    ClientRequestScheme: protocol,
    ClientRequestHost: request.headers.get("host") || u.host,
    ClientRequestURI: u.pathname + (u.search || ""),
    ClientRequestMethod: request.method,
    ClientRequestUserAgent: request.headers.get("user-agent") || "",
    ClientRequestReferer: request.headers.get("referer") || "",

    EdgeResponseStatus: Number(response.status) || 0
  };
}

async function scheduleFlush(env: Env) {
  const { batchMs } = cfg(env);
  await sleep(batchMs);
  flushScheduled = false;

  if (batch.length > 0) {
    await flush(env);
  }
}

async function flush(env: Env) {
  // Respect backoff window
  const now = Date.now();
  if (now < backoffUntil) return;

  const { clarityEndpoint, backoffBase, backoffMax } = cfg(env);

  // Swap out the current batch for an empty one
  const toSend = batch;
  batch = [];

  if (toSend.length === 0) return;

  // Newline-delimited JSON (JSON Lines)
  const body = toSend.map((e) => JSON.stringify(e)).join("\n");

  const req: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "text/plain"
    },
    body
  };

  try {
    const resp = await fetch(clarityEndpoint, req);

    if (resp.status === 429 || resp.status === 403) {
      // Exponential backoff with jitter
      backoffMs = backoffMs ? Math.min(backoffMs * 2, backoffMax) : backoffBase;
      const jitter = Math.floor(Math.random() * 500);
      backoffUntil = Date.now() + backoffMs + jitter;

      // Requeue (best-effort). Consider a max buffer cap if sink is down.
      batch = toSend.concat(batch);
    } else {
      backoffMs = 0;
      backoffUntil = 0;
    }
  } catch {
    // Network error: backoff + requeue
    backoffMs = backoffMs ? Math.min(backoffMs * 2, backoffMax) : backoffBase;
    const jitter = Math.floor(Math.random() * 500);
    backoffUntil = Date.now() + backoffMs + jitter;
    batch = toSend.concat(batch);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

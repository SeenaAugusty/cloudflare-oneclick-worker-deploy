
export interface Env {
  CLARITY_ENDPOINT?: string;
  BATCH_MS?: string;
  BATCH_MAX_REQUESTS?: string;
  BACKOFF_BASE_MS?: string;
  BACKOFF_MAX_MS?: string;
}

type LogRecord = Record<string, unknown>;

const DEFAULTS = {
  BATCH_MS: 20000,
  BATCH_MAX_REQUESTS: 200,
  BACKOFF_BASE_MS: 2000,
  BACKOFF_MAX_MS: 60000,
};

const STORAGE_KEYS = {
  PENDING: "pending",
  BACKOFF_MS: "backoffMs",
  BACKOFF_UNTIL: "backoffUntil",
} as const;

export class LogDO {
  private batch: LogRecord[] = [];
  private flushScheduled = false;
  private flushInProgress = false;

  private backoffMs = 0;
  private backoffUntil = 0;

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/append") {
      const body = await request.json<LogRecord>();
      await this.append(body);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.pathname === "/flush") {
      await this.flush();
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && url.pathname === "/__health") {
      return new Response("ok", { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    this.flushScheduled = false;
    await this.flush();
  }

  private async loadStateOnceIfNeeded() {
    if (this.batch.length > 0 || this.backoffUntil !== 0 || this.backoffMs !== 0) return;
    const [pending, boMs, boUntil] = await Promise.all([
      this.state.storage.get<LogRecord[]>(STORAGE_KEYS.PENDING),
      this.state.storage.get<number>(STORAGE_KEYS.BACKOFF_MS),
      this.state.storage.get<number>(STORAGE_KEYS.BACKOFF_UNTIL),
    ]);
    this.batch = Array.isArray(pending) ? pending : [];
    this.backoffMs = typeof boMs === 'number' ? boMs : 0;
    this.backoffUntil = typeof boUntil === 'number' ? boUntil : 0;
  }

  private cfg() {
    const toN = (v: string | undefined, d: number) => {
      const p = v ? parseInt(v, 10) : NaN;
      return Number.isFinite(p) ? p : d;
    };
    const batchMs = toN(this.env.BATCH_MS, DEFAULTS.BATCH_MS);
    const batchMax = toN(this.env.BATCH_MAX_REQUESTS, DEFAULTS.BATCH_MAX_REQUESTS);
    const backoffBase = toN(this.env.BACKOFF_BASE_MS, DEFAULTS.BACKOFF_BASE_MS);
    const backoffMax = toN(this.env.BACKOFF_MAX_MS, DEFAULTS.BACKOFF_MAX_MS);

    const endpoint = (this.env.CLARITY_ENDPOINT || "").trim();
    if (!endpoint) throw new Error("CLARITY_ENDPOINT is not set");
    return { endpoint, batchMs, batchMax, backoffBase, backoffMax };
  }

  private async append(rec: LogRecord) {
    await this.loadStateOnceIfNeeded();

    this.batch.push(rec);
    await this.state.storage.put(STORAGE_KEYS.PENDING, this.batch);

    const { batchMs, batchMax } = this.cfg();

    if (this.batch.length >= batchMax) {
      await this.flush();
      return;
    }

    if (!this.flushScheduled) {
      this.flushScheduled = true;
      await this.state.storage.setAlarm(Date.now() + batchMs);
    }
  }

  private async flush() {
    await this.loadStateOnceIfNeeded();

    const now = Date.now();
    if (now < this.backoffUntil) return;
    if (this.flushInProgress) return;

    const { endpoint, backoffBase, backoffMax } = this.cfg();

    const toSend = this.batch;
    if (toSend.length === 0) return;

    this.flushInProgress = true;

    const body = toSend.map((e) => JSON.stringify(e)).join("\n");

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
        redirect: "manual",
      });

      if (resp.status === 429 || resp.status === 403) {
        this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, backoffMax) : backoffBase;
        const jitter = Math.floor(Math.random() * 500);
        this.backoffUntil = Date.now() + this.backoffMs + jitter;

        this.batch = toSend.concat(this.batch);
        await this.state.storage.put(STORAGE_KEYS.PENDING, this.batch);
        await this.state.storage.put(STORAGE_KEYS.BACKOFF_MS, this.backoffMs);
        await this.state.storage.put(STORAGE_KEYS.BACKOFF_UNTIL, this.backoffUntil);
        await this.state.storage.setAlarm(this.backoffUntil);
      } else {
        this.batch = [];
        this.backoffMs = 0;
        this.backoffUntil = 0;
        await this.state.storage.delete(STORAGE_KEYS.PENDING);
        await this.state.storage.delete(STORAGE_KEYS.BACKOFF_MS);
        await this.state.storage.delete(STORAGE_KEYS.BACKOFF_UNTIL);
      }
    } catch {
      this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, backoffMax) : backoffBase;
      const jitter = Math.floor(Math.random() * 500);
      this.backoffUntil = Date.now() + this.backoffMs + jitter;

      await this.state.storage.put(STORAGE_KEYS.PENDING, this.batch);
      await this.state.storage.put(STORAGE_KEYS.BACKOFF_MS, this.backoffMs);
      await this.state.storage.put(STORAGE_KEYS.BACKOFF_UNTIL, this.backoffUntil);
      await this.state.storage.setAlarm(this.backoffUntil);
    } finally {
      this.flushInProgress = false;
    }
  }
}

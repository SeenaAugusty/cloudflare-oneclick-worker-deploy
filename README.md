
# Cloudflare Worker with Durable Object (DO) Batching

This is a single-worker repo that uses a **Durable Object** to batch log events and periodically
flush them as NDJSON to a configurable `CLARITY_ENDPOINT`. It replaces any in-memory batching in the
request handler with reliable DO state + alarms.

## Deploy (Cloudflare UI or Wrangler)

1. In the dashboard, set **Settings → Variables** on the Worker:
   - `CLARITY_ENDPOINT` = `https://ai.clarity.ms/collect/cloudflare/<your_project_id>`
   - Optional tuning:
     - `BATCH_MS` (default `20000`)
     - `BATCH_MAX_REQUESTS` (default `200`)
     - `BACKOFF_BASE_MS` (default `2000`)
     - `BACKOFF_MAX_MS` (default `60000`)

2. First deploy will apply the Durable Object migration (`v1-add-log-do`).

3. Exercise the Worker endpoint to generate events. The DO accumulates records and flushes on timer
   or when `BATCH_MAX_REQUESTS` is reached. On 429/403 or network errors, it backs off with jitter
   and retries via a reliable **alarm**.

## Project Structure
```
./
├─ wrangler.toml
├─ package.json
├─ tsconfig.json
└─ src/
   ├─ index.ts        # request handler (proxy + append to DO)
   └─ do_logger.ts    # Durable Object class (state, batching, alarms, flush)
```
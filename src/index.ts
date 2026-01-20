
// Ensure the Durable Object class is included in the bundle
export { LogDO } from "./do_logger";
import type { Env as DOEnv } from "./do_logger";

export interface Env extends DOEnv {
  LOG_DO: DurableObjectNamespace; // bound in wrangler.toml
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 1) Proxy to origin 
    const response = await fetch(request);

    // 2) Build a compact log record
    const u = new URL(request.url);
    const cf: any = (request as any).cf || {};
    const protocol = (u.protocol || "").replace(":", "") || (cf.httpProtocol ? "https" : "");

    const logRecord = {
      EdgeStartTimestamp: new Date().toISOString(),
      ClientIP: request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "",
      ClientCountry: cf.country || "",
      ClientCity: cf.city || "",
      ClientRequestScheme: protocol,
      ClientRequestHost: request.headers.get("host") || u.host,
      ClientRequestURI: u.pathname + (u.search || ""),
      ClientRequestMethod: request.method,
      ClientRequestUserAgent: request.headers.get("user-agent") || "",
      ClientRequestReferer: request.headers.get("referer") || "",
      EdgeResponseStatus: Number(response.status) || 0,
    };

    // 3) Route to a DO instance (single global instance; or partition by host/project)
    const id = env.LOG_DO.idFromName("global");
    const stub = env.LOG_DO.get(id);

    // 4) Append asynchronously; does not affect response latency
    ctx.waitUntil(
      stub.fetch("https://log.do/append", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(logRecord),
      })
    );

    return response;
  },
};

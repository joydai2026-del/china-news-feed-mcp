import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer, paidTools, type PaidTool } from "../src/server.js";
import { paidNote, requirements, verifyPayment, type PayEnv } from "./x402.js";

interface KVNamespace {
  get(key: string, type: "json"): Promise<unknown>;
}

interface Env extends PayEnv {
  FEED: KVNamespace;
  MAX_ITEMS?: string;
}

const storeUrl = "https://apify.com/china.unofficial/china-news-feed";
const sampleFields = ["id", "source_id", "source", "title", "headline_en", "headline_original", "source_name", "source_type", "url", "link", "summary", "published", "published_at", "fetched_at", "kind", "rank", "language"];
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "mcp-session-id, X-PAYMENT-RESPONSE",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withCors(response: Response): Response {
  const result = new Response(response.body, response);
  for (const [key, value] of Object.entries(corsHeaders)) result.headers.set(key, value);
  return result;
}

function json(body: unknown, status = 200): Response {
  return withCors(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

// Header first, then bearer auth, then Smithery-style query config. Never log the result.
function tokenFrom(request: Request, url: URL): string | undefined {
  const header = request.headers.get("x-apify-token")?.trim();
  if (header) return header;
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;
  const query = url.searchParams.get("apifyToken")?.trim();
  if (query) return query;
  const config = url.searchParams.get("config");
  if (config) {
    try {
      const parsed: unknown = JSON.parse(atob(config));
      if (isObject(parsed) && typeof parsed.apifyToken === "string" && parsed.apifyToken.trim()) return parsed.apifyToken.trim();
    } catch {
      // Ignore malformed config.
    }
  }
  return undefined;
}

async function readSample(env: Env): Promise<unknown[]> {
  const feed = await env.FEED.get("feed_en", "json");
  const items = Array.isArray(feed) ? feed : isObject(feed) && Array.isArray(feed.items) ? feed.items : [];
  const withEn = items.filter(i => isObject(i) && typeof i.headline_en === "string" && i.headline_en.trim() !== "");
  return (withEn.length ? withEn : items).slice(0, 3).filter(isObject).map(item => Object.fromEntries(sampleFields.filter(key => item[key] !== undefined).map(key => [key, item[key]])));
}

const itemsFrom = (value: unknown): unknown[] => Array.isArray(value) ? value : isObject(value) && Array.isArray(value.items) ? value.items : [];

const maxItems = (env: Env) => Number.isSafeInteger(Number(env.MAX_ITEMS)) && Number(env.MAX_ITEMS) > 0 ? Number(env.MAX_ITEMS) : 20;

// Paid rows come from the same KV feed the REST x402 Worker sells, capped at MAX_ITEMS like ownly-cmf-x402.
async function readPaid(env: Env, tool: PaidTool, args: Record<string, unknown>): Promise<unknown[]> {
  const key = tool === "get_hot_lists" ? "hot" : tool === "get_deletions" ? "deletions" : args.language === "zh" ? "feed_zh" : "feed_en";
  const max = maxItems(env);
  const limit = Math.min(typeof args.maxItems === "number" ? args.maxItems : max, max);
  const query = typeof args.query === "string" ? args.query.toLowerCase() : undefined;
  return itemsFrom(await env.FEED.get(key, "json")).filter(isObject).filter(row => tool !== "get_china_news"
    || (row.kind === "news" && (!query || [row.headline_en, row.headline_original].some(h => typeof h === "string" && h.toLowerCase().includes(query))))).slice(0, limit);
}

// The paid tools/call in a POST body, if any. initialize, tools/list, get_sample and other methods stay free.
async function paidCall(request: Request): Promise<{ tool: PaidTool; args: Record<string, unknown> } | "batch" | undefined> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return undefined; // Let the MCP transport report the parse error.
  }
  const calls = (Array.isArray(body) ? body : [body]).filter(isObject).flatMap(message => {
    const params = isObject(message.params) ? message.params : {};
    return message.method === "tools/call" && paidTools.includes(params.name as PaidTool)
      ? [{ tool: params.name as PaidTool, args: isObject(params.arguments) ? params.arguments : {} }] : [];
  });
  return calls.length > 1 ? "batch" : calls[0];
}

// Settle only when the paid tool actually returned rows (HTTP OK, no JSON-RPC error, no tool error).
async function succeeded(response: Response): Promise<boolean> {
  if (response.status >= 400) return false;
  try {
    const body: unknown = await response.clone().json();
    return isObject(body) && !body.error && !(isObject(body.result) && body.result.isError === true);
  } catch {
    return false;
  }
}

async function handleMcp(request: Request, env: Env, token: string | undefined, paid = false): Promise<Response> {
  const server = createServer({ getToken: () => token, getSample: () => readSample(env), paidNote: paidNote(env, maxItems(env)), ...(paid ? { getPaidRows: (tool: PaidTool, args: Record<string, unknown>) => readPaid(env, tool, args) } : {}) });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return withCors(await transport.handleRequest(request));
  } catch {
    return json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ name: "china-news-feed-mcp", mcp: "/mcp", store: storeUrl });
    }
    if (url.pathname === "/mcp") {
      if (!["GET", "POST", "DELETE"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
      const token = tokenFrom(request, url);
      // Bring-your-own Apify token: unchanged path, no x402.
      const call = !token && request.method === "POST" ? await paidCall(request) : undefined;
      if (!call) return handleMcp(request, env, token);
      if (call === "batch") return json({ jsonrpc: "2.0", error: { code: -32600, message: "Send one paid tool call per request" }, id: null }, 400);
      const terms = requirements(env, `${url.origin}${url.pathname}`, call.tool, call.args);
      if ("status" in terms) return json(terms.body, terms.status);
      const verified = await verifyPayment(env, request.headers.get("x-payment"), terms.accepts);
      if ("status" in verified) return json(verified.body, verified.status);
      const response = await handleMcp(request, env, undefined, true);
      if (!(await succeeded(response))) return response;
      const settled = await verified.settle();
      if (!settled.ok) return json(settled.body, settled.status);
      response.headers.set("X-PAYMENT-RESPONSE", settled.header);
      return response;
    }
    return json({ error: "Not found" }, 404);
  },
};

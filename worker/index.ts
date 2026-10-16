import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "../src/server.js";

interface KVNamespace {
  get(key: string, type: "json"): Promise<unknown>;
}

interface Env {
  FEED: KVNamespace;
}

const storeUrl = "https://apify.com/china.unofficial/china-news-feed";
const sampleFields = ["id", "source_id", "source", "title", "headline_en", "headline_original", "source_name", "source_type", "url", "link", "summary", "published", "published_at", "fetched_at", "kind", "rank", "language"];
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "mcp-session-id",
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
      const server = createServer({ getToken: () => token, getSample: () => readSample(env) });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await server.connect(transport);
        return withCors(await transport.handleRequest(request));
      } catch {
        return json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }, 500);
      }
    }
    return json({ error: "Not found" }, 404);
  },
};

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const platforms = ["weibo", "baidu", "zhihu", "toutiao", "bilibili", "douyin", "kuaishou"] as const;
export const sourceTypes = ["State media", "Party-gov", "Commercial platform", "Overseas independent", "Dissident", "Censorship tracker"] as const;
type Row = Record<string, unknown>;
type Language = "zh" | "en" | "both";
const language = z.enum(["zh", "en", "both"]).default("both");
const maxItems = z.number().int().min(1).max(500).default(50).describe("Actor cap on billed dataset rows, before client-side filtering.");
const platformInput = z.array(z.enum(platforms)).default([...platforms]);

function isObject(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Preserve false and zero while removing empty values recursively.
function compact(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return undefined;
  if (Array.isArray(value)) {
    const result = value.map(compact).filter(v => v !== undefined);
    return result.length ? result : undefined;
  }
  if (isObject(value)) {
    const result = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compact(v)]).filter(([, v]) => v !== undefined));
    return Object.keys(result).length ? result : undefined;
  }
  return value;
}

function project(row: Row, lang: Language): unknown {
  const result: Row = {};
  for (const key of ["kind", "source_id", "source_name", "source_type", "url", "published", "rank", "heat", "topic_id", "peak_rank", "first_seen", "last_seen"]) result[key] = row[key];
  if (lang !== "zh") result.headline_en = row.headline_en;
  if (lang !== "en") result.headline_original = row.headline_original;
  if (isObject(row.censorship)) {
    const flag = row.censorship;
    result.censorship = Object.fromEntries(["status", "label", "label_zh", "tier", "provisional", "censored_at", "platforms_affected", "survived_on", "evidence", "why", "rank", "peak_rank", "first_seen", "last_seen"].map(key => [key, flag[key]]));
    const timing = isObject(flag.censored_at) ? flag.censored_at : {};
    for (const key of ["rank", "peak_rank", "first_seen", "last_seen"]) result[key] ??= flag[key] ?? timing[key];
  }
  return compact(result);
}

class ToolError extends Error {}

async function runActor(input: Row): Promise<Row[]> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new ToolError("APIFY_TOKEN is missing. Set it to your own Apify API token before calling this tool.");
  const url = new URL("https://api.apify.com/v2/acts/china.unofficial~china-news-feed/run-sync-get-dataset-items");
  url.searchParams.set("token", token);
  url.searchParams.set("clean", "1");
  const signal = AbortSignal.timeout(300_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, emitOnlyNew: false, snapshotCount: 1 }),
      signal,
    });
    // Never relay remote error bodies or fetch errors: they can contain the token URL.
    if (!response.ok) throw new ToolError(`Apify request failed (HTTP ${response.status}). Check your token, account balance, and actor availability.`);
    const data: unknown = await response.json();
    if (!Array.isArray(data) || !data.every(isObject)) throw new ToolError("Apify returned an unexpected dataset response.");
    return data;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(signal.aborted
      ? "Apify request timed out after 300 seconds. The actor may still be running and billing rows; check your Apify account before retrying."
      : "Could not fetch the Apify dataset. Check network access and your Apify account before retrying.");
  }
}

async function execute(input: Row, lang: Language, filter: (row: Row) => boolean) {
  try {
    const dataset = await runActor(input);
    const rows = dataset.filter(filter).map(row => project(row, lang));
    return { content: [{ type: "text" as const, text: JSON.stringify({ count: rows.length, rows, note: `billed rows: ${dataset.length} at $8/1000` }) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: error instanceof ToolError ? error.message : "The tool could not process the dataset." }] };
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "china-news-feed-mcp", version: "1.0.0" });
  server.registerTool("get_china_news", {
    description: "Fetch China news. Costs $8 per 1,000 dataset rows on your Apify account. Query and language are applied locally after billing.",
    inputSchema: { language, maxItems, query: z.string().optional(), sources: z.array(z.string()).optional(), sourceTypes: z.array(z.enum(sourceTypes)).optional() },
  }, async args => execute({ maxItems: args.maxItems, hotLists: [], ...(args.sources !== undefined ? { newsSources: args.sources } : {}), ...(args.sourceTypes !== undefined ? { sourceTypes: args.sourceTypes } : {}) }, args.language,
    row => row.kind === "news" && (args.query === undefined || [row.headline_en, row.headline_original].some(h => typeof h === "string" && h.toLowerCase().includes(args.query!.toLowerCase())))));
  server.registerTool("get_hot_lists", {
    description: "Fetch Chinese platform hot lists. Costs $8 per 1,000 dataset rows on your own Apify account.",
    inputSchema: { platforms: platformInput, maxRank: z.number().int().min(5).max(50).default(50), maxItems, language },
  }, async args => execute({ sourceTypes: [], hotLists: args.platforms, maxHotRank: args.maxRank, maxItems: args.maxItems }, args.language, row => row.kind === "hot"));
  server.registerTool("get_deletions", {
    description: "Fetch deletion-watch flags (including provisional and returned statuses). Costs $8 per 1,000 fetched dataset rows; unflagged rows also count toward billing.",
    inputSchema: { platforms: platformInput, maxItems, highRank: z.number().int().min(3).max(50).optional() },
  }, async args => execute({ sourceTypes: [], hotLists: args.platforms, maxItems: args.maxItems, ...(args.highRank !== undefined ? { highRank: args.highRank } : {}) }, "both", row => row.censorship !== null && row.censorship !== undefined));
  return server;
}

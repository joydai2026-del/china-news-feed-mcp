# china-news-feed-mcp

A TypeScript MCP server for China news, platform hot lists, and deletion-watch flags, wrapping the [China News Feed Apify actor](https://apify.com/china.unofficial/china-news-feed) (`CeTIPfpcWcDrEhrPV`). Uses Node.js 20 native fetch and MCP over stdio.

Actor usage costs **$8 per 1,000 dataset rows, billed to your own Apify account**. Supply your API token through `APIFY_TOKEN`. Each call starts an actor run with `emitOnlyNew: false`, `snapshotCount: 1`, and `maxItems` as the billed-row cap. A default 50-row call costs up to $0.40 at this row price.

| Tool | Inputs | Result |
| --- | --- | --- |
| `get_china_news` | `language`: `zh`, `en`, or `both` (default); `maxItems`: 1–500 (default 50); optional `query`, `sources`, `sourceTypes` | News rows only; `sources` maps to actor `newsSources`, e.g. `xinhua`, `bbc`, `mfa`. |
| `get_hot_lists` | `platforms` (default all); `maxRank`: 5–50 (default 50); `maxItems`: 1–500 (default 50); `language` (default `both`) | Hot-list rows only; `maxRank` maps to actor `maxHotRank`. |
| `get_deletions` | `platforms` (default all); `maxItems`: 1–500 (default 50); optional `highRank`: 3–50 | Rows with non-null censorship flags, including status, label, rank, peak rank, and first/last seen when present. Both headlines are included. |

Supported platforms: Weibo 微博 (`weibo`), Baidu 百度 (`baidu`), Zhihu 知乎 (`zhihu`), Toutiao 今日头条 (`toutiao`), Douyin 抖音 (`douyin`), Bilibili 哔哩哔哩 (`bilibili`), Kuaishou 快手 (`kuaishou`).

News `sourceTypes` accepts the actor's exact values: `State media`, `Party-gov`, `Commercial platform`, `Overseas independent`, `Dissident`, `Censorship tracker`. Omitting sources or source types uses actor defaults; an empty source-type array selects no news types. An empty platform array selects no hot lists.

`language` controls output projection: `en` includes `headline_en`, `zh` includes `headline_original`, and `both` includes both. Missing translations are omitted. The actor has no language or query input. `query` filters both headlines locally, case-insensitively, after fetching. Deletion filtering also happens locally, so the returned `count` can be smaller than the fetched/billed row count. No automatic retries are made.

## Claude Desktop and Cursor

Install Node.js 20 or newer and obtain a token from your Apify account. For Claude Desktop, add the following to `claude_desktop_config.json` (open it through Settings → Developer → Edit Config). For Cursor, add it to `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` for global use. Merge it with existing `mcpServers` entries, then restart the client.

```json
{
  "mcpServers": {
    "china-news-feed": {
      "command": "npx",
      "args": ["-y", "github:joydai2026-del/china-news-feed-mcp"],
      "env": {
        "APIFY_TOKEN": "<your-apify-token>"
      }
    }
  }
}
```

GitHub installation builds `dist/` using the `prepare` script. Git must also be available for installation from GitHub. Keep your real token in private client configuration or your process environment; never commit it.

For a local build:

```bash
git clone https://github.com/joydai2026-del/china-news-feed-mcp.git
cd china-news-feed-mcp
npm install
npm run build
```

Use this server entry in either client's `mcpServers` object, replacing the path with your absolute checkout path:

```json
{
  "china-news-feed": {
    "command": "node",
    "args": ["/absolute/path/china-news-feed-mcp/dist/index.js"],
    "env": { "APIFY_TOKEN": "<your-apify-token>" }
  }
}
```

For manual startup with `APIFY_TOKEN` already exported, run `npm start`. The server reserves stdout for MCP messages. Missing tokens produce a clear tool error; tokens and raw upstream errors are never logged. The fetch timeout is 300 seconds; configure a longer tool timeout in your client if supported. A timed-out request may leave an actor run active in Apify.

## Docker

```bash
docker build -t china-news-feed-mcp .
# APIFY_TOKEN must already be exported in your shell.
docker run --rm -i -e APIFY_TOKEN china-news-feed-mcp
```

To use Docker from Claude Desktop or Cursor, set `command` to `docker`, `args` to `["run", "--rm", "-i", "-e", "APIFY_TOKEN", "china-news-feed-mcp"]`, and provide `APIFY_TOKEN` in the server's `env`. Use `-i` to keep stdin open for stdio transport.

## Smithery

The included `smithery.yaml` declares a stdio start command and requires the `apifyToken` configuration value. Smithery maps that value to `APIFY_TOKEN` and starts `node dist/index.js`; the included multi-stage Dockerfile supplies the build and runtime. Supply your own token when configuring the server.

The [official Apify MCP](https://mcp.apify.com/?tools=china.unofficial/china-news-feed) also works generically with this actor. This wrapper adds dedicated tools, local headline filtering, language projection, and compact output.

## Sample output

Shortened from the two fixture rows in [sample-rows.json](sample-rows.json), illustrating a `get_deletions` response. The tool returns compact JSON text; null and empty fields are dropped. Flags such as `likely_censored` are actor assessments and retain their status and evidence.

```json
{
  "count": 2,
  "rows": [
    {
      "kind": "hot",
      "source_id": "toutiao",
      "headline_en": "The 20th Asian Games Come to a Close",
      "headline_original": "第20届亚运会闭幕",
      "rank": 1,
      "peak_rank": 1,
      "first_seen": "2026-10-04T18:07:26Z",
      "last_seen": "2026-10-04T23:28:50Z",
      "censorship": { "status": "likely_censored", "label": "Likely censored" }
    },
    {
      "kind": "hot",
      "source_id": "weibo",
      "headline_original": "蔡康永",
      "rank": 14,
      "peak_rank": 11,
      "censorship": { "status": "likely_censored", "label": "Likely censored" }
    }
  ],
  "note": "billed rows: 2 at $8/1000"
}
```

## Pay-per-call HTTP API (x402)

- API base URL: https://ownly-cmf-x402.joyd-ai-2026.workers.dev
- Payee (payTo): `0x7BB40af451f7e6fcB7C844a0Ac9e709B92854F5F`
- Price: $0.01 per call, paid in USDC on Base
- Buyer guide: [docs/x402-buyer-guide.md](docs/x402-buyer-guide.md)

## Development

```bash
npm install
npm run build
npm test
```

Tests use mocked fetch responses and the provided fixtures, with no paid actor runs. Input reference: [actor-input-schema.json](actor-input-schema.json). Licensed under MIT, copyright 2026 Ownly.

## Related links

- Free sample rows on GitHub: https://github.com/joydai2026-del/china-news-feed-samples
- Hugging Face dataset: https://huggingface.co/datasets/freedom-press/china-news-feed-sample
- Apify actor: https://apify.com/china.unofficial/china-news-feed

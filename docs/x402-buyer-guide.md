# Buyer guide: Ownly China News Feed over x402

Pay per call in USDC on Base. No account, no API key.

**API:** https://ownly-cmf-x402.joyd-ai-2026.workers.dev
**OpenAPI:** https://ownly-cmf-x402.joyd-ai-2026.workers.dev/openapi.json
**Payee (payTo):** `0x7BB40af451f7e6fcB7C844a0Ac9e709B92854F5F`
**Asset:** USDC on Base. USDC token contract (not our payee): `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
**Price:** $0.01 per call (`maxAmountRequired` 10000, i.e. 0.01 USDC)

## Endpoints
| Path | What you get |
|---|---|
| `GET /v1/feed/en` | China news in English: headlines from Chinese state, commercial and overseas media plus platform hot lists |
| `GET /v1/feed/zh` | The same feed in the original Chinese |
| `GET /v1/hot` | Ranked hot lists: Weibo 微博, Baidu 百度, Zhihu 知乎, Toutiao 今日头条, Douyin 抖音, Bilibili 哔哩哔哩, Kuaishou 快手 |
| `GET /v1/deletions` | Deletion watch: topics flagged as likely censored, with evidence (Weibo, Baidu, Zhihu, Toutiao, Bilibili only) |
| `GET /sample` | Free sample, no payment |

Query params: `limit` (rows; the server caps it), `source` (a source_id), and `kind` (`hot` or `news`, feed endpoints only).

## How to pay
1. Call the endpoint. You get HTTP 402 with an `accepts` block (scheme `exact`, network `base`, payTo, asset, amount).
2. Sign a USDC `transferWithAuthorization` for 0.01 USDC to the payee, using any x402 client.
3. Retry the same request with the signed payload in the `X-PAYMENT` header. You get HTTP 200 with `meta`, `count` and `items`.

```bash
curl -i https://ownly-cmf-x402.joyd-ai-2026.workers.dev/v1/hot?limit=10   # returns 402 + payment terms
```

## Settlement proof (mainnet)
- [Base tx 0xdef787…99d4](https://base.blockscout.com/tx/0xdef7873f937b80a41d0e52f42dd1c0895c2e0d4da6a620e1dc5852a062fa99d4): block 52809684, Oct 19 2026 7:18:35 AM ET, 0.01 USDC to the payee above, status success, settled with x402 `transferWithAuthorization`.

## Notes
- Public data only. "Likely censored" is the default flag. We show the evidence for each flag.
- Douyin and Kuaishou come in as hot-list rows only, with no deletion check.

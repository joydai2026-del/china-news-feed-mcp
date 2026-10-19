// x402 paywall for hosted MCP tool calls without an Apify token.
// Terms and behaviour are ported from joydai2026-del/ownly-cmf-x402@23ca542 (src/index.js), which uses
// x402-hono@1.2.0 paymentMiddleware: same price/network/payTo vars, same facilitator choice, same 402 body.
// That middleware needs a Hono route, so the requirement/verify/settle steps are reproduced here with the x402 core.
import { createFacilitatorConfig } from "@coinbase/x402";
import { getAddress } from "viem";
import { exact } from "x402/schemes";
import { findMatchingPaymentRequirements, processPriceToAtomicAmount, toJsonSafe } from "x402/shared";
import { settleResponseHeader, SupportedEVMNetworks } from "x402/types";
import { useFacilitator } from "x402/verify";
import type { PaidTool } from "../src/server.js";

export interface PayEnv {
  X402_PAY_TO?: string;
  PRICE_USD?: string;
  NETWORK?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
}

const x402Version = 1;
const NETWORKS: Record<string, string> = { "base-sepolia": "Base Sepolia (testnet)", base: "Base mainnet" };
const price = (env: PayEnv) => env.PRICE_USD || "0.01";
const network = (env: PayEnv) => env.NETWORK || "base-sepolia";
const hasCdp = (env: PayEnv) => Boolean(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);
// Mainnet requires the CDP facilitator; testnet uses it when keys are set, else x402.org (same as ownly-cmf-x402).
const facilitatorFor = (env: PayEnv) => hasCdp(env) ? createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET) : { url: "https://x402.org/facilitator" as const };

// Descriptions copied from ownly-cmf-x402 routes (/v1/feed/en, /v1/feed/zh, /v1/hot, /v1/deletions).
const descriptions = {
  en: "China news in English: latest headlines from Chinese state, commercial and overseas media plus platform hot lists (public data, translated). $0.01 USDC per call.",
  zh: "China news in original Chinese: latest headlines from Chinese state, commercial and overseas media plus platform hot lists (public data). $0.01 USDC per call.",
  hot: "Chinese social platform hot lists (Weibo 微博, Baidu 百度, Zhihu 知乎, Toutiao 今日头条, Douyin 抖音, Bilibili 哔哩哔哩, Kuaishou 快手), ranked, public data. $0.01 USDC per call.",
  deletions: "China deletion watch: hot-list topics flagged as removed or censored, with status, rank and timing (public data). $0.01 USDC per call.",
};
export function describe(tool: PaidTool, args: Record<string, unknown>): string {
  if (tool === "get_hot_lists") return descriptions.hot;
  if (tool === "get_deletions") return descriptions.deletions;
  return args.language === "zh" ? descriptions.zh : descriptions.en;
}

type Json = Record<string, unknown>;
const challenge = (error: unknown, accepts: unknown[], extra: Json = {}) => ({ status: 402 as const, body: { error, accepts: toJsonSafe(accepts), ...extra, x402Version } });

// Returns a fail-closed 503 (same checks as ownly-cmf-x402) or the payment requirements for this call.
export function requirements(env: PayEnv, resource: string, tool: PaidTool, args: Record<string, unknown>): { status: 503; body: Json } | { accepts: Json[] } {
  if (!env.X402_PAY_TO) return { status: 503, body: { error: "Payment address is not configured" } };
  const net = network(env);
  if (!NETWORKS[net] || !SupportedEVMNetworks.includes(net as never)) return { status: 503, body: { error: "Unsupported network" } };
  if (net === "base" && !hasCdp(env)) return { status: 503, body: { error: "Mainnet requires CDP facilitator credentials" } };
  const amount = processPriceToAtomicAmount(`$${price(env)}`, net as never);
  if ("error" in amount) return { status: 503, body: { error: "Invalid price" } };
  const asset = amount.asset as { address: string; eip712?: Json };
  return { accepts: [{
    scheme: "exact",
    network: net,
    maxAmountRequired: amount.maxAmountRequired,
    resource,
    description: describe(tool, args),
    mimeType: "application/json",
    payTo: getAddress(env.X402_PAY_TO),
    maxTimeoutSeconds: 300,
    asset: getAddress(asset.address),
    outputSchema: { input: { type: "http", method: "POST", discoverable: true, bodyType: "json", bodyFields: { method: "tools/call", tool } }, output: { type: "object", description: "MCP tools/call result; content[0].text is JSON { count, rows, note }" } },
    extra: asset.eip712,
  }] };
}

export type Verified = { settle: () => Promise<{ ok: true; header: string } | { ok: false; status: 402; body: Json }> };

// Mirrors x402-hono: missing, malformed, unmatched or unverified payments all get a 402 with the requirements.
export async function verifyPayment(env: PayEnv, header: string | null, accepts: Json[]): Promise<Verified | { status: 402; body: Json }> {
  if (!header) return challenge("X-PAYMENT header is required", accepts);
  let decoded: ReturnType<typeof exact.evm.decodePayment>;
  try {
    decoded = exact.evm.decodePayment(header);
    decoded.x402Version = x402Version;
  } catch {
    return challenge("Invalid or malformed payment header", accepts);
  }
  const selected = findMatchingPaymentRequirements(accepts as never, decoded);
  if (!selected) return challenge("Unable to find matching payment requirements", accepts);
  const { verify, settle } = useFacilitator(facilitatorFor(env));
  try {
    const verification = await verify(decoded, selected);
    if (!verification.isValid) return challenge(verification.invalidReason ?? "Payment verification failed", accepts, { payer: verification.payer });
  } catch {
    return challenge("Payment verification failed", accepts);
  }
  return {
    settle: async () => {
      try {
        const settlement = await settle(decoded, selected);
        if (settlement.success) return { ok: true, header: settleResponseHeader(settlement) };
      } catch {
        // Fall through to a 402 without relaying facilitator internals.
      }
      return { ok: false, ...challenge("Failed to settle payment", accepts) };
    },
  };
}

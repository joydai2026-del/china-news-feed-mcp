// Hosted Worker x402 tests. All Apify and facilitator HTTP is mocked; any other fetch fails the test.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { build } from 'esbuild'; // ships with wrangler

const LIVE_REST_PAY_TO = '0x7BB40af451f7e6fcB7C844a0Ac9e709B92854F5F'; // live ownly-cmf-x402 402 payTo
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
let worker;
let calls;
const originalFetch = globalThis.fetch;
const toml = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
const vars = Object.fromEntries([...toml.split('[vars]')[1].matchAll(/^(\w+) = "([^"]*)"$/gm)].map(m => [m[1], m[2]]));
const kv = { feed_en: [{ id: 'n1', kind: 'news', headline_en: 'Hello' }, { id: 'h1', kind: 'hot', headline_en: 'Hot' }], hot: [{ id: 'h1', kind: 'hot', rank: 1 }, { id: 'h2', kind: 'hot', rank: 2 }], deletions: [{ id: 'd1', flags: ['deleted'] }] };
const FEED = { get: async key => kv[key] ?? null };
// Mainnet config straight from wrangler.toml; CDP values are dummies (never real keys in tests).
const mainnet = { ...vars, FEED, CDP_API_KEY_ID: 'dummy-id', CDP_API_KEY_SECRET: 'dummy-secret' };
// Testnet without CDP uses the x402.org facilitator, which fetch mocks below.
const testnet = { ...vars, FEED, NETWORK: 'base-sepolia' };
let facilitator = {};

before(async () => {
  // Bundle into the gitignored dist-worker/ so external packages resolve from this repo's node_modules.
  const outfile = new URL('../dist-worker/test/worker.mjs', import.meta.url);
  await build({ entryPoints: [new URL('../worker/index.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', packages: 'external', outfile: outfile.pathname, logLevel: 'silent' });
  worker = (await import(outfile.href)).default;
});
beforeEach(() => {
  calls = [];
  facilitator = { verify: { isValid: true, payer: '0x' + '22'.repeat(20) }, settle: { success: true, transaction: '0x' + 'ab'.repeat(32), network: 'base-sepolia', payer: '0x' + '22'.repeat(20) } };
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url.startsWith('https://api.apify.com/')) return new Response(JSON.stringify([{ kind: 'hot', source_id: 'weibo', headline_en: 'Mock hot', rank: 1 }]), { status: 200 });
    if (url === 'https://x402.org/facilitator/verify') return new Response(JSON.stringify(facilitator.verify), { status: 200 });
    if (url === 'https://x402.org/facilitator/settle') return new Response(JSON.stringify(facilitator.settle), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
});
after(() => { globalThis.fetch = originalFetch; });

const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const toolCall = (name, args = {}) => rpc('tools/call', { name, arguments: args });
async function post(body, env, headers = {}) {
  const request = new Request('https://china-news-feed-mcp.joyd-ai-2026.workers.dev/mcp', { method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } });
  const response = await worker.fetch(request, env);
  return { response, body: await response.json() };
}
const payment = (network, to = LIVE_REST_PAY_TO) => Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network, payload: {
  signature: '0x' + '11'.repeat(65),
  authorization: { from: '0x' + '22'.repeat(20), to, value: '10000', validAfter: '0', validBefore: '9999999999', nonce: '0x' + '33'.repeat(32) } } })).toString('base64');

test('wrangler.toml carries the ownly-cmf-x402 terms', () => {
  assert.equal(vars.X402_PAY_TO, '0x7bb40af451f7e6fcb7c844a0ac9e709b92854f5f');
  assert.equal(vars.PRICE_USD, '0.01');
  assert.equal(vars.NETWORK, 'base');
});

test('unpaid paid-tool calls get HTTP 402 with the exact REST Worker terms', async () => {
  for (const name of ['get_china_news', 'get_hot_lists', 'get_deletions']) {
    const { response, body } = await post(toolCall(name), mainnet);
    assert.equal(response.status, 402, name);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(body.x402Version, 1);
    assert.equal(body.error, 'X-PAYMENT header is required');
    assert.equal(body.accepts.length, 1);
    const [req] = body.accepts;
    assert.equal(req.scheme, 'exact');
    assert.equal(req.network, 'base');
    assert.equal(req.maxAmountRequired, '10000');
    assert.equal(req.payTo, LIVE_REST_PAY_TO);
    assert.equal(req.asset, USDC_BASE);
    assert.equal(req.maxTimeoutSeconds, 300);
    assert.equal(req.mimeType, 'application/json');
    assert.equal(req.resource, 'https://china-news-feed-mcp.joyd-ai-2026.workers.dev/mcp');
    assert.deepEqual(req.extra, { name: 'USD Coin', version: '2' });
    assert.match(req.description, /\$0\.01 USDC per call/);
  }
  assert.deepEqual(calls, []);
});

test('initialize, tools/list and get_sample stay free without a token', async () => {
  const init = await post(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }), mainnet);
  assert.equal(init.response.status, 200);
  assert.equal(init.body.result.serverInfo.name, 'china-news-feed-mcp');
  const list = await post(rpc('tools/list'), mainnet);
  assert.equal(list.response.status, 200);
  assert.deepEqual(list.body.result.tools.map(t => t.name), ['get_china_news', 'get_hot_lists', 'get_deletions', 'get_sample']);
  const sample = await post(toolCall('get_sample', { limit: 1 }), mainnet);
  assert.equal(sample.response.status, 200);
  assert.equal(JSON.parse(sample.body.result.content[0].text).count, 1);
  assert.deepEqual(calls, []);
});

const PAID_LINE = 'No Apify token? Pay $0.01 per call in USDC on Base via x402 (up to 20 items per call).';
test('tools/list adds the x402 line to exactly the three paid tools', async () => {
  for (const headers of [{}, { 'x-apify-token': 'byo-test-token' }]) {
    const { body } = await post(rpc('tools/list'), mainnet, headers);
    const withLine = body.result.tools.filter(t => t.description.split('\n').includes(PAID_LINE)).map(t => t.name);
    assert.deepEqual(withLine, ['get_china_news', 'get_hot_lists', 'get_deletions']);
    for (const t of body.result.tools) assert.equal(t.description.split(PAID_LINE).length - 1, withLine.includes(t.name) ? 1 : 0, t.name);
    assert.equal(body.result.tools.find(t => t.name === 'get_hot_lists').description, `Fetch Chinese platform hot lists. Costs $8 per 1,000 dataset rows on your own Apify account.\n${PAID_LINE}`);
    assert.equal(body.result.tools.find(t => t.name === 'get_sample').description, 'Free sample of the English China news feed (no Apify token needed).');
  }
  const unconfigured = await post(rpc('tools/list'), { ...mainnet, X402_PAY_TO: '' });
  assert.ok(unconfigured.body.result.tools.every(t => !t.description.includes('x402')));
  assert.deepEqual(calls, []);
});

test('BYO Apify token goes straight to Apify (mocked) with no x402, even if X-PAYMENT is sent', async () => {
  for (const headers of [{ 'x-apify-token': 'byo-test-token' }, { authorization: 'Bearer byo-test-token', 'x-payment': 'garbage' }]) {
    calls = [];
    const { response, body } = await post(toolCall('get_hot_lists', { language: 'en', maxRank: 5, maxItems: 5 }), mainnet, headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-payment-response'), null);
    const result = JSON.parse(body.result.content[0].text);
    assert.equal(result.count, 1);
    assert.match(result.note, /billed rows: 1/);
    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, '/v2/acts/china.unofficial~china-news-feed/run-sync-get-dataset-items');
    assert.equal(url.searchParams.get('token'), 'byo-test-token');
    assert.deepEqual(JSON.parse(calls[0].init.body), { sourceTypes: [], hotLists: ['weibo', 'baidu', 'zhihu', 'toutiao', 'bilibili', 'douyin', 'kuaishou'], maxHotRank: 5, maxItems: 5, emitOnlyNew: false, snapshotCount: 1 });
  }
});

test('malformed or unmatched X-PAYMENT gets 402 again without reaching the facilitator', async () => {
  for (const [header, error] of [['not-base64!', /Invalid or malformed/], [Buffer.from('{"x":1}').toString('base64'), /Invalid or malformed/], [payment('base-sepolia'), /Unable to find matching/]]) {
    const { response, body } = await post(toolCall('get_hot_lists'), mainnet, { 'x-payment': header });
    assert.equal(response.status, 402);
    assert.match(body.error, error);
    assert.equal(body.accepts[0].payTo, LIVE_REST_PAY_TO);
  }
  assert.deepEqual(calls, []);
});

test('payment rejected by the facilitator (mocked) gets 402 and no data', async () => {
  facilitator.verify = { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature', payer: '0x' + '22'.repeat(20) };
  const { response, body } = await post(toolCall('get_hot_lists'), testnet, { 'x-payment': payment('base-sepolia') });
  assert.equal(response.status, 402);
  assert.equal(body.error, 'invalid_exact_evm_payload_signature');
  assert.deepEqual(calls.map(c => c.url), ['https://x402.org/facilitator/verify']);
});

test('mainnet verify uses the CDP facilitator; failures (dummy keys) give 402, never data', async () => {
  const { response, body } = await post(toolCall('get_hot_lists'), mainnet, { 'x-payment': payment('base') });
  assert.equal(response.status, 402);
  assert.equal(body.error, 'Payment verification failed');
  assert.ok(calls.every(c => !c.url.startsWith('https://api.apify.com/')));
  assert.ok(calls.every(c => !c.url.startsWith('https://x402.org/')));
});

test('verified payment returns KV rows, settles, and sets X-PAYMENT-RESPONSE', async () => {
  const { response, body } = await post(toolCall('get_hot_lists', { maxItems: 1 }), testnet, { 'x-payment': payment('base-sepolia') });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('x-payment-response'));
  assert.match(response.headers.get('access-control-expose-headers'), /X-PAYMENT-RESPONSE/);
  const result = JSON.parse(body.result.content[0].text);
  assert.deepEqual(result.rows, [kv.hot[0]]);
  assert.deepEqual(calls.map(c => c.url), ['https://x402.org/facilitator/verify', 'https://x402.org/facilitator/settle']);
  const verifyBody = JSON.parse(calls[0].init.body);
  assert.equal(verifyBody.paymentRequirements.maxAmountRequired, '10000');
  assert.equal(verifyBody.paymentRequirements.payTo, LIVE_REST_PAY_TO);
});

test('failed settlement gets 402 instead of data', async () => {
  facilitator.settle = { success: false, errorReason: 'insufficient_funds', transaction: '', network: 'base-sepolia' };
  const { response, body } = await post(toolCall('get_deletions'), testnet, { 'x-payment': payment('base-sepolia') });
  assert.equal(response.status, 402);
  assert.equal(body.error, 'Failed to settle payment');
  assert.equal(body.result, undefined);
});

test('fails closed like ownly-cmf-x402 and refuses batched paid calls', async () => {
  assert.equal((await post(toolCall('get_hot_lists'), { ...mainnet, X402_PAY_TO: '' })).response.status, 503);
  assert.equal((await post(toolCall('get_hot_lists'), { ...vars, FEED })).response.status, 503); // mainnet without CDP keys
  const batch = await post([toolCall('get_hot_lists'), { ...toolCall('get_deletions'), id: 2 }], testnet, { 'x-payment': payment('base-sepolia') });
  assert.equal(batch.response.status, 400);
  assert.deepEqual(calls, []);
});

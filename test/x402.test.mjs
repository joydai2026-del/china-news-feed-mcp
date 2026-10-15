import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';

test('x402 routes, limits, local filters, projections, and safe errors without network', async () => {
  const names = ['BACKEND', 'APIFY_TOKEN', 'X402_PRIVATE_KEY', 'X402_BASE_URL'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  process.env.BACKEND = 'x402';
  delete process.env.APIFY_TOKEN;
  delete process.env.X402_PRIVATE_KEY;
  process.env.X402_BASE_URL = 'https://example.test';
  const server = createServer();
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  const requests = [];
  let data = [{ kind: 'news', source_id: 'xinhua', headline_en: 'China news', headline_original: '中国' }];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: new URL(url), ...options });
    return new Response(JSON.stringify(data));
  };
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const parse = result => JSON.parse(result.content[0].text);
  try {
    assert.match((await call('get_china_news')).content[0].text, /X402_PRIVATE_KEY/);
    assert.equal(requests.length, 0);
    // Public test fixture key only; never use a funded wallet here.
    process.env.X402_PRIVATE_KEY = `0x${'01'.repeat(32)}`;
    const news = parse(await call('get_china_news', { query: 'CHINA' }));
    assert.equal(news.count, 1);
    assert.equal(news.rows[0].headline_original, '中国');
    assert.match(news.note, /0\.01/);
    assert.equal(requests.at(-1).url.pathname, '/v1/feed/en');
    assert.equal(requests.at(-1).url.searchParams.get('limit'), '20');
    assert.equal(requests.at(-1).method, 'GET');
    assert.equal(parse(await call('get_china_news', { query: 'absent' })).count, 0);
    const zh = parse(await call('get_china_news', { language: 'zh', maxItems: 2 }));
    assert.equal(zh.rows[0].headline_en, undefined);
    assert.equal(requests.at(-1).url.pathname, '/v1/feed/zh');
    assert.equal(requests.at(-1).url.searchParams.get('limit'), '2');
    assert.equal(parse(await call('get_china_news', { language: 'en' })).rows[0].headline_original, undefined);
    data = ['weibo', 'baidu'].map(source_id => ({ kind: 'hot', source_id, rank: 2, censorship: { status: 'likely_censored' } }));
    assert.equal(parse(await call('get_hot_lists', { platforms: ['weibo'] })).count, 1);
    assert.equal(requests.at(-1).url.pathname, '/v1/hot');
    assert.equal(parse(await call('get_hot_lists', { platforms: [] })).count, 0);
    const deletions = parse(await call('get_deletions', { platforms: ['baidu'] }));
    assert.equal(deletions.count, 1);
    assert.equal(deletions.rows[0].source_id, 'baidu');
    assert.equal(requests.at(-1).url.pathname, '/v1/deletions');
    data = { rows: data };
    assert.equal(parse(await call('get_hot_lists')).count, 2);
    let attempts = 0;
    globalThis.fetch = async (url, options) => {
      attempts++;
      if (attempts === 1) return new Response(JSON.stringify({
        x402Version: 1,
        accepts: [{
          scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '10000',
          resource: String(url), description: 'Test feed', mimeType: 'application/json',
          payTo: '0x0000000000000000000000000000000000000001',
          maxTimeoutSeconds: 60, asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          extra: { name: 'USDC', version: '2' },
        }],
      }), { status: 402 });
      assert.ok(options.headers['X-PAYMENT']);
      const payment = JSON.parse(Buffer.from(options.headers['X-PAYMENT'], 'base64').toString());
      assert.equal(payment.network, 'base-sepolia');
      assert.equal(payment.payload.authorization.value, '10000');
      assert.match(payment.payload.signature, /^0x/);
      return new Response(JSON.stringify(data));
    };
    assert.equal(parse(await call('get_hot_lists')).count, 2);
    assert.equal(attempts, 2);
    globalThis.fetch = async () => new Response(JSON.stringify(data));
    data = {};
    assert.equal((await call('get_hot_lists')).isError, true);
    globalThis.fetch = async () => new Response(process.env.X402_PRIVATE_KEY, { status: 500 });
    const failure = await call('get_china_news');
    assert.equal(failure.isError, true);
    assert.match(failure.content[0].text, /500/);
    assert.ok(!JSON.stringify(failure).includes(process.env.X402_PRIVATE_KEY));
    globalThis.fetch = async () => { throw new Error(process.env.X402_PRIVATE_KEY); };
    assert.ok(!JSON.stringify(await call('get_china_news')).includes(process.env.X402_PRIVATE_KEY));
    process.env.X402_PRIVATE_KEY = 'invalid-secret';
    assert.equal((await call('get_china_news')).isError, true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await client.close();
    await server.close();
  }
});

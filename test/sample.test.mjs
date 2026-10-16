import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';

async function connect(options) {
  const server = createServer(options);
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('get_sample returns free sample items without a token', async () => {
  const items = [{ id: 1, title: 'a' }, { id: 2, title: 'b' }, { id: 3, title: 'c' }];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('fetch must not be called'); };
  const { client, close } = await connect({ getToken: () => undefined, getSample: async () => items });
  try {
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['get_china_news', 'get_hot_lists', 'get_deletions', 'get_sample']);
    const all = JSON.parse((await client.callTool({ name: 'get_sample', arguments: {} })).content[0].text);
    assert.equal(all.count, 3);
    assert.deepEqual(all.items, items);
    assert.match(all.note, /apify\.com\/china\.unofficial\/china-news-feed/);
    const one = JSON.parse((await client.callTool({ name: 'get_sample', arguments: { limit: 1 } })).content[0].text);
    assert.deepEqual(one.items, [items[0]]);
    assert.equal((await client.callTool({ name: 'get_sample', arguments: { limit: 4 } })).isError, true);
    const missing = await client.callTool({ name: 'get_china_news', arguments: {} });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /x-apify-token/);
    assert.match(missing.content[0].text, /apifyToken/);
  } finally {
    globalThis.fetch = originalFetch;
    await close();
  }
});

test('get_sample is not registered without getSample', async () => {
  const { client, close } = await connect();
  try {
    assert.ok(!(await client.listTools()).tools.some(t => t.name === 'get_sample'));
  } finally {
    await close();
  }
});

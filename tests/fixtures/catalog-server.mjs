import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Server } from '@modelcontextprotocol/server';

const server = new Server(
  { name: 'catalog-fixture', version: '1.0' },
  { capabilities: { tools: {}, prompts: {}, resources: {} } },
);
const cacheFiles = process.env.CATALOG_TEST_CACHE_PROBE === 'true'
  ? [process.env.SLACK_MCP_CHANNELS_CACHE, process.env.SLACK_MCP_USERS_CACHE]
  : [];
for (const file of cacheFiles) {
  if (!file) throw new Error('Slack cache environment was not isolated');
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ credential: process.env.PERSONAL_KEY }));
}
const identity = () => ({
  credential: process.env.PERSONAL_KEY,
  pid: process.pid,
  ...(cacheFiles.length ? {
    cachedCredentials: cacheFiles.map((file) => JSON.parse(readFileSync(file, 'utf8')).credential),
    cacheFiles,
  } : {}),
});
server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'identity',
      inputSchema: { type: 'object', properties: { delay: { type: 'number' } } },
    },
  ],
}));
server.setRequestHandler('tools/call', async (request) => {
  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, request.params.arguments?.delay || 0));
  return {
    content: [
      { type: 'text', text: JSON.stringify({ ...identity(), startedAt, finishedAt: Date.now() }) },
    ],
  };
});
server.setRequestHandler('prompts/list', async () => ({ prompts: [{ name: 'identity' }] }));
server.setRequestHandler('prompts/get', async () => ({
  messages: [{ role: 'user', content: { type: 'text', text: JSON.stringify(identity()) } }],
}));
server.setRequestHandler('resources/list', async () => ({
  resources: [{ name: 'identity', uri: 'catalog://identity' }],
}));
server.setRequestHandler('resources/read', async () => ({
  contents: [{ uri: 'catalog://identity', text: JSON.stringify(identity()) }],
}));
await server.connect(new StdioServerTransport());

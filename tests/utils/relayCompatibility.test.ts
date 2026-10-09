import {
  supportsFetchRelay,
  isRelayEnvironmentVariable,
} from '../../src/utils/relayCompatibility.js';

test('native MCPs do not gain relay support from variable names or arbitrary switches', () => {
  expect(
    supportsFetchRelay({
      args: ['-y', 'native-mcp'],
      env: { PUBMED_RELAY_URL: 'http://relay' },
      relay: { enabled: true },
    }),
  ).toBe(false);
  expect(supportsFetchRelay({ type: 'sse', env: { MCPHUB_RELAY_ADAPTER: 'fetch-v1' } })).toBe(
    false,
  );
});
test('generic declarations and old standalone wrapper paths support renamed services', () => {
  expect(supportsFetchRelay({ env: { MCPHUB_RELAY_ADAPTER: 'fetch-v1' } })).toBe(true);
  expect(
    supportsFetchRelay({ args: ['/app/data/uploads/mcpb/server-osm-mcp-server/launch.cjs'] }),
  ).toBe(true);
  expect(
    supportsFetchRelay({
      args: ['/app/data/uploads/mcpb/server-atlas-wikipedia-97253e9-59a8ad35/launch.cjs'],
    }),
  ).toBe(true);
  expect(isRelayEnvironmentVariable('PUBMED_RELAY_TOKEN')).toBe(true);
  expect(isRelayEnvironmentVariable('MCP_RELAY_URL')).toBe(true);
  expect(
    isRelayEnvironmentVariable('CUSTOM_RELAY_TOKEN', { enabled: true, envPrefix: 'CUSTOM' }),
  ).toBe(true);
  expect(isRelayEnvironmentVariable('NCBI_API_KEY')).toBe(false);
});

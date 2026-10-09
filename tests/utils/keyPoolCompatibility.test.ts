import { getKeyPoolProvider, isPooledCredential } from '../../src/utils/keyPoolCompatibility.js';

describe('rotation adapter discovery', () => {
  it('uses the actual implementation rather than a server name', () => {
    expect(
      getKeyPoolProvider({ type: 'stdio', args: ['-y', '@upstash/context7-mcp@1.0.33'] }),
    ).toBe('context7');
    expect(
      getKeyPoolProvider({ command: 'python', args: ['/packages/v2/twelvedata_mcp_compat.py'] }),
    ).toBe('twelvedata');
    expect(getKeyPoolProvider({ command: 'node', args: ['notion.js'] })).toBeUndefined();
    expect(
      getKeyPoolProvider({ command: 'node', args: ['some-context7-clone.js'] }),
    ).toBeUndefined();
  });
  it('accepts a packaged adapter declaration but excludes remote transports', () => {
    const env = { MCPHUB_KEY_POOL_ADAPTER: 'twelvedata' };
    expect(getKeyPoolProvider({ type: 'stdio', args: ['/portable/launch.cjs'], env })).toBe(
      'twelvedata',
    );
    expect(getKeyPoolProvider({ type: 'streamable-http', env })).toBeUndefined();
    expect(getKeyPoolProvider({ env: { MCPHUB_KEY_POOL_ADAPTER: 'notion' } })).toBeUndefined();
  });
  it('only hides the credential replaced by the enabled adapter', () => {
    expect(isPooledCredential('CONTEXT7_API_KEY', 'context7')).toBe(true);
    expect(isPooledCredential('TWELVE_DATA_API_KEY', 'twelvedata')).toBe(true);
    expect(isPooledCredential('NOTION_TOKEN', 'context7')).toBe(false);
    expect(isPooledCredential('CONTEXT7_API_KEY', undefined)).toBe(false);
  });
});

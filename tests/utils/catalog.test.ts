import {
  mcpServerPath,
  serverKey,
  splitServerKey,
  validateServerKey,
} from '../../src/utils/catalog.js';

describe('catalog identity', () => {
  it('keeps legacy public keys and separates identical names in different scopes', () => {
    expect(serverKey('arxiv')).toBe('arxiv');
    expect(serverKey('arxiv', 'atlas')).toBe('atlas::arxiv');
    expect(serverKey('arxiv', 'toolathlon')).toBe('toolathlon::arxiv');
    expect(splitServerKey('atlas::arxiv')).toEqual({ catalog: 'atlas', name: 'arxiv' });
    expect(mcpServerPath('atlas::arxiv')).toBe('/mcp/atlas/arxiv');
    expect(mcpServerPath('arxiv')).toBe('/mcp/arxiv');
  });

  it.each(['../atlas', 'Atlas', '$smart', 'atlas/foo', 'atlas::other', 'a'.repeat(49)])(
    'rejects invalid namespace %s',
    (catalog) => {
      expect(validateServerKey('arxiv', catalog).valid).toBe(false);
    },
  );

  it('validates canonical keys on import and prevents path traversal', () => {
    expect(validateServerKey('atlas::arxiv').normalized).toBe('atlas::arxiv');
    expect(validateServerKey('atlas::other::arxiv').valid).toBe(false);
    expect(validateServerKey('../arxiv', 'atlas').valid).toBe(false);
  });
});

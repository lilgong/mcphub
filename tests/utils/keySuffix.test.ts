import { keySuffix } from '../../src/utils/keySuffix.js';
import { normalizeKeyPool } from '../../src/utils/keyPool.js';
describe('automatic key suffix', () => {
  test('shows the last six characters without exposing a full short credential', () => {
    expect(keySuffix('ctx7sk-secret-123456')).toBe('…123456');
    expect(keySuffix('abcdef')).toBe('…bcdef');
    expect(keySuffix('x')).toBe('…');
    expect(keySuffix('')).toBe('—');
  });
  test('ignores a legacy label and accepts keys without names', () => {
    const pool = normalizeKeyPool({
      enabled: true,
      provider: 'context7',
      keys: [
        { id: 'one', value: 'private-123456', label: 'old-name' },
        { id: 'two', value: 'private-654321' },
      ],
    });
    expect(pool?.keys.map((key) => key.label)).toEqual(['…123456', '…654321']);
  });
});

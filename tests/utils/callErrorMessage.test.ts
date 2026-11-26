import { callErrorMessage } from '../../src/utils/callErrorMessage.js';

describe('call error messages', () => {
  it('extracts nested provider errors without copying other payload fields', () => {
    expect(
      callErrorMessage({
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: { message: 'Insufficient quota' },
              headers: { private: 'do-not-copy' },
            }),
          },
        ],
      }),
    ).toBe('Insufficient quota');
    expect(callErrorMessage({ arbitrary: 'do-not-copy' })).toBeUndefined();
  });
  it('redacts credentials before limiting error length', () => {
    const message = callErrorMessage(
      new Error(
        'HTTP 403 api_key=opaque-password Bearer opaque-token https://example.com/path?key=secret AIza01234567890123456789012345678901234',
      ),
    );
    expect(message).toContain('HTTP 403');
    for (const secret of ['opaque-password', 'opaque-token', '?key=secret', 'AIza012345'])
      expect(message).not.toContain(secret);
    expect(callErrorMessage(new Error('x'.repeat(5000)))!.length).toBeLessThanOrEqual(4096);
  });
  it('does not invent text for an absent error', () => {
    expect(callErrorMessage(undefined)).toBeUndefined();
  });
});

import { copyInputSchema } from '../../utils/inputSchema.js';

describe('upstream schema preservation', () => {
  test('preserves dialect, references and constraints without mutating the upstream object', () => {
    const original = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      definitions: { item: { type: 'number' } },
      additionalProperties: false,
    };
    const forwarded = copyInputSchema(original);
    expect(forwarded).toEqual(original);
    expect(forwarded).not.toBe(original);
    delete (forwarded as Partial<typeof original>).$schema;
    expect(original.$schema).toBe('http://json-schema.org/draft-07/schema#');
  });
  test.each([null, undefined, true, 42, 'schema'])('preserves non-object input %p', (value) => {
    expect(copyInputSchema(value)).toBe(value);
  });
});

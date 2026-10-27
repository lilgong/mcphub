import {
  documentField,
  initialDocument,
  updateDocumentField,
  validateDocument,
} from '../../src/utils/workspaceDocuments.js';
import type { WorkspaceCredentialFile } from '../../src/types/workspace.js';

test('form edits preserve JSON defaults, OAuth extension fields and multiline private keys', () => {
  const file: WorkspaceCredentialFile = {
    path: 'configs/auth.json',
    format: 'json',
    template: '{"scopes":["calendar"],"client_id":"","provider_extension":{"v":1}}',
  };
  const changed = updateDocumentField(file, initialDocument(file), 'client_id', 'client-b');
  expect(JSON.parse(changed)).toEqual({
    scopes: ['calendar'],
    client_id: 'client-b',
    provider_extension: { v: 1 },
  });
  const key = '-----BEGIN PRIVATE KEY-----\nline\n-----END PRIVATE KEY-----';
  expect(
    documentField(
      file,
      updateDocumentField(file, changed, 'service.private_key', key),
      'service.private_key',
    ),
  ).toBe(key);
  expect(() => updateDocumentField(file, changed, '__proto__.polluted', 'bad')).toThrow();
  expect(
    documentField(
      file,
      updateDocumentField(file, changed, 'private_key', key.replace(/\n/g, '\\n')),
      'private_key',
    ),
  ).toBe(key);
});
test('env account fields preserve unrelated state and quote secrets literally', () => {
  const file: WorkspaceCredentialFile = {
    path: 'configs/auth.env',
    format: 'env',
    fields: [{ name: 'MAILBOX_PROVIDER', secret: false, default: 'outlook' }],
  };
  expect(initialDocument(file)).toBe('MAILBOX_PROVIDER="outlook"\n');
  const text = updateDocumentField(
    file,
    'OTHER="keep"\nPASSWORD="old"\n',
    'PASSWORD',
    'spaces # quote"\\end',
  );
  expect(documentField(file, text, 'PASSWORD')).toBe('spaces # quote"\\end');
  expect(text).toContain('OTHER="keep"');
  expect(documentField(file, 'PASSWORD="literal\\q" # comment', 'PASSWORD')).toBe('literal\\q');
});
test.each(['null', '[]', '{', '"token"'])('invalid JSON document is rejected: %s', (value) => {
  expect(validateDocument({ path: 'configs/auth.json', format: 'json' }, value)).toBe(false);
});

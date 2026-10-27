#!/usr/bin/env node
// Offline preparation: read a private database snapshot, copy code, rewrite only package paths.
// Does not update the database or stop/restart services.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [snapshotFile, runtimePath, outputFile] = process.argv.slice(2);
if (!snapshotFile || !runtimePath || !outputFile)
  throw new Error('Usage: snapshot.json runtime-dir output.private.json');
if (fs.existsSync(outputFile))
  throw new Error('Output already exists; refusing to replace a private migration snapshot');
const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
const mappings = [];
for (const [name, server] of Object.entries(snapshot)) {
  const [catalog, logical] = name.split('::');
  if (!logical) continue;
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(catalog) || !/^[A-Za-z0-9_.-]+$/.test(logical))
    throw new Error('Invalid canonical name');
  const args = [
    ...(server.args || []),
    ...(server.targets || []).flatMap((t) => t.config?.args || []),
  ];
  const folder = args.find(
    (arg) => typeof arg === 'string' && arg.startsWith('/app/data/uploads/mcpb/'),
  );
  if (!folder) continue;
  const oldDirectory = path.posix.dirname(folder);
  const newDirectory = `/app/data/uploads/mcpb/catalogs/${catalog}/server-${catalog}~${logical}`;
  if (oldDirectory === newDirectory) continue;
  const source = path.join(runtimePath, path.posix.relative('/app/data', oldDirectory));
  const destination = path.join(runtimePath, path.posix.relative('/app/data', newDirectory));
  if (!fs.existsSync(path.join(source, 'manifest.json')))
    throw new Error(`Missing bundle for ${name}`);
  if (fs.existsSync(destination))
    throw new Error(`Already staged ${name}; inspect before retrying`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
  fs.writeFileSync(path.join(destination, '.mcphub-install-id'), crypto.randomUUID());
  mappings.push([oldDirectory, newDirectory]);
}
const rewrite = (value) => {
  if (typeof value === 'string') {
    for (const [before, after] of mappings) value = value.split(before).join(after);
    return value;
  }
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
  return value;
};
const updated = Object.fromEntries(
  Object.entries(snapshot).map(([name, server]) => [
    name,
    {
      ...server,
      args: rewrite(server.args),
      env: rewrite(server.env),
      targets: rewrite(server.targets),
    },
  ]),
);
fs.writeFileSync(outputFile, JSON.stringify(updated), { mode: 0o600 });
console.log(
  `Prepared ${mappings.length} independent package trees; configuration written privately. Database unchanged.`,
);

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historicalLogCatalogs } from '../../src/services/logCatalogService.js';

describe('historical log namespace discovery', () => {
  const saved = { ...process.env };
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'log-catalogs-'));
    process.env.MCPHUB_AUDIT_LOG_DIR = join(root, 'audit');
    process.env.MCPHUB_KEY_POOL_LOG_DIR = join(root, 'pool');
    process.env.MCP_USAGE_LOG_DIR = join(root, 'usage');
    process.env.MCPHUB_RELAY_LOG_FILE = join(root, 'relay.jsonl');
  });
  afterEach(async () => {
    process.env = { ...saved };
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  const write = async (relative: string, records: object[]) => {
    const file = join(root, relative);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n{"partial":');
  };

  it('finds deleted namespaces across audit, HTTP, key pools, provider files and attributed Relay history', async () => {
    await write('audit/2026-10-26.jsonl', [
      { event: 'finished', server: 'toolathlon::met-museum' },
      { event: 'finished', server: 'toolathlon::fetch' },
      { event: 'finished', group: 'toolathlon::calculator' },
      { event: 'upstream_finished', server: 'httpbench::serper' },
      { event: 'started', server: 'unfinished::arxiv' },
      { event: 'finished', server: 'public-server' },
    ]);
    await write('pool/2026-09-01.jsonl', [
      { event: 'pool_unavailable', server: 'poolbench::context7' },
    ]);
    await write('usage/catalogs/providerbench/exa/2026-10/exa_20261026.jsonl', [
      { event: 'finished' },
    ]);
    await write('relay.jsonl', [
      { event: 'http_finished', catalog: 'relaybench' },
      { event: 'http_completed', catalog: '../bad' },
      { event: 'http_finished', host: 'example.org' },
    ]);
    await mkdir(join(root, 'usage/catalogs/emptybench/exa/2026-10'), { recursive: true });
    expect(await historicalLogCatalogs()).toEqual([
      'httpbench',
      'poolbench',
      'providerbench',
      'relaybench',
      'toolathlon',
    ]);
  });

  it('refreshes cached history without allowing callers to mutate it', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    await write('audit/2026-10-26.jsonl', [{ event: 'finished', server: 'atlas::fetch' }]);
    const names = await historicalLogCatalogs();
    names.push('fake');
    await write('audit/2026-10-27.jsonl', [{ event: 'finished', server: 'toolathlon::fetch' }]);
    expect(await historicalLogCatalogs()).toEqual(['atlas']);
    now.mockReturnValue(32000);
    expect(await historicalLogCatalogs()).toEqual(['atlas', 'toolathlon']);
  });

  it('treats absent log roots as empty history', async () => {
    expect(await historicalLogCatalogs()).toEqual([]);
  });
});

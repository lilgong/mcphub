import express from 'express';
import request from 'supertest';
import * as fs from 'node:fs/promises';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withToolAudit, captureToolDiagnostic } from '../../src/services/toolAuditService.js';
import { TaskConnectionRegistry } from '../../src/services/taskConnectionService.js';
import { appendDurableAudit } from '../../src/services/durableAuditService.js';

jest.mock('../../src/utils/logger.js', () => ({ logger: { log: jest.fn() } }));
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual('node:fs/promises');
  return { ...actual, open: jest.fn(actual.open) };
});
const originalOpen: typeof fs.open = jest.requireActual('node:fs/promises').open;

it('shares one file fsync for a burst while preserving every record and admission barrier', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-audit-batch-'));
  const file = join(directory, 'calls.jsonl');
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const syncCalls = jest.fn();
  const open = jest.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === file) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        syncCalls();
        entered();
        await gate;
        await sync();
      };
    }
    return handle;
  });
  let completed = 0;
  const writes = Array.from({ length: 64 }, (_, index) =>
    appendDurableAudit(file, { index }).then(() => {
      completed++;
    }),
  );
  try {
    await started;
    expect(completed).toBe(0);
    release();
    await Promise.all(writes);
    expect(syncCalls).toHaveBeenCalledTimes(1);
    const records = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.index)).toEqual(
      Array.from({ length: 64 }, (_, index) => index),
    );
  } finally {
    release();
    await Promise.allSettled(writes);
    open.mockImplementation(originalOpen);
    rmSync(directory, { recursive: true, force: true });
  }
});

it('stalled audit fsync gates a tool without blocking HTTP lease renewal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-async-audit-'));
  const previous = process.env.MCPHUB_AUDIT_LOG_DIR;
  process.env.MCPHUB_AUDIT_LOG_DIR = directory;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = originalOpen;
  let stalled = false;
  const open = jest.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (!stalled && String(args[0]).endsWith('.jsonl')) {
      stalled = true;
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        entered();
        await gate;
        await sync();
      };
    }
    return handle;
  });
  const tool = jest.fn(async () => ({ isError: false }));
  const pending = withToolAudit({ server: 'arxiv', tool: 'search' }, tool);
  const registry = new TaskConnectionRegistry();
  const entry = registry.register({
    server: 'arxiv',
    target: 'task/default',
    taskId: 'task-a',
    owner: 'owner',
    username: 'owner',
    url: 'http://callback.invalid',
    upstreamToken: 'private',
  });
  const before = entry.expiresAt;
  const app = express();
  app.put('/renew', (_req, res) => res.json({ renewed: registry.renew(entry.id, 'owner', 600) }));
  try {
    await started;
    expect(tool).not.toHaveBeenCalled();
    const response = await request(app).put('/renew').timeout({ response: 1000, deadline: 1500 });
    expect(response.body).toEqual({ renewed: true });
    expect(entry.expiresAt).toBeGreaterThan(before);
    release();
    await pending;
    expect(tool).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await pending.catch(() => undefined);
    open.mockImplementation(originalOpen);
    if (previous === undefined) delete process.env.MCPHUB_AUDIT_LOG_DIR;
    else process.env.MCPHUB_AUDIT_LOG_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

it('serializes complete concurrent audit records and finishes diagnostic writes before returning', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-async-records-'));
  const previous = process.env.MCPHUB_AUDIT_LOG_DIR;
  process.env.MCPHUB_AUDIT_LOG_DIR = directory;
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        withToolAudit({ tool: `search-${index}` }, async () => {
          captureToolDiagnostic('search')('dispatched', { wait_ms: index });
          return { isError: false };
        }),
      ),
    );
    const records = readdirSync(directory).flatMap((file) =>
      readFileSync(join(directory, file), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
    expect(records).toHaveLength(36);
    for (let index = 0; index < 12; index++) {
      expect(
        records.filter((row) => row.tool === `search-${index}`).map((row) => row.event),
      ).toEqual(['started', 'dispatched', 'finished']);
    }
  } finally {
    if (previous === undefined) delete process.env.MCPHUB_AUDIT_LOG_DIR;
    else process.env.MCPHUB_AUDIT_LOG_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

it('a failed durable append does not poison later writes after storage recovers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-audit-recover-'));
  const file = join(directory, 'calls.jsonl');
  const open = jest.mocked(fs.open).mockRejectedValueOnce(new Error('disk unavailable'));
  try {
    await expect(appendDurableAudit(file, { event: 'failed' })).rejects.toThrow('disk unavailable');
    open.mockImplementation(originalOpen);
    await appendDurableAudit(file, { event: 'recovered' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ event: 'recovered' });
  } finally {
    open.mockImplementation(originalOpen);
    rmSync(directory, { recursive: true, force: true });
  }
});

it('rejects every admission in a failed batch and bounds successful batch sizes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-audit-batch-failure-'));
  const file = join(directory, 'calls.jsonl');
  const open = jest.mocked(fs.open).mockRejectedValueOnce(new Error('disk unavailable'));
  try {
    const failed = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => appendDurableAudit(file, { index })),
    );
    expect(failed.every((result) => result.status === 'rejected')).toBe(true);
    const syncCalls = jest.fn();
    open.mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === file) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          syncCalls();
          await sync();
        };
      }
      return handle;
    });
    await Promise.all(
      Array.from({ length: 300 }, (_, index) => appendDurableAudit(file, { index })),
    );
    expect(syncCalls).toHaveBeenCalledTimes(3);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(300);
  } finally {
    open.mockImplementation(originalOpen);
    rmSync(directory, { recursive: true, force: true });
  }
});

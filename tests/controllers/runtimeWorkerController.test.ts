import express from 'express';
import request from 'supertest';
import { getRuntimeWorkers } from '../../src/controllers/runtimeWorkerController.js';
const app = express();
app.use((req, _res, next) => {
  if (req.get('x-test-admin')) Object.assign(req, { user: { isAdmin: true, username: 'admin' } });
  next();
});
app.get('/workers', getRuntimeWorkers);
const original = process.env;
afterEach(() => {
  process.env = original;
  jest.restoreAllMocks();
});
test('operator inventory requires admin and never exposes control tokens', async () => {
  await request(app).get('/workers').expect(403);
  process.env = {
    ...original,
    MCPHUB_WORKERS: JSON.stringify({
      atlas: {
        catalog: 'atlas',
        url: 'ws://atlas:3100/stdio',
        token: 'secret-control-token'.repeat(3),
      },
    }),
  };
  jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(
      new Response(
        JSON.stringify({ catalog: 'atlas', processes: [{ name: 'atlas::fetch', pid: 123 }] }),
      ),
    );
  const result = await request(app).get('/workers').set('x-test-admin', '1').expect(200);
  expect(result.body.data[0]).toMatchObject({
    id: 'atlas',
    status: 'connected',
    processes: [{ name: 'atlas::fetch', pid: 123 }],
  });
  expect(JSON.stringify(result.body)).not.toContain('secret-control-token');
});
test('an unavailable or mismatched worker is reported offline rather than as zero processes', async () => {
  process.env = {
    ...original,
    MCPHUB_WORKERS: JSON.stringify({
      atlas: { catalog: 'atlas', url: 'ws://atlas:3100/stdio', token: 'x'.repeat(40) },
    }),
  };
  jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ catalog: 'toolathlon', processes: [] })));
  const result = await request(app).get('/workers').set('x-test-admin', '1').expect(200);
  expect(result.body.data[0]).toEqual({ id: 'atlas', catalog: 'atlas', status: 'disconnected' });
});

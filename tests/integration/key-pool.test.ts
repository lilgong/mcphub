import express from 'express';
import request from 'supertest';
import { forwardKeyPool } from '../../src/controllers/keyPoolController.js';
import { keyPoolService, keyPoolToken } from '../../src/services/keyPoolService.js';
const app = express();
app.post('/internal/v1/key-pool/:name', express.json(), forwardKeyPool);
describe('internal key pool capability boundary', () => {
  afterEach(() => jest.restoreAllMocks());
  test('rejects missing and cross-server capabilities before forwarding', async () => {
    const spy = jest.spyOn(keyPoolService, 'request');
    await request(app)
      .post('/internal/v1/key-pool/context7')
      .send({ url: 'https://context7.com/api/test' })
      .expect(403);
    await request(app)
      .post('/internal/v1/key-pool/twelvedata')
      .set('Authorization', `Bearer ${keyPoolToken('context7')}`)
      .send({ url: 'https://api.twelvedata.com/price' })
      .expect(403);
    expect(spy).not.toHaveBeenCalled();
  });
  test('valid capability forwards safely and suppresses raw network errors', async () => {
    const spy = jest
      .spyOn(keyPoolService, 'request')
      .mockResolvedValueOnce({ status: 200, headers: {}, body: '{}' })
      .mockRejectedValueOnce(new Error('url-with-private-key'));
    const token = keyPoolToken('context7');
    const result = await request(app)
      .post('/internal/v1/key-pool/context7')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://context7.com/api/test' })
      .expect(200);
    expect(result.body.status).toBe(200);
    const failure = await request(app)
      .post('/internal/v1/key-pool/context7')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://context7.com/api/test' })
      .expect(502);
    expect(JSON.stringify(failure.body)).not.toContain('private-key');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

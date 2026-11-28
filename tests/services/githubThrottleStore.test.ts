const mockGet = jest.fn();
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getCredentialBindingDao: () => ({ get: mockGet }),
}));
jest.mock('../../src/services/credentialBindingService.js', () => ({
  decryptCredentialValues: async (record: { fixture: unknown }) => ({
    payload: JSON.stringify(record.fixture),
  }),
  encryptCredentialValues: jest.fn(),
}));
import { githubThrottleStore } from '../../src/services/githubThrottleStore.js';

const legacy = { cooldownUntil: 0, nextWriteAt: 0, failures: 0 };

test('legacy throttle state remains readable without a write history', async () => {
  mockGet.mockResolvedValue({ fixture: legacy });
  expect(await githubThrottleStore.load('123')).toEqual(legacy);
});

test('stored write history is retained when loading account state', async () => {
  const state = { ...legacy, writeTimes: [1000, 2000] };
  mockGet.mockResolvedValue({ fixture: state });
  expect(await githubThrottleStore.load('123')).toEqual(state);
});

test.each([[2000, 1000], [-1], [0.5], Array(501).fill(1)])(
  'invalid persisted write history fails closed (%j)',
  async (...writeTimes) => {
    mockGet.mockResolvedValue({ fixture: { ...legacy, writeTimes } });
    await expect(githubThrottleStore.load('123')).rejects.toThrow('Invalid GitHub write history');
  },
);

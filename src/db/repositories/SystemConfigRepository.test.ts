import { TypeORMError } from 'typeorm';
import { SystemConfig } from '../entities/SystemConfig.js';

const disconnectedRepository = {
  findOne: jest.fn<() => Promise<SystemConfig | null>>(),
};
const reconnectedRepository = {
  findOne: jest.fn<() => Promise<SystemConfig | null>>(),
};

let activeRepository: typeof disconnectedRepository | typeof reconnectedRepository;

const getAppDataSourceMock = jest.fn(() => ({
  getRepository: jest.fn(() => activeRepository),
}));
const reconnectDatabaseMock = jest.fn(async () => {
  activeRepository = reconnectedRepository;
});

const healthCheckMock = jest.fn(async () => false);

jest.mock('../connection.js', () => ({
  getAppDataSource: getAppDataSourceMock,
  reconnectDatabase: reconnectDatabaseMock,
  checkDatabaseHealth: healthCheckMock,
}));

import { SystemConfigRepository } from './SystemConfigRepository.js';

describe('SystemConfigRepository connection recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeRepository = disconnectedRepository;
  });

  it('reconnects and retries when TypeORM reports that its driver is disconnected', async () => {
    const storedConfig = Object.assign(new SystemConfig(), {
      id: 'default',
      routing: {},
      smartRouting: {},
    });
    disconnectedRepository.findOne.mockRejectedValueOnce(new TypeORMError('Driver not Connected'));
    reconnectedRepository.findOne.mockResolvedValueOnce(storedConfig);

    const repository = new SystemConfigRepository();

    await expect(repository.get()).resolves.toBe(storedConfig);
    expect(reconnectDatabaseMock).toHaveBeenCalledTimes(1);
    expect(disconnectedRepository.findOne).toHaveBeenCalledTimes(1);
    expect(reconnectedRepository.findOne).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect for non-connection errors', async () => {
    const queryError = new Error('invalid system config query');
    disconnectedRepository.findOne.mockRejectedValueOnce(queryError);

    const repository = new SystemConfigRepository();

    await expect(repository.get()).rejects.toBe(queryError);
    expect(reconnectDatabaseMock).not.toHaveBeenCalled();
  });
  it('does not destroy the business pool for a connection acquisition timeout', async () => {
    const config = Object.assign(new SystemConfig(), { id: 'default' });
    disconnectedRepository.findOne
      .mockRejectedValueOnce(new Error('connection timeout exceeded'))
      .mockResolvedValueOnce(config);
    await expect(new SystemConfigRepository().get()).resolves.toBe(config);
    expect(reconnectDatabaseMock).not.toHaveBeenCalled();
    expect(healthCheckMock).toHaveBeenCalledTimes(1);
  });
});

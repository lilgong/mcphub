import { ConnectionIsNotSetError, TypeORMError } from 'typeorm';

const dataSources: Array<{
  options: Record<string, unknown>;
  isInitialized: boolean;
  initialize: jest.Mock;
  destroy: jest.Mock;
  query: jest.Mock;
}> = [];

jest.mock('typeorm', () => {
  const actual = jest.requireActual<typeof import('typeorm')>('typeorm');

  return {
    ...actual,
    DataSource: jest.fn().mockImplementation((options: Record<string, unknown>) => {
      const dataSource = {
        options,
        driver: {
          obtainMasterConnection: jest.fn(async () => 'connection'),
          obtainSlaveConnection: jest.fn(async () => 'replica'),
        },
        isInitialized: false,
        setOptions: jest.fn((updates) => Object.assign(options, updates)),
        synchronize: jest.fn(async () => {}),
        initialize: jest.fn(async function (this: { isInitialized: boolean }) {
          if (this.isInitialized) {
            throw new Error('Cannot connect because the DataSource is already initialized');
          }
          this.isInitialized = true;
          return this;
        }),
        destroy: jest.fn(async function (this: { isInitialized: boolean }) {
          this.isInitialized = false;
        }),
        query: jest.fn(async (sql: string) =>
          sql.includes('to_regclass') ? [{ exists: false }] : [],
        ),
      };
      dataSources.push(dataSource);
      return dataSource;
    }),
  };
});

const getSmartRoutingConfigMock = jest.fn(async () => ({
  dbUrl: 'postgresql://mcphub:test@postgres:5432/mcphub',
}));

jest.mock('../utils/smartRouting.js', () => ({
  getSmartRoutingConfig: getSmartRoutingConfigMock,
}));

jest.mock('../services/vectorSearchService.js', () => ({
  createVectorIndex: jest.fn(async () => ({ success: true })),
}));

jest.mock('./types/postgresVectorType.js', () => ({
  registerPostgresVectorType: jest.fn(),
}));

import {
  checkDatabaseHealth,
  closeDatabase,
  initializeDatabase,
  reconnectDatabase,
  stopHealthCheck,
  getAppDataSource,
  updateDataSourceConfig,
} from './connection.js';
import { registerPostgresVectorType } from './types/postgresVectorType.js';

const registerPostgresVectorTypeMock = jest.mocked(registerPostgresVectorType);

describe('database connection recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    stopHealthCheck();
    await closeDatabase();
  });

  it('reuses the existing configuration when recovering an uninitialized or disconnected driver', async () => {
    const dataSource = await updateDataSourceConfig();

    await expect(checkDatabaseHealth()).resolves.toBe(true);
    expect(dataSource.initialize).toHaveBeenCalledTimes(1);

    dataSource.query.mockRejectedValueOnce(new TypeORMError('Driver not Connected'));

    await expect(checkDatabaseHealth()).resolves.toBe(true);
    expect(dataSource.destroy).toHaveBeenCalledTimes(1);
    expect(dataSource.initialize).toHaveBeenCalledTimes(2);
    expect(getSmartRoutingConfigMock).toHaveBeenCalledTimes(1);
  });

  it('shares one reconnection attempt with concurrent initialization callers', async () => {
    const dataSource = await updateDataSourceConfig();
    let finishInitialization!: () => void;
    dataSource.initialize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishInitialization = () => {
            dataSource.isInitialized = true;
            resolve(dataSource);
          };
        }),
    );

    const firstReconnect = reconnectDatabase();
    const secondReconnect = reconnectDatabase();
    const concurrentInitialization = initializeDatabase();

    await new Promise((resolve) => setImmediate(resolve));
    const initializationCallsBeforeRelease = dataSource.initialize.mock.calls.length;
    finishInitialization();

    await expect(
      Promise.all([firstReconnect, secondReconnect, concurrentInitialization]),
    ).resolves.toEqual([dataSource, dataSource, dataSource]);
    expect(initializationCallsBeforeRelease).toBe(1);
    expect(dataSource.initialize).toHaveBeenCalledTimes(1);
  });

  it('cleans up an initialized connection when post-initialization setup fails', async () => {
    jest.useFakeTimers();
    const dataSource = await updateDataSourceConfig();
    registerPostgresVectorTypeMock.mockImplementationOnce(() => {
      throw new Error('vector type registration failed');
    });

    try {
      const recovery = reconnectDatabase();
      await jest.runAllTimersAsync();

      await expect(recovery).resolves.toBe(dataSource);
      expect(dataSource.initialize).toHaveBeenCalledTimes(2);
      expect(dataSource.destroy).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers when the driver pool is gone but TypeORM still reports the DataSource as initialized', async () => {
    jest.useFakeTimers();
    const dataSource = await updateDataSourceConfig();
    dataSource.isInitialized = true;
    dataSource.destroy.mockRejectedValueOnce(new ConnectionIsNotSetError('postgres'));

    try {
      const recovery = reconnectDatabase();
      await jest.runAllTimersAsync();

      const recovered = await recovery;
      expect(recovered).not.toBe(dataSource);
      expect(recovered.isInitialized).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the recovered connection usable when the old destroy finishes late', async () => {
    jest.useFakeTimers();
    const oldSource = await updateDataSourceConfig();
    oldSource.isInitialized = true;
    let finishDestroy!: () => void;
    oldSource.destroy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDestroy = () => {
            oldSource.isInitialized = false;
            resolve();
          };
        }),
    );
    try {
      const recovery = reconnectDatabase();
      await jest.runAllTimersAsync();
      const recovered = await recovery;
      finishDestroy();
      await Promise.resolve();
      expect(recovered.isInitialized).toBe(true);
      expect(await initializeDatabase()).toBe(recovered);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bails out of a hung pool destroy instead of wedging reconnection forever', async () => {
    jest.useFakeTimers();
    const dataSource = await updateDataSourceConfig();
    dataSource.isInitialized = true;
    // Simulate a checked-out client stuck in an open transaction (idle in
    // transaction): pg-pool end() would wait for it forever.
    dataSource.destroy.mockReturnValueOnce(new Promise(() => {}));

    try {
      const recovery = reconnectDatabase();
      await jest.runAllTimersAsync();

      const recovered = await recovery;
      expect(recovered).not.toBe(dataSource);
      expect(recovered.isInitialized).toBe(true);
      expect(dataSource.destroy).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves the pool on one slow probe and recovers only after three consecutive timeouts', async () => {
    jest.useFakeTimers();
    const dataSource = await updateDataSourceConfig();
    dataSource.isInitialized = true;
    dataSource.query.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes('SELECT 1')) {
        return new Promise(() => {});
      }
      if (text.includes('to_regclass')) {
        return Promise.resolve([{ exists: false }]);
      }
      return Promise.resolve([]);
    });

    try {
      const health = checkDatabaseHealth();
      await jest.runAllTimersAsync();

      await expect(health).resolves.toBe(false);
      expect(dataSource.destroy).not.toHaveBeenCalled();
      for (let i = 0; i < 2; i++) {
        const next = checkDatabaseHealth();
        await jest.runAllTimersAsync();
        await next;
      }
      expect(dataSource.query.mock.calls.filter(([sql]) => sql === 'SELECT 1')).toHaveLength(1);
      expect(dataSource.destroy).toHaveBeenCalledTimes(1);
      expect(dataSource.initialize).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
  it('pauses pool acquisition during recovery and resumes after initialization', async () => {
    const source = await updateDataSourceConfig();
    source.isInitialized = true;
    await reconnectDatabase(); // installs the acquisition guard
    const acquire = getAppDataSource().driver.obtainMasterConnection;
    let finish!: () => void;
    source.destroy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            source.isInitialized = false;
            resolve();
          };
        }),
    );
    const recovery = reconnectDatabase();
    let completed = false;
    const waiting = acquire().then(() => {
      completed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    finish();
    await recovery;
    await waiting;
    expect(completed).toBe(true);
  });

  it('bounds waiting for a stuck recovery without acquiring from the closing pool', async () => {
    jest.useFakeTimers();
    const source = await updateDataSourceConfig();
    source.isInitialized = true;
    await reconnectDatabase();
    source.destroy.mockReturnValueOnce(new Promise(() => {}));
    try {
      const recovery = reconnectDatabase();
      const waiting = getAppDataSource().driver.obtainMasterConnection();
      const rejected = expect(waiting).rejects.toMatchObject({
        name: 'DatabaseRecoveringError',
        status: 503,
      });
      await jest.advanceTimersByTimeAsync(10000);
      await rejected;
      await jest.runAllTimersAsync();
      await recovery;
    } finally {
      jest.useRealTimers();
    }
  });
  it('shares one pending probe and clears timeout history after it recovers', async () => {
    jest.useFakeTimers();
    const source = await updateDataSourceConfig();
    source.isInitialized = true;
    let resolveProbe!: () => void;
    source.query.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveProbe = resolve;
      }),
    );
    try {
      const first = checkDatabaseHealth();
      expect(checkDatabaseHealth()).toBe(first);
      await jest.advanceTimersByTimeAsync(5000);
      await expect(first).resolves.toBe(false);
      expect(source.destroy).not.toHaveBeenCalled();
      const second = checkDatabaseHealth();
      resolveProbe();
      await expect(second).resolves.toBe(true);
      expect(source.query).toHaveBeenCalledTimes(1);
      source.query.mockReturnValueOnce(new Promise(() => {}));
      const third = checkDatabaseHealth();
      await jest.advanceTimersByTimeAsync(5000);
      await expect(third).resolves.toBe(false);
      expect(source.destroy).not.toHaveBeenCalled();
      // Resolve the two remaining timeout rounds to avoid leaking module state.
      for (let i = 0; i < 2; i++) {
        const check = checkDatabaseHealth();
        await jest.runAllTimersAsync();
        await check;
      }
    } finally {
      jest.useRealTimers();
    }
  });
});

// Global test setup
import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Unit/integration tests must never load deployment credentials or write into
// the production audit directory just because a checkout has a local .env.
jest.mock('dotenv', () => ({
  ...jest.requireActual('dotenv'),
  config: jest.fn(() => ({ parsed: {} })),
}));
const testRuntime = mkdtempSync(join(tmpdir(), 'mcphub-jest-'));
const testSettings = join(testRuntime, 'mcp_settings.json');
writeFileSync(
  testSettings,
  JSON.stringify({ mcpServers: {}, users: [], groups: {}, systemConfig: {} }),
);
process.env.MCPHUB_SETTING_PATH = testSettings;
process.env.MCPHUB_AUDIT_LOG_DIR = join(testRuntime, 'audit');
process.env.MCPHUB_KEY_POOL_LOG_DIR = join(testRuntime, 'key-pool');
process.env.MCP_USAGE_LOG_DIR = join(testRuntime, 'usage');
process.env.MCPHUB_RELAY_LOG_FILE = join(testRuntime, 'relay.jsonl');
afterAll(() => rmSync(testRuntime, { recursive: true, force: true }));

// Mock environment variables for testing
Object.assign(process.env, {
  NODE_ENV: 'test',
  JWT_SECRET: 'test-jwt-secret-key',
  DB_URL: 'sqlite::memory:',
});

// Mock moduleDir to avoid import.meta parsing issues in Jest
jest.mock('../src/utils/moduleDir.js', () => ({
  getCurrentModuleDir: jest.fn(() => process.cwd()),
}));

// Global test utilities
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toBeValidDate(): R;
      toBeValidUUID(): R;
    }
  }
}

// Custom matchers
expect.extend({
  toBeValidDate(received: any) {
    const pass = received instanceof Date && !isNaN(received.getTime());
    if (pass) {
      return {
        message: () => `expected ${received} not to be a valid date`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be a valid date`,
        pass: false,
      };
    }
  },

  toBeValidUUID(received: any) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const pass = typeof received === 'string' && uuidRegex.test(received);
    if (pass) {
      return {
        message: () => `expected ${received} not to be a valid UUID`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be a valid UUID`,
        pass: false,
      };
    }
  },
});

// Increase timeout for async operations
jest.setTimeout(10000);

// Mock console methods to reduce noise in tests
const originalError = console.error;
const originalWarn = console.warn;

beforeAll(() => {
  console.error = jest.fn();
  console.warn = jest.fn();
});

afterAll(() => {
  console.error = originalError;
  console.warn = originalWarn;
});

// Clear all mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});

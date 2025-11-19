import { beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Mock environment variables for testing first
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'file::memory:';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-key-for-testing-only';
process.env.SESSION_SECRET = 'test-session-secret-key-for-testing-only';
process.env.REDIS_URL = 'redis://localhost:6379/1'; // Use database 1 for tests

// Mock ioredis
vi.mock('ioredis', () => {
  const Redis = vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    disconnect: vi.fn(),
    quit: vi.fn(),
  }));
  return { default: Redis };
});

// Global test setup
beforeAll(async () => {
  // Setup test database
  console.log('Setting up test environment...');
});

afterAll(async () => {
  // Cleanup test database
  console.log('Cleaning up test environment...');
  const { sqliteDb } = await import('../server/db');
  if (sqliteDb) {
    sqliteDb.close();
  }
});

beforeEach(async () => {
  // Reset database state before each test
});

afterEach(async () => {
  // Cleanup after each test
});

// Mock external services
global.fetch = vi.fn();

// Mock console methods to reduce noise during tests
global.console = {
  ...console,
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

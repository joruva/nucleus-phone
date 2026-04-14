jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());

const { pool } = require('../../db');

let logEvent, flush;

beforeEach(() => {
  jest.useFakeTimers();
  delete process.env.DEBUG;
  jest.isolateModules(() => {
    ({ logEvent, flush } = require('../debug-log'));
  });
});

afterEach(() => {
  delete process.env.DEBUG;
  jest.useRealTimers();
  pool.query.mockReset();
});

describe('debug-log', () => {
  test('logEvent is no-op when DEBUG is not set', () => {
    logEvent('test', 'unit', 'should not buffer');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('logEvent is no-op when DEBUG is 0', () => {
    process.env.DEBUG = '0';
    jest.isolateModules(() => {
      const mod = require('../debug-log');
      mod.logEvent('test', 'unit', 'should not buffer');
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('buffers events and flushes on interval', async () => {
    process.env.DEBUG = '1';
    jest.isolateModules(() => {
      ({ logEvent, flush } = require('../debug-log'));
    });

    logEvent('webhook', 'sim.webhook', 'test event 1');
    logEvent('error', 'rbac', 'test event 2', { level: 'error', caller: 'tom' });

    // No INSERT yet — still buffered
    expect(pool.query).not.toHaveBeenCalled();

    // Advance past the 2s flush interval
    jest.advanceTimersByTime(2100);

    // flush is async, need to let microtasks settle
    await Promise.resolve();

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO debug_events');
    expect(params).toContain('webhook');
    expect(params).toContain('sim.webhook');
    expect(params).toContain('test event 1');
    expect(params).toContain('error');
    expect(params).toContain('rbac');
    expect(params).toContain('tom');
  });

  test('flush() drains buffer immediately', async () => {
    process.env.DEBUG = '1';
    jest.isolateModules(() => {
      ({ logEvent, flush } = require('../debug-log'));
    });

    logEvent('test', 'unit', 'flush me');
    await flush();

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toContain('INSERT INTO debug_events');
  });

  test('failed INSERT drops buffer and warns', async () => {
    process.env.DEBUG = '1';
    jest.isolateModules(() => {
      ({ logEvent, flush } = require('../debug-log'));
    });

    pool.query.mockRejectedValueOnce(new Error('connection refused'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    logEvent('test', 'unit', 'will fail');
    await flush();

    expect(warnSpy).toHaveBeenCalled();
    const warnArgs = warnSpy.mock.calls[0].join(' ');
    expect(warnArgs).toContain('batch INSERT failed');
    expect(warnArgs).toContain('connection refused');
    warnSpy.mockRestore();

    // Second flush should have nothing to insert
    pool.query.mockReset();
    await flush();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('flush() with empty buffer is a no-op', async () => {
    process.env.DEBUG = '1';
    jest.isolateModules(() => {
      ({ logEvent, flush } = require('../debug-log'));
    });

    await flush();
    expect(pool.query).not.toHaveBeenCalled();
  });
});

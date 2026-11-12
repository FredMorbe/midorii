import { afterEach, describe, expect, it, vi } from 'vitest';
import { capitalAccount, capitalEnvironment, capitalOpenPosition, capitalPositions, capitalWorkingOrders, configureCapital } from '../app/electron/data/capital.js';

const credentials = { apiKey: 'test-key', identifier: 'test-user', password: 'test-password', env: 'demo' };
afterEach(() => { configureCapital(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Capital connection fencing', () => {
  it('refuses a bot request bound to an earlier connection before any network call', async () => {
    configureCapital(credentials);
    const revision = capitalEnvironment().revision;
    configureCapital({ ...credentials, env: 'live' });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(capitalOpenPosition({ epic: 'EURUSD', direction: 'BUY', size: 1 }, revision)).rejects.toThrow(/connection changed/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects an old login completing after credentials changed without sending an order', async () => {
    configureCapital(credentials);
    let release;
    const fetcher = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const request = capitalOpenPosition({ epic: 'EURUSD', direction: 'BUY', size: 1 });
    const rejected = expect(request).rejects.toThrow(/connection changed/);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    configureCapital({ ...credentials, env: 'live' });
    release({ ok: true, headers: new Headers({ cst: 'test', 'x-security-token': 'test' }) });
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});


describe('Capital session account and request budget', () => {
  it('uses the active session account instead of guessing from preferred accounts', async () => {
    configureCapital(credentials);
    const fetcher = vi.fn(async (url, options) => {
      if (url.endsWith('/session') && options.method === 'POST') return Response.json({ currentAccountId: 'active' }, { headers: { cst: 'test', 'x-security-token': 'test' } });
      if (url.endsWith('/session')) return Response.json({ accountId: 'active' });
      return Response.json({ accounts: [{ accountId: 'preferred', preferred: true }, { accountId: 'active', preferred: false }] });
    });
    vi.stubGlobal('fetch', fetcher);
    expect((await capitalAccount()).accountId).toBe('active');
  });

  it('paces concurrent account reads and applies a finite request timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10_000);
    configureCapital(credentials);
    const started = [];
    const fetcher = vi.fn(async (_url, options) => {
      started.push(Date.now());
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ positions: [], currentAccountId: 'active' }, { headers: { cst: 'test', 'x-security-token': 'test' } });
    });
    vi.stubGlobal('fetch', fetcher);
    const requests = Promise.all(Array.from({ length: 6 }, () => capitalPositions()));
    await vi.runAllTimersAsync();
    await requests;
    expect(started).toHaveLength(7);
    for (let i = 1; i < started.length; i++) expect(started[i] - started[i - 1]).toBeGreaterThanOrEqual(120);
  });
});


it('invalidates the armed revision if re-login selects a different financial account', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 20_000);
  configureCapital(credentials);
  let logins = 0;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.endsWith('/session') && options.method === 'POST') {
      logins += 1;
      return Response.json({ currentAccountId: logins === 1 ? 'account-a' : 'account-b' }, { headers: { cst: 'test', 'x-security-token': 'test' } });
    }
    return new Response('', { status: 401 });
  }));
  const revision = capitalEnvironment().revision;
  const rejected = expect(capitalPositions()).rejects.toThrow(/account.*changed|connection changed/i);
  await vi.runAllTimersAsync();
  await rejected;
  expect(capitalEnvironment().revision).not.toBe(revision);
});


it.each(['positions', 'workingOrders'])('rejects a malformed %s snapshot instead of reporting no exposure', async endpoint => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 60_000);
  configureCapital(credentials);
  vi.stubGlobal('fetch', vi.fn(async url => url.endsWith('/session')
    ? Response.json({ currentAccountId: 'active' }, { headers: { cst: 'test', 'x-security-token': 'test' } })
    : Response.json({})));
  const rejected = expect(endpoint === 'positions' ? capitalPositions() : capitalWorkingOrders()).rejects.toThrow(/invalid.*list/i);
  await vi.runAllTimersAsync();
  await rejected;
});


describe('transport deadline behavior', () => {
  it.each(['login', 'create'])('aborts a stalled %s without blindly retrying a delivered order', async stalled => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 120_000);
    configureCapital(credentials);
    const deadlines = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      deadlines.push(ms);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('transport deadline', 'TimeoutError')), ms);
      return controller.signal;
    });
    let offline = true;
    const fetcher = vi.fn(async (url, options) => {
      const login = url.endsWith('/session');
      if (offline && (stalled === 'login' ? login : !login)) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      }
      if (login) return Response.json({ currentAccountId: 'active' }, { headers: { cst: 'test', 'x-security-token': 'test' } });
      return Response.json({ positions: [] });
    });
    vi.stubGlobal('fetch', fetcher);
    const rejected = expect(capitalOpenPosition({ epic: 'EURUSD', direction: 'BUY', size: 1 })).rejects.toThrow(/transport deadline/);
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetcher.mock.calls.filter(([, options]) => options.method === 'POST' && options.body?.includes('EURUSD'))).toHaveLength(stalled === 'login' ? 0 : 1);
    expect(deadlines.every(ms => ms === 15_000)).toBe(true);
    offline = false;
    const reading = capitalPositions();
    await vi.runAllTimersAsync();
    expect(await reading).toEqual([]);
  });
});

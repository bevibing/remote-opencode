import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const mockSetGlobalDispatcher = vi.fn();
const mockEnvHttpProxyAgent = vi.fn((options: unknown) => ({ options }));

async function loadProxySupport() {
  vi.resetModules();
  vi.doMock('undici', () => ({
    EnvHttpProxyAgent: class MockEnvHttpProxyAgent {
      constructor(options: unknown) {
        return mockEnvHttpProxyAgent(options);
      }
    },
    setGlobalDispatcher: mockSetGlobalDispatcher,
  }));

  return import('../services/proxySupport.js');
}

describe('proxySupport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('does nothing when no proxy environment variables are set', async () => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.all_proxy;

    const { initializeProxySupport } = await loadProxySupport();

    expect(initializeProxySupport()).toBe(false);
    expect(mockEnvHttpProxyAgent).not.toHaveBeenCalled();
    expect(mockSetGlobalDispatcher).not.toHaveBeenCalled();
  });

  it('initializes dispatcher when only HTTPS_PROXY is set', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.internal:8443';

    const { initializeProxySupport } = await loadProxySupport();

    expect(initializeProxySupport()).toBe(true);
    expect(mockEnvHttpProxyAgent).toHaveBeenCalledWith({
      httpsProxy: 'http://proxy.internal:8443',
      noProxy: 'localhost,127.0.0.1,::1',
    });
    expect(mockSetGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it('falls back to ALL_PROXY for both http and https requests', async () => {
    process.env.ALL_PROXY = 'http://proxy.internal:8080';

    const { initializeProxySupport } = await loadProxySupport();

    initializeProxySupport();

    expect(mockEnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://proxy.internal:8080',
      httpsProxy: 'http://proxy.internal:8080',
      noProxy: 'localhost,127.0.0.1,::1',
    });
  });

  it('merges existing NO_PROXY entries with loopback defaults', async () => {
    process.env.HTTP_PROXY = 'http://proxy.internal:8080';
    process.env.NO_PROXY = 'internal.example.com, localhost  ,10.0.0.5';

    const { initializeProxySupport } = await loadProxySupport();

    initializeProxySupport();

    expect(mockEnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://proxy.internal:8080',
      httpsProxy: 'http://proxy.internal:8080',
      noProxy: 'internal.example.com,localhost,10.0.0.5,127.0.0.1,::1',
    });
  });

  it('initializes the dispatcher only once', async () => {
    process.env.HTTP_PROXY = 'http://proxy.internal:8080';

    const { initializeProxySupport, resetProxySupportForTests } = await loadProxySupport();

    expect(initializeProxySupport()).toBe(true);
    expect(initializeProxySupport()).toBe(false);
    expect(mockSetGlobalDispatcher).toHaveBeenCalledTimes(1);

    resetProxySupportForTests();
    expect(initializeProxySupport()).toBe(true);
    expect(mockSetGlobalDispatcher).toHaveBeenCalledTimes(2);
  });
});

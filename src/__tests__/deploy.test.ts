import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  const mockPut = vi.fn(async () => {
    order.push('put');
  });
  const mockSetToken = vi.fn(function (this: unknown) {
    return this;
  });

  return {
    order,
    mockPut,
    mockSetToken,
    RESTMock: vi.fn(() => ({
      setToken: mockSetToken,
      put: mockPut,
    })),
    initializeProxySupport: vi.fn(() => {
      order.push('proxy');
    }),
  };
});

vi.mock('discord.js', () => ({
  REST: class MockREST {
    constructor() {
      mocks.RESTMock();
      return {
        setToken: mocks.mockSetToken,
        put: mocks.mockPut,
      };
    }
  },
  Routes: {
    applicationGuildCommands: vi.fn(() => '/applications/client-id/guilds/guild-id/commands'),
  },
}));

vi.mock('../services/configStore.js', () => ({
  getBotConfig: vi.fn(() => ({
    discordToken: 'discord-token',
    clientId: 'client-id',
    guildId: 'guild-id',
  })),
}));

vi.mock('../commands/index.js', () => ({
  commands: new Map([
    ['ping', { data: { toJSON: () => ({ name: 'ping' }) } }],
  ]),
}));

vi.mock('../services/proxySupport.js', () => ({
  initializeProxySupport: mocks.initializeProxySupport,
}));

describe('deployCommands', () => {
  beforeEach(() => {
    mocks.order.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes proxy support before deploying commands', async () => {
    const { deployCommands } = await import('../setup/deploy.js');

    await deployCommands();

    expect(mocks.order).toEqual(['proxy', 'put']);
    expect(mocks.initializeProxySupport).toHaveBeenCalledTimes(1);
    expect(mocks.mockSetToken).toHaveBeenCalledWith('discord-token');
    expect(mocks.mockPut).toHaveBeenCalledTimes(1);
  });
});

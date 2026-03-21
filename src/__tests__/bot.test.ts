import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  const mockLogin = vi.fn(async () => {
    order.push('login');
  });
  const mockOnce = vi.fn();
  const mockOn = vi.fn();
  const mockDestroy = vi.fn();
  const mockClient = {
    once: mockOnce,
    on: mockOn,
    login: mockLogin,
    destroy: mockDestroy,
  };

  return {
    order,
    mockLogin,
    mockOnce,
    mockOn,
    mockDestroy,
    mockClient,
    ClientMock: vi.fn(() => mockClient),
    initializeProxySupport: vi.fn(() => {
      order.push('proxy');
    }),
  };
});

vi.mock('discord.js', () => ({
  Client: class MockClient {
    constructor() {
      mocks.ClientMock();
      return mocks.mockClient;
    }
  },
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
  },
  Events: {
    ClientReady: 'ready',
    InteractionCreate: 'interactionCreate',
    MessageCreate: 'messageCreate',
  },
}));

vi.mock('../services/configStore.js', () => ({
  getBotConfig: vi.fn(() => ({
    discordToken: 'discord-token',
    clientId: 'client-id',
    guildId: 'guild-id',
  })),
}));

vi.mock('../handlers/interactionHandler.js', () => ({
  handleInteraction: vi.fn(),
}));

vi.mock('../handlers/messageHandler.js', () => ({
  handleMessageCreate: vi.fn(),
}));

vi.mock('../services/serveManager.js', () => ({
  stopAll: vi.fn(),
}));

vi.mock('../services/proxySupport.js', () => ({
  initializeProxySupport: mocks.initializeProxySupport,
}));

vi.mock('../commands/model.js', () => ({
  getCachedModels: vi.fn(),
}));

describe('startBot', () => {
  beforeEach(() => {
    mocks.order.length = 0;
    vi.clearAllMocks();
    vi.spyOn(process, 'on').mockImplementation(() => process);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes proxy support before logging in to Discord', async () => {
    const { startBot } = await import('../bot.js');

    await startBot();

    expect(mocks.order).toEqual(['proxy', 'login']);
    expect(mocks.initializeProxySupport).toHaveBeenCalledTimes(1);
    expect(mocks.mockLogin).toHaveBeenCalledWith('discord-token');
  });
});

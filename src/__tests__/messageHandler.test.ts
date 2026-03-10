import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/dataStore.js');
vi.mock('../services/executionService.js');
vi.mock('../services/queueManager.js');
vi.mock('../services/configStore.js');
vi.mock('../services/voiceService.js');

import { handleMessageCreate } from '../handlers/messageHandler.js';
import * as dataStore from '../services/dataStore.js';
import * as executionService from '../services/executionService.js';
import * as queueManager from '../services/queueManager.js';
import * as configStore from '../services/configStore.js';
import * as voiceService from '../services/voiceService.js';
import { MessageFlags } from 'discord.js';

function createMockMessage(overrides: Record<string, unknown> = {}) {
  const reactFn = vi.fn().mockResolvedValue(undefined);
  const replyFn = vi.fn().mockResolvedValue(undefined);
  const removeFn = vi.fn().mockResolvedValue(undefined);

  return {
    author: { bot: false, id: 'user-1' },
    system: false,
    content: '',
    channel: {
      isThread: () => true,
      id: 'thread-1',
      parentId: 'channel-1',
    },
    flags: {
      has: vi.fn().mockReturnValue(false),
    },
    attachments: {
      first: vi.fn().mockReturnValue(undefined),
    },
    react: reactFn,
    reply: replyFn,
    reactions: {
      cache: {
        get: vi.fn().mockReturnValue({
          users: { remove: removeFn },
        }),
      },
    },
    client: { user: { id: 'bot-user-id' } },
    ...overrides,
  } as any;
}

describe('messageHandler - voice messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dataStore.isPassthroughEnabled).mockReturnValue(true);
    vi.mocked(configStore.isAuthorized).mockReturnValue(true);
    vi.mocked(queueManager.isBusy).mockReturnValue(false);
    vi.mocked(voiceService.isVoiceEnabled).mockReturnValue(true);
  });

  describe('voice message detection', () => {
    it('should detect and transcribe a voice message successfully', async () => {
      const msg = createMockMessage();
      msg.flags.has.mockImplementation((flag: number) => flag === MessageFlags.IsVoiceMessage);
      msg.attachments.first.mockReturnValue({ url: 'https://cdn.discord/voice.ogg', size: 1024 });
      vi.mocked(voiceService.transcribe).mockResolvedValue('Hello from voice');

      await handleMessageCreate(msg);

      expect(voiceService.transcribe).toHaveBeenCalledWith('https://cdn.discord/voice.ogg', 1024);
      expect(msg.react).toHaveBeenCalledWith('🎙️');
      expect(executionService.runPrompt).toHaveBeenCalledWith(
        msg.channel,
        'thread-1',
        'Hello from voice',
        'channel-1',
      );
    });

    it('should ignore voice messages when voice is not enabled', async () => {
      vi.mocked(voiceService.isVoiceEnabled).mockReturnValue(false);
      const msg = createMockMessage();
      msg.flags.has.mockReturnValue(true);
      msg.attachments.first.mockReturnValue({ url: 'https://cdn.discord/voice.ogg', size: 1024 });

      await handleMessageCreate(msg);

      expect(voiceService.transcribe).not.toHaveBeenCalled();
      expect(executionService.runPrompt).not.toHaveBeenCalled();
    });

    it('should ignore non-voice messages with empty content', async () => {
      const msg = createMockMessage();
      // Not a voice message, no content
      msg.flags.has.mockReturnValue(false);

      await handleMessageCreate(msg);

      expect(voiceService.transcribe).not.toHaveBeenCalled();
      expect(executionService.runPrompt).not.toHaveBeenCalled();
    });
  });

  describe('voice message queuing when busy', () => {
    it('should queue voice attachment metadata when thread is busy', async () => {
      vi.mocked(queueManager.isBusy).mockReturnValue(true);
      const msg = createMockMessage();
      msg.flags.has.mockImplementation((flag: number) => flag === MessageFlags.IsVoiceMessage);
      msg.attachments.first.mockReturnValue({ url: 'https://cdn.discord/voice.ogg', size: 2048 });

      await handleMessageCreate(msg);

      // STT should NOT be called (deferred to dequeue time)
      expect(voiceService.transcribe).not.toHaveBeenCalled();
      // Should queue with voice metadata
      expect(dataStore.addToQueue).toHaveBeenCalledWith('thread-1', {
        prompt: '',
        userId: 'user-1',
        timestamp: expect.any(Number),
        voiceAttachmentUrl: 'https://cdn.discord/voice.ogg',
        voiceAttachmentSize: 2048,
      });
      expect(msg.react).toHaveBeenCalledWith('📥');
    });

    it('should queue text messages normally when busy', async () => {
      vi.mocked(queueManager.isBusy).mockReturnValue(true);
      const msg = createMockMessage({ content: 'text prompt' });

      await handleMessageCreate(msg);

      expect(dataStore.addToQueue).toHaveBeenCalledWith('thread-1', {
        prompt: 'text prompt',
        userId: 'user-1',
        timestamp: expect.any(Number),
      });
      expect(msg.react).toHaveBeenCalledWith('📥');
    });
  });

  describe('transcription error handling', () => {
    function setupVoiceMessage() {
      const msg = createMockMessage();
      msg.flags.has.mockImplementation((flag: number) => flag === MessageFlags.IsVoiceMessage);
      msg.attachments.first.mockReturnValue({ url: 'https://cdn.discord/voice.ogg', size: 1024 });
      return msg;
    }

    it('should show AUTH_FAILURE message and react with ❌', async () => {
      const msg = setupVoiceMessage();
      vi.mocked(voiceService.transcribe).mockRejectedValue(new Error('AUTH_FAILURE'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await handleMessageCreate(msg);

      expect(msg.react).toHaveBeenCalledWith('❌');
      expect(msg.reply).toHaveBeenCalledWith({
        content: expect.stringContaining('API key'),
      });
      expect(executionService.runPrompt).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should show generic error message for non-auth failures', async () => {
      const msg = setupVoiceMessage();
      vi.mocked(voiceService.transcribe).mockRejectedValue(new Error('Whisper API error (HTTP 500)'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await handleMessageCreate(msg);

      expect(msg.react).toHaveBeenCalledWith('❌');
      expect(msg.reply).toHaveBeenCalledWith({
        content: expect.stringContaining('Voice transcription failed'),
      });
      expect(executionService.runPrompt).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should handle empty transcription result', async () => {
      const msg = setupVoiceMessage();
      vi.mocked(voiceService.transcribe).mockResolvedValue('   ');

      await handleMessageCreate(msg);

      expect(msg.react).toHaveBeenCalledWith('❌');
      expect(executionService.runPrompt).not.toHaveBeenCalled();
    });
  });

  describe('reaction resilience', () => {
    it('should not block STT when react fails', async () => {
      const msg = createMockMessage();
      msg.flags.has.mockImplementation((flag: number) => flag === MessageFlags.IsVoiceMessage);
      msg.attachments.first.mockReturnValue({ url: 'https://cdn.discord/voice.ogg', size: 1024 });
      msg.react.mockRejectedValue(new Error('Missing Permissions'));
      vi.mocked(voiceService.transcribe).mockResolvedValue('Voice text');
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await handleMessageCreate(msg);

      // STT should still succeed despite react failure
      expect(voiceService.transcribe).toHaveBeenCalled();
      expect(executionService.runPrompt).toHaveBeenCalledWith(
        msg.channel,
        'thread-1',
        'Voice text',
        'channel-1',
      );
      consoleSpy.mockRestore();
    });

    it('should not block STT when remove reaction fails', async () => {
      const removeFn = vi.fn().mockRejectedValue(new Error('Unknown Message'));
      const msg = createMockMessage();
      msg.flags.has.mockImplementation((flag: number) => flag === MessageFlags.IsVoiceMessage);
      msg.attachments.first.mockReturnValue({ url: 'https://cdn.discord/voice.ogg', size: 1024 });
      msg.reactions.cache.get.mockReturnValue({ users: { remove: removeFn } });
      vi.mocked(voiceService.transcribe).mockResolvedValue('Voice text');
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await handleMessageCreate(msg);

      expect(executionService.runPrompt).toHaveBeenCalledWith(
        msg.channel,
        'thread-1',
        'Voice text',
        'channel-1',
      );
      consoleSpy.mockRestore();
    });
  });

  describe('non-voice message passthrough', () => {
    it('should process text messages normally', async () => {
      const msg = createMockMessage({ content: 'regular text prompt' });

      await handleMessageCreate(msg);

      expect(voiceService.transcribe).not.toHaveBeenCalled();
      expect(executionService.runPrompt).toHaveBeenCalledWith(
        msg.channel,
        'thread-1',
        'regular text prompt',
        'channel-1',
      );
    });

    it('should skip bot messages', async () => {
      const msg = createMockMessage({ author: { bot: true, id: 'bot-1' }, content: 'bot message' });

      await handleMessageCreate(msg);

      expect(executionService.runPrompt).not.toHaveBeenCalled();
    });

    it('should skip unauthorized users', async () => {
      vi.mocked(configStore.isAuthorized).mockReturnValue(false);
      const msg = createMockMessage({ content: 'unauthorized' });

      await handleMessageCreate(msg);

      expect(executionService.runPrompt).not.toHaveBeenCalled();
    });

    it('should skip non-thread channels', async () => {
      const msg = createMockMessage({ content: 'text' });
      msg.channel.isThread = () => false;

      await handleMessageCreate(msg);

      expect(executionService.runPrompt).not.toHaveBeenCalled();
    });

    it('should skip when passthrough is not enabled', async () => {
      vi.mocked(dataStore.isPassthroughEnabled).mockReturnValue(false);
      const msg = createMockMessage({ content: 'text' });

      await handleMessageCreate(msg);

      expect(executionService.runPrompt).not.toHaveBeenCalled();
    });
  });
});

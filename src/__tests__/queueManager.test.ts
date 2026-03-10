import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processNextInQueue, isBusy } from '../services/queueManager.js';
import * as dataStore from '../services/dataStore.js';
import * as executionService from '../services/executionService.js';
import * as sessionManager from '../services/sessionManager.js';

vi.mock('../services/dataStore.js');
vi.mock('../services/executionService.js');
vi.mock('../services/sessionManager.js');
vi.mock('../services/voiceService.js');

import * as voiceService from '../services/voiceService.js';

describe('queueManager', () => {
  const threadId = 'thread-1';
  const parentId = 'channel-1';
  const mockChannel = {
    send: vi.fn().mockResolvedValue({})
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isBusy', () => {
    it('should return true if sseClient is connected', () => {
      vi.mocked(sessionManager.getSseClient).mockReturnValue({
        isConnected: () => true
      } as any);
      expect(isBusy(threadId)).toBe(true);
    });

    it('should return false if sseClient is not connected', () => {
      vi.mocked(sessionManager.getSseClient).mockReturnValue({
        isConnected: () => false
      } as any);
      expect(isBusy(threadId)).toBe(false);
    });

    it('should return false if sseClient is missing', () => {
      vi.mocked(sessionManager.getSseClient).mockReturnValue(undefined);
      expect(isBusy(threadId)).toBe(false);
    });
  });

  describe('processNextInQueue', () => {
    it('should do nothing if queue is paused', async () => {
      vi.mocked(dataStore.getQueueSettings).mockReturnValue({
        paused: true,
        continueOnFailure: false,
        freshContext: true
      });
      
      await processNextInQueue(mockChannel as any, threadId, parentId);
      
      expect(dataStore.popFromQueue).not.toHaveBeenCalled();
    });

    it('should pop and run next prompt if not paused', async () => {
      vi.mocked(dataStore.getQueueSettings).mockReturnValue({
        paused: false,
        continueOnFailure: false,
        freshContext: true
      });
      vi.mocked(dataStore.popFromQueue).mockReturnValue({
        prompt: 'test prompt',
        userId: 'user-1',
        timestamp: Date.now()
      });

      await processNextInQueue(mockChannel as any, threadId, parentId);

      expect(dataStore.popFromQueue).toHaveBeenCalledWith(threadId);
      expect(executionService.runPrompt).toHaveBeenCalledWith(
        mockChannel, 
        threadId, 
        'test prompt', 
        parentId
      );
    });

    it('should do nothing if queue is empty', async () => {
      vi.mocked(dataStore.getQueueSettings).mockReturnValue({
        paused: false,
        continueOnFailure: false,
        freshContext: true
      });
      vi.mocked(dataStore.popFromQueue).mockReturnValue(undefined);

      await processNextInQueue(mockChannel as any, threadId, parentId);

      expect(executionService.runPrompt).not.toHaveBeenCalled();
    });

    it('should transcribe queued voice message and run prompt', async () => {
      vi.mocked(dataStore.getQueueSettings).mockReturnValue({
        paused: false,
        continueOnFailure: false,
        freshContext: true
      });
      vi.mocked(dataStore.popFromQueue).mockReturnValue({
        prompt: '',
        userId: 'user-1',
        timestamp: Date.now(),
        voiceAttachmentUrl: 'https://cdn.discord/voice.ogg',
        voiceAttachmentSize: 2048,
      });
      vi.mocked(voiceService.transcribe).mockResolvedValue('Queued voice text');

      await processNextInQueue(mockChannel as any, threadId, parentId);

      expect(voiceService.transcribe).toHaveBeenCalledWith(
        'https://cdn.discord/voice.ogg',
        2048,
      );
      expect(executionService.runPrompt).toHaveBeenCalledWith(
        mockChannel,
        threadId,
        'Queued voice text',
        parentId,
      );
    });

    it('should skip and process next when voice transcription fails', async () => {
      vi.mocked(dataStore.getQueueSettings).mockReturnValue({
        paused: false,
        continueOnFailure: false,
        freshContext: true
      });
      // First pop returns voice item that fails, second pop returns nothing
      vi.mocked(dataStore.popFromQueue)
        .mockReturnValueOnce({
          prompt: '',
          userId: 'user-1',
          timestamp: Date.now(),
          voiceAttachmentUrl: 'https://cdn.discord/voice.ogg',
          voiceAttachmentSize: 1024,
        })
        .mockReturnValueOnce(undefined);
      vi.mocked(voiceService.transcribe).mockRejectedValue(new Error('Whisper API error'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await processNextInQueue(mockChannel as any, threadId, parentId);

      expect(executionService.runPrompt).not.toHaveBeenCalled();
      // Should have tried to process next item (recursive call)
      expect(dataStore.popFromQueue).toHaveBeenCalledTimes(2);
      consoleSpy.mockRestore();
    });

    it('should skip and process next when voice transcription returns empty', async () => {
      vi.mocked(dataStore.getQueueSettings).mockReturnValue({
        paused: false,
        continueOnFailure: false,
        freshContext: true
      });
      vi.mocked(dataStore.popFromQueue)
        .mockReturnValueOnce({
          prompt: '',
          userId: 'user-1',
          timestamp: Date.now(),
          voiceAttachmentUrl: 'https://cdn.discord/voice.ogg',
          voiceAttachmentSize: 1024,
        })
        .mockReturnValueOnce(undefined);
      vi.mocked(voiceService.transcribe).mockResolvedValue('   ');
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await processNextInQueue(mockChannel as any, threadId, parentId);

      expect(executionService.runPrompt).not.toHaveBeenCalled();
      expect(dataStore.popFromQueue).toHaveBeenCalledTimes(2);
      consoleSpy.mockRestore();
    });
  });
});

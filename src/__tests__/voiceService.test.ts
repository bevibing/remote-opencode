import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as configStore from '../services/configStore.js';

vi.mock('../services/configStore.js');

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Must import after mocks are set up
const { isVoiceEnabled, transcribe } = await import('../services/voiceService.js');

describe('voiceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isVoiceEnabled', () => {
    it('should return true when API key is configured', () => {
      vi.mocked(configStore.getOpenAIApiKey).mockReturnValue('sk-test-key');
      expect(isVoiceEnabled()).toBe(true);
    });

    it('should return false when API key is not configured', () => {
      vi.mocked(configStore.getOpenAIApiKey).mockReturnValue(undefined);
      expect(isVoiceEnabled()).toBe(false);
    });

    it('should return false when API key is empty string', () => {
      vi.mocked(configStore.getOpenAIApiKey).mockReturnValue('');
      expect(isVoiceEnabled()).toBe(false);
    });
  });

  describe('transcribe', () => {
    const fakeAudioBuffer = new ArrayBuffer(1024);
    const fakeAttachmentUrl = 'https://cdn.discordapp.com/attachments/123/voice.ogg';

    function mockSuccessfulDownload() {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeAudioBuffer),
      } as unknown as Response);
    }

    function mockSuccessfulWhisper(text: string) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(text),
      } as unknown as Response);
    }

    beforeEach(() => {
      vi.mocked(configStore.getOpenAIApiKey).mockReturnValue('sk-test-key');
    });

    it('should transcribe audio successfully', async () => {
      mockSuccessfulDownload();
      mockSuccessfulWhisper('Hello world');

      const result = await transcribe(fakeAttachmentUrl, 1024);

      expect(result).toBe('Hello world');
      // First call: Discord CDN download
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toBe(fakeAttachmentUrl);
      // Second call: Whisper API
      expect(mockFetch.mock.calls[1][0]).toBe('https://api.openai.com/v1/audio/transcriptions');
      expect(mockFetch.mock.calls[1][1]).toMatchObject({
        method: 'POST',
        headers: { Authorization: 'Bearer sk-test-key' },
      });
    });

    it('should trim whitespace from transcription result', async () => {
      mockSuccessfulDownload();
      mockSuccessfulWhisper('  Hello world  \n');

      const result = await transcribe(fakeAttachmentUrl);
      expect(result).toBe('Hello world');
    });

    it('should throw when file size exceeds 25MB limit', async () => {
      const oversize = 26 * 1024 * 1024;
      await expect(transcribe(fakeAttachmentUrl, oversize)).rejects.toThrow('File size exceeds 25MB limit');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw when API key is not configured', async () => {
      vi.mocked(configStore.getOpenAIApiKey).mockReturnValue(undefined);
      await expect(transcribe(fakeAttachmentUrl)).rejects.toThrow('OpenAI API key is not configured');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw when Discord CDN download fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as unknown as Response);

      await expect(transcribe(fakeAttachmentUrl)).rejects.toThrow('Failed to download audio: HTTP 404');
    });

    it('should throw AUTH_FAILURE when Whisper returns 401', async () => {
      mockSuccessfulDownload();
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      } as unknown as Response);

      // Suppress expected console.error
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(transcribe(fakeAttachmentUrl)).rejects.toThrow('AUTH_FAILURE');
      consoleSpy.mockRestore();
    });

    it('should throw sanitized error for non-401 Whisper failures', async () => {
      mockSuccessfulDownload();
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal server error with sensitive details'),
      } as unknown as Response);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(transcribe(fakeAttachmentUrl)).rejects.toThrow('Whisper API error (HTTP 500)');
      // Verify full error is logged server-side
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Whisper API error 500'),
        'Internal server error with sensitive details',
      );
      consoleSpy.mockRestore();
    });

    it('should handle fetch abort (timeout) gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'));

      await expect(transcribe(fakeAttachmentUrl)).rejects.toThrow('The operation was aborted');
    });

    it('should work without fileSize parameter', async () => {
      mockSuccessfulDownload();
      mockSuccessfulWhisper('No size check');

      const result = await transcribe(fakeAttachmentUrl);
      expect(result).toBe('No size check');
    });

    it('should allow file exactly at 25MB limit', async () => {
      const exactLimit = 25 * 1024 * 1024;
      mockSuccessfulDownload();
      mockSuccessfulWhisper('Exact limit');

      const result = await transcribe(fakeAttachmentUrl, exactLimit);
      expect(result).toBe('Exact limit');
    });
  });
});

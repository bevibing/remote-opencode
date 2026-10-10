import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdtempSync: vi.fn(() => '/tmp/opencode-handy-test'),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));
vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal()),
  createRequire: () => () => '/usr/bin/ffmpeg',
}));

const mockExecFile = vi.mocked(execFile);
const mockExistsSync = vi.mocked(existsSync);

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.stubEnv('HANDY_BIN', '/usr/bin/handy');

const { isVoiceEnabled, transcribe } = await import('../services/voiceService.js');

describe('voiceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isVoiceEnabled', () => {
    it('should return true when Handy binary exists', () => {
      mockExistsSync.mockReturnValue(true);
      expect(isVoiceEnabled()).toBe(true);
    });

    it('should return false when Handy binary is missing', () => {
      mockExistsSync.mockReturnValue(false);
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

    function mockHandyOutput(json: string) {
      mockExecFile.mockImplementation(((file: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        if (file === '/usr/bin/ffmpeg') {
          (cb as (err: Error | null, stdout: string, stderr: string) => void)(null, '', '');
        } else {
          (cb as (err: Error | null, stdout: string, stderr: string) => void)(null, json, '');
        }
        return {} as never;
      }) as never);
    }

    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it('should transcribe audio successfully with Handy', async () => {
      mockSuccessfulDownload();
      mockHandyOutput('{"text":"Hola mundo","model":"parakeet"}');

      const result = await transcribe(fakeAttachmentUrl, 1024);

      expect(result).toBe('Hola mundo');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe(fakeAttachmentUrl);
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockExecFile.mock.calls[0][0]).toBe('/usr/bin/ffmpeg');
      expect(mockExecFile.mock.calls[1][0]).toBe('/usr/bin/handy');
    });

    it('should trim whitespace from transcription result', async () => {
      mockSuccessfulDownload();
      mockHandyOutput('{"text":"  Hola mundo  \\n"}');

      const result = await transcribe(fakeAttachmentUrl);
      expect(result).toBe('Hola mundo');
    });

    it('should throw when file size exceeds 25MB limit', async () => {
      const oversize = 26 * 1024 * 1024;
      await expect(transcribe(fakeAttachmentUrl, oversize)).rejects.toThrow('File size exceeds 25MB limit');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw when Handy binary is missing', async () => {
      mockExistsSync.mockReturnValue(false);
      await expect(transcribe(fakeAttachmentUrl)).rejects.toThrow('Handy binary not found');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw when Discord CDN download fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as unknown as Response);

      await expect(transcribe(fakeAttachmentUrl)).rejects.toThrow('Failed to download audio: HTTP 404');
    });

    it('should throw when Handy returns empty transcription', async () => {
      mockSuccessfulDownload();
      mockHandyOutput('{"text":""}');

      await expect(transcribe(fakeAttachmentUrl)).rejects.toThrow('Handy returned empty transcription');
    });

    it('should throw when Handy output has no JSON', async () => {
      mockSuccessfulDownload();
      mockHandyOutput('[INFO] some log line without json');

      await expect(transcribe(fakeAttachmentUrl)).rejects.toThrow('Handy did not return JSON output');
    });

    it('should handle fetch abort (timeout) gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'));

      await expect(transcribe(fakeAttachmentUrl)).rejects.toThrow('The operation was aborted');
    });

    it('should work without fileSize parameter', async () => {
      mockSuccessfulDownload();
      mockHandyOutput('{"text":"Sin tamaño"}');

      const result = await transcribe(fakeAttachmentUrl);
      expect(result).toBe('Sin tamaño');
    });

    it('should allow file exactly at 25MB limit', async () => {
      const exactLimit = 25 * 1024 * 1024;
      mockSuccessfulDownload();
      mockHandyOutput('{"text":"Exacto"}');

      const result = await transcribe(fakeAttachmentUrl, exactLimit);
      expect(result).toBe('Exacto');
    });
  });
});

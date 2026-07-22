import { describe, it, expect } from 'vitest';
import {
  parseSSEEvent,
  extractTextFromPart,
  accumulateText,
  formatOutput,
  stripAnsi,
  buildContextHeader,
  splitIntoChunks,
  splitForDiscordTemplate,
  DISCORD_MAX_LENGTH,
} from '../utils/messageFormatter.js';

describe('messageFormatter', () => {
  describe('stripAnsi', () => {
    it('should remove ANSI escape codes', () => {
      const input = '\x1B[31mHello\x1B[0m \x1B[1mWorld\x1B[0m';
      expect(stripAnsi(input)).toBe('Hello World');
    });
  });

  describe('parseSSEEvent', () => {
    it('should parse valid SSE event JSON', () => {
      const data = JSON.stringify({
        type: 'text',
        properties: {
          part: {
            type: 'text',
            text: 'Hello'
          }
        }
      });
      const result = parseSSEEvent(data);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('text');
      expect(result?.properties.part?.text).toBe('Hello');
    });

    it('should return null for invalid JSON', () => {
      const data = 'invalid json';
      expect(parseSSEEvent(data)).toBeNull();
    });

    it('should handle sessionID in properties', () => {
      const data = JSON.stringify({
        type: 'session_start',
        properties: {
          sessionID: '12345'
        }
      });
      const result = parseSSEEvent(data);
      expect(result?.properties.sessionID).toBe('12345');
    });
  });

  describe('extractTextFromPart', () => {
    it('should extract text from a valid part object', () => {
      const part = { text: 'Hello', type: 'text' };
      expect(extractTextFromPart(part)).toBe('Hello');
    });

    it('should return empty string if text is missing', () => {
      const part = { type: 'text' };
      expect(extractTextFromPart(part)).toBe('');
    });

    it('should return empty string if part is null or undefined', () => {
      expect(extractTextFromPart(null)).toBe('');
      expect(extractTextFromPart(undefined)).toBe('');
    });

    it('should return empty string if part is not an object', () => {
      expect(extractTextFromPart('not an object')).toBe('');
    });
  });

  describe('accumulateText', () => {
    it('should append new text to current text', () => {
      expect(accumulateText('Hello', ' World')).toBe('Hello World');
    });

    it('should handle empty current text', () => {
      expect(accumulateText('', 'Hello')).toBe('Hello');
    });
  });

  describe('buildContextHeader', () => {
    it('should format branch name and model name', () => {
      const result = buildContextHeader('feature/dark-mode', 'claude-sonnet-4-20250514');
      expect(result).toBe('🌿 `feature/dark-mode` · 🤖 `claude-sonnet-4-20250514`');
    });

    it('should handle default model', () => {
      const result = buildContextHeader('main', 'default');
      expect(result).toBe('🌿 `main` · 🤖 `default`');
    });

    it('should handle auto-generated branch names', () => {
      const result = buildContextHeader('auto/abc12345-1738600000000', 'default');
      expect(result).toBe('🌿 `auto/abc12345-1738600000000` · 🤖 `default`');
    });
  });

  describe('formatOutput (existing functionality)', () => {
    it('should work for OpenCode JSON output with newlines preserved', () => {
      const buffer = JSON.stringify({ type: 'text', part: { text: 'Hello' } }) + '\n' +
                     JSON.stringify({ type: 'text', part: { text: 'World' } });
      expect(formatOutput(buffer)).toBe('Hello\nWorld');
    });

    it('should preserve newlines within text parts', () => {
      const buffer = JSON.stringify({ type: 'text', part: { text: 'Line1\nLine2' } });
      expect(formatOutput(buffer)).toBe('Line1\nLine2');
    });

    it('should handle plain text with newlines', () => {
      const buffer = 'Line1\nLine2\nLine3';
      expect(formatOutput(buffer)).toBe('Line1\nLine2\nLine3');
    });

    it('should respect custom maxLength (body slice only)', () => {
      const long = 'a'.repeat(500);
      const truncated = formatOutput(long, 100);
      // formatOutput applies maxLength to the body slice; the truncation
      // notice adds ~19 chars of overhead on top.
      expect(truncated.length).toBeLessThanOrEqual(100 + 19);
      expect(truncated.endsWith('a'.repeat(100))).toBe(true);
      expect(truncated.startsWith('...(truncated)...')).toBe(true);
    });
  });

  describe('splitIntoChunks', () => {
    it('returns a single chunk when text fits', () => {
      expect(splitIntoChunks('hello', 100)).toEqual(['hello']);
    });

    it('splits long text on double-newline boundaries when possible', () => {
      const part = 'a'.repeat(80);
      const text = `${part}\n\n${part}\n\n${part}\n\n${part}`;
      const chunks = splitIntoChunks(text, 100);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    });

    it('falls back to single newline when no double newline in window', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
      const chunks = splitIntoChunks(lines, 60);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(60);
    });

    it('hard splits when no newline fits in the window', () => {
      const text = 'x'.repeat(500);
      const chunks = splitIntoChunks(text, 100);
      expect(chunks.length).toBe(5);
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    });

    it('strips leading newlines between chunks', () => {
      const text = Array.from({ length: 20 }, () => 'p').join('\n\n');
      const chunks = splitIntoChunks(text, 30);
      for (const c of chunks) expect(c.startsWith('\n')).toBe(false);
    });
  });

  describe('splitForDiscordTemplate', () => {
    it('keeps everything in prefixBody when body fits', () => {
      const r = splitForDiscordTemplate({
        header: '🌿 `main` · 🤖 `default`',
        prompt: 'hi',
        body: 'short body',
      });
      expect(r.overflowChunks).toEqual([]);
      expect(r.prefixBody).toContain('📌 **Prompt**: hi');
      expect(r.prefixBody).toContain('short body');
      expect(r.prefixBody.length).toBeLessThanOrEqual(DISCORD_MAX_LENGTH);
    });

    it('truncates and overflows when body is too large', () => {
      const body = 'a'.repeat(5000);
      const r = splitForDiscordTemplate({
        header: '🌿 `main` · 🤖 `default`',
        prompt: 'p',
        body,
      });
      expect(r.prefixBody.length).toBeLessThanOrEqual(DISCORD_MAX_LENGTH);
      expect(r.prefixBody.endsWith('...')).toBe(true);
      expect(r.overflowChunks.length).toBeGreaterThan(0);
      for (const c of r.overflowChunks) expect(c.length).toBeLessThanOrEqual(DISCORD_MAX_LENGTH);
    });

    it('respects a custom maxLength', () => {
      const r = splitForDiscordTemplate({
        header: 'h',
        prompt: 'p',
        body: 'a'.repeat(1000),
        maxLength: 500,
      });
      expect(r.prefixBody.length).toBeLessThanOrEqual(500);
      expect(r.overflowChunks.length).toBeGreaterThan(0);
    });

    it('handles a body smaller than the minimum budget without overflowing', () => {
      const r = splitForDiscordTemplate({
        header: 'h',
        prompt: 'p',
        body: '',
      });
      expect(r.overflowChunks).toEqual([]);
      expect(r.prefixBody).toContain('📌 **Prompt**: p');
    });
  });
});

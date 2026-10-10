import { describe, it, expect } from 'vitest';
import { parseSSEEvent, extractTextFromPart, accumulateText, formatOutput, stripAnsi, buildContextHeader, formatMarkdownTables } from '../utils/messageFormatter.js';

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
  });
});

describe('formatMarkdownTables', () => {
  it('should render a markdown table as a monospace block', () => {
    const input = '| Col A | Col B |\n|---|---|\n| 1 | longer value |\n| x | y |';
    const out = formatMarkdownTables(input);
    expect(out).toContain('```');
    expect(out).toContain('| Col A');
    expect(out).toContain('---');
    // Header cell should be padded to column width
    expect(out).toMatch(/\| Col A\s+\| Col B\s+\|/);
    expect(out).not.toContain('|---|---|');
  });

  it('should align cells to the widest value per column', () => {
    const input = '| a | b |\n|---|---|\n| 1 | 12345 |';
    const out = formatMarkdownTables(input);
    expect(out).toContain('| a   | b     |');
    expect(out).toContain('| 1   | 12345 |');
  });

  it('should not touch plain text', () => {
    const input = 'Hola mundo\nsin tablas';
    expect(formatMarkdownTables(input)).toBe(input);
  });

  it('should ignore tables inside code fences', () => {
    const input = '```\n| not | a | table |\n```\nafter';
    const out = formatMarkdownTables(input);
    expect(out).toBe(input);
  });

  it('should handle escaped pipes', () => {
    const input = '| a\\|b | c |\n|---|---|\n| 1 | 2 |';
    const out = formatMarkdownTables(input);
    expect(out).toContain('| a|b ');
  });
});

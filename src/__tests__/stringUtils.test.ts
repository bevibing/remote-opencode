import { describe, it, expect } from 'vitest';
import { sanitizeModel, truncateModel, isValidModel } from '../utils/stringUtils.js';

describe('stringUtils', () => {
  describe('sanitizeModel', () => {
    it('should trim whitespace', () => {
      expect(sanitizeModel('  openai/gpt-4  ')).toBe('openai/gpt-4');
    });

    it('should remove carriage returns', () => {
      expect(sanitizeModel('openai/gpt-4\r')).toBe('openai/gpt-4');
    });

    it('should preserve long but valid model names', () => {
      const longModel = 'provider/' + 'x'.repeat(500);
      expect(sanitizeModel(longModel)).toBe(longModel);
    });
  });

  describe('truncateModel', () => {
    it('should return short strings unchanged', () => {
      expect(truncateModel('openai/gpt-4', 100)).toBe('openai/gpt-4');
    });

    it('should truncate long strings to maxLength with ellipsis', () => {
      const long = 'a'.repeat(200);
      const result = truncateModel(long, 50);
      expect(result.length).toBe(50);
      expect(result).toBe('a'.repeat(47) + '...');
    });

    it('should default to 100 chars', () => {
      const long = 'b'.repeat(150);
      const result = truncateModel(long);
      expect(result.length).toBe(100);
    });
  });

  describe('isValidModel', () => {
    it('should accept provider/model format', () => {
      expect(isValidModel('openai/gpt-4')).toBe(true);
    });

    it('should reject model without provider', () => {
      expect(isValidModel('gpt-4')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isValidModel('')).toBe(false);
    });

    it('should reject strings with spaces', () => {
      expect(isValidModel('open ai/gpt-4')).toBe(false);
    });
  });
});

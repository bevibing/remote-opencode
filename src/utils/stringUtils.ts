export function sanitizeModel(model: string): string {
  return model.trim().replace(/\r/g, '');
}

/**
 * Truncate a model name to a safe length for Discord UI elements.
 * Discord embeds / messages have a 2000-char ceiling, and autocomplete name
 * fields are limited to 100 chars.
 */
export function truncateModel(model: string, maxLength: number = 100): string {
  if (model.length <= maxLength) return model;
  return model.slice(0, maxLength - 3) + '...';
}

/** Whether the string looks like a valid provider/model identifier. */
export function isValidModel(model: string): boolean {
  return /^[^\s/]+\/[^\s]+$/.test(model);
}

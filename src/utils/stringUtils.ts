export function sanitizeModel(model: string): string {
  return model.trim().replace(/\r/g, '');
}

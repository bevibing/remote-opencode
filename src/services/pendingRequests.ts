import type { QuestionInfo } from '../types/index.js';

export interface PendingBase {
  kind: 'question' | 'permission';
  requestID: string;
  sessionID: string;
  port: number;
  channelId: string;
  messageId: string;
  createdAt: number;
  timer?: NodeJS.Timeout;
}

export interface PendingQuestion extends PendingBase {
  kind: 'question';
  questions: QuestionInfo[];
  answers: Record<number, string[]>;
}

export interface PendingPermission extends PendingBase {
  kind: 'permission';
  permission: string;
}

export type PendingRequest = PendingQuestion | PendingPermission;

const PENDING = new Map<string, PendingRequest>();

export function setPending(entry: PendingRequest): void {
  const existing = PENDING.get(entry.requestID);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  PENDING.set(entry.requestID, entry);
}

export function getPending(requestID: string): PendingRequest | undefined {
  return PENDING.get(requestID);
}

export function deletePending(requestID: string): void {
  const entry = PENDING.get(requestID);
  if (entry?.timer) {
    clearTimeout(entry.timer);
  }
  PENDING.delete(requestID);
}

// OpenCode request IDs contain underscores (e.g. `que_000a...`, `per_000b...`),
// so custom IDs must be split on the LAST underscore after the prefix, never by
// a plain split('_') which would shred the requestID.
export function splitCustomId(customId: string, prefix: string): { requestID: string; suffix: string } {
  const rest = customId.slice(prefix.length);
  const sep = rest.lastIndexOf('_');
  if (sep === -1) return { requestID: rest, suffix: '' };
  return { requestID: rest.slice(0, sep), suffix: rest.slice(sep + 1) };
}

export function isQuestionComplete(entry: PendingQuestion): boolean {
  return entry.questions.every((_, i) => Array.isArray(entry.answers[i]));
}

export function buildQuestionAnswers(entry: PendingQuestion): string[][] {
  return entry.questions.map((_, i) => entry.answers[i] ?? []);
}

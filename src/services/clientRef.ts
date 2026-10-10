import type { Client } from 'discord.js';

let client: Client | null = null;

export function setClient(c: Client): void {
  client = c;
}

export function getClient(): Client | null {
  return client;
}

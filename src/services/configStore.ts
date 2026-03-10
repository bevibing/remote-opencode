import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface BotConfig {
  discordToken: string;
  clientId: string;
  guildId: string;
}

export interface PortConfig {
  min: number;
  max: number;
}

export interface AppConfig {
  bot?: BotConfig;
  ports?: PortConfig;
  allowedUserIds?: string[];
  openaiApiKey?: string;
}

const CONFIG_DIR = join(homedir(), '.remote-opencode');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function loadConfig(): AppConfig {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }
  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(content) as AppConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: AppConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export function getBotConfig(): BotConfig | undefined {
  return loadConfig().bot;
}

export function setBotConfig(bot: BotConfig): void {
  const config = loadConfig();
  config.bot = bot;
  saveConfig(config);
}

export function getPortConfig(): PortConfig | undefined {
  return loadConfig().ports;
}

export function setPortConfig(ports: PortConfig): void {
  const config = loadConfig();
  config.ports = ports;
  saveConfig(config);
}

export function hasBotConfig(): boolean {
  const bot = getBotConfig();
  return !!(bot?.discordToken && bot?.clientId && bot?.guildId);
}

export function clearBotConfig(): void {
  const config = loadConfig();
  delete config.bot;
  saveConfig(config);
}

export function getAllowedUserIds(): string[] {
  return loadConfig().allowedUserIds ?? [];
}

export function setAllowedUserIds(ids: string[]): void {
  const config = loadConfig();
  config.allowedUserIds = ids;
  saveConfig(config);
}

export function addAllowedUserId(id: string): void {
  const config = loadConfig();
  const current = config.allowedUserIds ?? [];
  if (!current.includes(id)) {
    config.allowedUserIds = [...current, id];
    saveConfig(config);
  }
}

export function removeAllowedUserId(id: string): boolean {
  const config = loadConfig();
  const current = config.allowedUserIds ?? [];
  if (!current.includes(id)) return false;
  if (current.length <= 1) return false; // prevent removing last user
  config.allowedUserIds = current.filter(uid => uid !== id);
  saveConfig(config);
  return true;
}

export function isAuthorized(userId: string): boolean {
  const ids = getAllowedUserIds();
  if (ids.length === 0) return true; // no restriction
  return ids.includes(userId);
}

export function getOpenAIApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY || loadConfig().openaiApiKey;
}

export function setOpenAIApiKey(key: string): void {
  const config = loadConfig();
  config.openaiApiKey = key;
  saveConfig(config);
}

export function removeOpenAIApiKey(): void {
  const config = loadConfig();
  delete config.openaiApiKey;
  saveConfig(config);
}

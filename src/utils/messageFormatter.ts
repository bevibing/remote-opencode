export function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith('|')) return false;
  return (t.match(/\|/g) || []).length >= 2;
}

function parseRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s
    .replace(/\\\|/g, '\u0000')
    .split('|')
    .map((cell) => cell.trim().replace(/`/g, '').replace(/\u0000/g, '|'));
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

function renderTable(rows: string[]): string {
  const parsed = rows.map(parseRow);
  const maxCols = Math.max(...parsed.map((r) => r.length));
  const sepIndex = parsed.findIndex(isSeparatorRow);

  const widths: number[] = [];
  for (let c = 0; c < maxCols; c++) {
    let w = 0;
    for (const r of parsed) {
      if (r[c] !== undefined) w = Math.max(w, r[c].length);
    }
    widths.push(w);
  }

  const fmt = (cells: string[]): string => {
    const arr: string[] = new Array(maxCols).fill('');
    cells.forEach((c, idx) => {
      arr[idx] = c;
    });
    return '| ' + arr.map((c, idx) => c.padEnd(widths[idx])).join(' | ') + ' |';
  };

  const result: string[] = [];
  parsed.forEach((r, idx) => {
    if (idx === sepIndex) return;
    result.push(fmt(r));
  });

  if (sepIndex > 0) {
    result.splice(1, 0, '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|');
  }

  return '```\n' + result.join('\n') + '\n```';
}

export function formatMarkdownTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      out.push(line);
      inCode = !inCode;
      continue;
    }

    if (!inCode && isTableRow(line)) {
      const block: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith('```') && isTableRow(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      i--;
      out.push(renderTable(block));
    } else {
      out.push(line);
    }
  }

  return out.join('\n');
}

export interface SSEEvent {
  type: string;
  properties: {
    part?: {
      type: string;
      text?: string;
      id?: string;
    };
    sessionID?: string;
  };
}

export function parseSSEEvent(data: string): SSEEvent | null {
  try {
    return JSON.parse(data) as SSEEvent;
  } catch {
    return null;
  }
}

export function extractTextFromPart(part: any): string {
  if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
    return part.text;
  }
  return '';
}

export function accumulateText(current: string, newText: string): string {
  return current + newText;
}

interface OpenCodePart {
  text?: string;
  type?: string;
  reason?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
  };
}

interface OpenCodeEvent {
  type: string;
  part?: OpenCodePart;
}

export function parseOpenCodeOutput(buffer: string): string {
  const lines = buffer.split('\n').filter(line => line.trim());
  const textParts: string[] = [];
  let lastFinish: OpenCodeEvent | null = null;

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as OpenCodeEvent;
      
      switch (event.type) {
        case 'text':
          if (event.part?.text) {
            textParts.push(event.part.text);
          }
          break;
        
        case 'step_finish':
          lastFinish = event;
          break;
      }
    } catch {
      const cleaned = stripAnsi(line);
      if (cleaned.trim()) {
        textParts.push(cleaned);
      }
    }
  }

  let result = textParts.join('\n');

  // Render markdown tables as monospace blocks (Discord doesn't render tables)
  result = formatMarkdownTables(result);

  if (lastFinish?.part?.tokens) {
    const tokens = lastFinish.part.tokens;
    const cost = lastFinish.part.cost;
    result += `\n\n---\n📊 Tokens: ${tokens.input?.toLocaleString() || 0} in / ${tokens.output?.toLocaleString() || 0} out`;
    if (cost !== undefined && cost > 0) {
      result += ` | 💰 $${cost.toFixed(4)}`;
    }
  }

  return result;
}

export function buildContextHeader(branchName: string, modelName: string): string {
  return `🌿 \`${branchName}\` · 🤖 \`${modelName}\``;
}


export function formatOutput(buffer: string, maxLength: number = 1900): string {
  const parsed = parseOpenCodeOutput(buffer);
  
  if (!parsed.trim()) {
    return '⏳ Processing...';
  }

  if (parsed.length <= maxLength) {
    return parsed;
  }
  
  return '...(truncated)...\n\n' + parsed.slice(-maxLength);
}

export interface FormattedResult {
  /** Message chunks to send (first chunk goes in the main edited message, rest as follow-up sends) */
  chunks: string[];
}

const MESSAGE_MAX_LENGTH = 1900;

/**
 * Split text into chunks that fit within Discord's message limit.
 * Splits on paragraph boundaries (double newline) when possible.
 */
function splitIntoChunks(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a paragraph boundary (double newline)
    let splitIndex = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIndex <= 0 || splitIndex < maxLength * 0.3) {
      // Fallback: split at single newline
      splitIndex = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitIndex <= 0 || splitIndex < maxLength * 0.3) {
      // Last resort: hard split at maxLength
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n+/, '');
  }

  return chunks;
}

export function formatOutputForMobile(buffer: string): FormattedResult {
  const parsed = parseOpenCodeOutput(buffer);
  
  if (!parsed.trim()) {
    return { chunks: ['⏳ Processing...'] };
  }

  const chunks = splitIntoChunks(parsed, MESSAGE_MAX_LENGTH);
  return { chunks };
}

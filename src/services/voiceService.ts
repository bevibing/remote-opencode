import { getOpenAIApiKey } from './configStore.js';

const WHISPER_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

export function isVoiceEnabled(): boolean {
  return !!getOpenAIApiKey();
}

export async function transcribe(attachmentUrl: string, fileSize?: number): Promise<string> {
  if (fileSize && fileSize > MAX_FILE_SIZE) {
    throw new Error('File size exceeds 25MB limit');
  }

  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    throw new Error('OpenAI API key is not configured');
  }

  // Download audio from Discord CDN
  const audioResponse = await fetch(attachmentUrl);
  if (!audioResponse.ok) {
    throw new Error(`Failed to download audio: ${audioResponse.status}`);
  }

  const audioBuffer = await audioResponse.arrayBuffer();

  // Build FormData for Whisper API
  const formData = new FormData();
  const audioBlob = new Blob([audioBuffer], { type: 'audio/ogg' });
  formData.append('file', audioBlob, 'voice.ogg');
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'text');

  // POST to OpenAI Whisper API
  const response = await fetch(WHISPER_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    let errorDetail = '';
    try {
      errorDetail = await response.text();
    } catch {
      // ignore
    }
    if (response.status === 401) {
      throw new Error('AUTH_FAILURE');
    }
    throw new Error(`Whisper API error ${response.status}: ${errorDetail}`);
  }

  // response_format: 'text' returns plain text string
  const text = await response.text();
  return text.trim();
}

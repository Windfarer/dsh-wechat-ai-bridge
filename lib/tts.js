/**
 * Minimal OpenAI-compatible text-to-speech client.
 *
 * The bridge sends the resulting bytes straight to wechat-ai, so no audio file
 * has to be written into a workspace and the TTS API key never reaches an
 * Agent. Errors deliberately omit request headers so a configured key cannot
 * leak into tool output or logs.
 */

export const TTS_DEFAULTS = {
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: 'breeze-tts-2',
  voice: 'alloy',
  timeoutMs: 60000,
  maxChars: 200,
};

export function ttsEndpoint(baseUrl) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('TTS base URL is not configured');
  return `${base}/audio/speech`;
}

function timeoutError(ms) {
  return new Error(`TTS request timed out after ${ms} ms`);
}

/**
 * Synthesize one utterance and return its encoded bytes.
 *
 * @param {object} config normalized `config.tts`
 * @param {string} text text to speak
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
export async function synthesizeSpeech(config, text, options = {}) {
  if (!config?.enabled) throw new Error('TTS is disabled; enable it in the bridge settings');
  const input = String(text ?? '').trim();
  if (!input) throw new Error('TTS text must not be empty');
  const maxChars = Number.isInteger(config.maxChars) && config.maxChars > 0 ? config.maxChars : TTS_DEFAULTS.maxChars;
  const length = Array.from(input).length;
  if (length > maxChars) throw new Error(`TTS text is too long (${length} > ${maxChars} characters)`);

  const endpoint = ttsEndpoint(config.baseUrl);
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : TTS_DEFAULTS.timeoutMs;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime has no fetch implementation');

  const headers = {
    'content-type': 'application/json',
    accept: 'audio/*',
  };
  const apiKey = String(config.apiKey ?? '').trim();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model || TTS_DEFAULTS.model,
        input,
        voice: config.voice || TTS_DEFAULTS.voice,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.text()).trim().slice(0, 300); } catch { /* Status is enough. */ }
      throw new Error(`TTS service HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const mimeType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mimeType.startsWith('audio/')) {
      let detail = '';
      try { detail = (await response.text()).trim().slice(0, 300); } catch { /* Keep the MIME error. */ }
      throw new Error(`TTS service returned ${mimeType || 'no content type'} instead of audio${detail ? `: ${detail}` : ''}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error('TTS service returned empty audio');
    return { buffer, mimeType };
  } catch (error) {
    if (error?.name === 'AbortError') throw timeoutError(timeoutMs);
    if (error instanceof Error) throw error;
    throw new Error(`TTS request failed: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

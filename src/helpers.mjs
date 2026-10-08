export const REQUIRED_PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const API_BASE = 'https://api.openai.com/v1';
export const AUTH_BASE = 'https://auth.openai.com/api/accounts';
export const APP_NAME = 'AI Developer Plus Bridge';

export function safeErrorCode(payload = {}) {
  return payload?.error?.code ?? payload?.code ?? null;
}

export function classifyPlanFailure(status, payload = {}) {
  const code = safeErrorCode(payload);
  if (code === 'subscription_sharing_usage_limit_exceeded') {
    return { kind: 'quota', pause: true, message: 'ChatGPT plan usage limit reached. Progress is saved; resume manually after checking ChatGPT Usage.' };
  }
  if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable' || status === 503) {
    return { kind: 'unavailable', pause: true, message: 'ChatGPT plan inference is temporarily unavailable. Progress is saved; retry only when you choose to resume.' };
  }
  if (code === 'subscription_sharing_user_not_eligible') {
    return { kind: 'ineligible', pause: true, message: 'This ChatGPT account, workspace, or policy is not eligible for ChatGPT plan usage.' };
  }
  if (code === 'subscription_sharing_invalid_user' || status === 401 || code === 'chatpass_v2_scope_not_authorized' || code === 'chatpass_v2_invalid_authorization_context') {
    return { kind: 'auth', pause: true, message: 'The subscription authorization was not accepted. Reconnect with ChatGPT and confirm plan usage is enabled.' };
  }
  if (code === 'subscription_sharing_unsupported_capability') {
    return { kind: 'unsupported', pause: true, message: `The authorized service rejected a capability${payload?.error?.param ? ` (${payload.error.param})` : ''}. No alternate provider was used.` };
  }
  if (code === 'subscription_sharing_route_not_supported') {
    return { kind: 'route', pause: true, message: 'The authorized service rejected this route. No alternate provider was used.' };
  }
  if (status === 403) return { kind: 'forbidden', pause: true, message: 'OpenAI denied access under the current permission or regional policy.' };
  return { kind: 'request', pause: true, message: payload?.error?.message ?? payload?.detail ?? `AI request failed${status ? ` (HTTP ${status})` : ''}.` };
}

export function parseDecision(text) {
  const match = text.match(/<result>\s*([\s\S]*?)\s*<\/result>/i);
  if (!match) return { action: 'human', summary: text.trim(), nextPrompt: '' };
  try {
    const data = JSON.parse(match[1]);
    if (!['continue', 'review', 'human'].includes(data.action)) throw new Error('Invalid action');
    return {
      action: data.action,
      summary: String(data.summary ?? '').slice(0, 12000),
      nextPrompt: String(data.next_prompt ?? '').slice(0, 20000),
      acceptanceCriteria: Array.isArray(data.acceptance_criteria) ? data.acceptance_criteria.map(String).slice(0, 30) : [],
    };
  } catch {
    return { action: 'human', summary: text.trim(), nextPrompt: '' };
  }
}

export function makeResponsesPayload(model, messages, instructions) {
  return { model, instructions, input: messages, store: false, stream: true };
}

export function extractSseEvents(buffer) {
  const parts = buffer.split(/\r?\n\r?\n/);
  const remainder = parts.pop() ?? '';
  const events = [];
  for (const block of parts) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    try { events.push(JSON.parse(data)); } catch { /* Ignore non-JSON keepalive frames. */ }
  }
  return { events, remainder };
}

export function formatErrorDetail(status, payload = {}, requestId = '') {
  const code = safeErrorCode(payload);
  return [status ? `HTTP ${status}` : '', code ? `code=${code}` : '', requestId ? `request_id=${requestId}` : '', payload?.error?.param ? `param=${payload.error.param}` : '', payload?.detail ?? payload?.error?.message ?? ''].filter(Boolean).join(' · ');
}

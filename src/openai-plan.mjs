import { API_BASE, classifyPlanFailure, extractSseEvents, formatErrorDetail, makeResponsesPayload } from './helpers.mjs';
import { refreshAccessToken } from './oauth.mjs';

export class PlanRequestError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'PlanRequestError'; Object.assign(this, details); }
}

async function tokenForRequest(credentials, onRefresh) {
  if (credentials.expires_at > Date.now() + 90_000) return credentials;
  try {
    const updated = await refreshAccessToken(credentials);
    await onRefresh(updated);
    return updated;
  } catch (error) {
    throw new PlanRequestError(error.message, { kind: 'auth', pause: true });
  }
}

export async function ensureFreshPlanToken(credentials, onRefresh = async () => {}) {
  return tokenForRequest(credentials, onRefresh);
}

async function readFailure(response) {
  const text = await response.text().catch(() => '');
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { detail: text }; }
  const recovery = classifyPlanFailure(response.status, payload);
  const detail = formatErrorDetail(response.status, payload, response.headers.get('x-request-id') ?? '');
  return new PlanRequestError(recovery.message, { ...recovery, status: response.status, code: payload?.error?.code ?? null, detail, payload });
}

export async function listAvailableModels(credentials, onRefresh = async () => {}) {
  const current = await tokenForRequest(credentials, onRefresh);
  const response = await fetch(`${API_BASE}/models`, { headers: { authorization: `Bearer ${current.access_token}` } });
  if (!response.ok) throw await readFailure(response);
  const body = await response.json();
  if (!Array.isArray(body.models)) throw new Error('The signed-in account model response did not contain a models list.');
  return body.models.filter((model) => model.visibility === 'list' && model.slug).map((model) => ({ slug: model.slug, name: model.display_name ?? model.slug }));
}

export async function streamResponse({ credentials, model, messages, instructions, signal, onDelta, onRefresh }) {
  const current = await tokenForRequest(credentials, onRefresh);
  const payload = makeResponsesPayload(model, messages, instructions);
  const response = await fetch(`${API_BASE}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${current.access_token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) throw await readFailure(response);
  if (!response.body) throw new PlanRequestError('The Responses API returned no event stream.', { kind: 'stream', pause: true });
  let buffer = '';
  let output = '';
  let completed = false;
  let failed = null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = extractSseEvents(buffer);
      buffer = parsed.remainder;
      for (const event of parsed.events) {
        if (event.type === 'response.output_text.delta') {
          output += event.delta ?? '';
          await onDelta(event.delta ?? '', output);
        } else if (event.type === 'response.completed') {
          completed = true;
        } else if (event.type === 'response.failed') {
          const err = event.response?.error ?? {};
          const recovery = classifyPlanFailure(response.status, { error: err });
          failed = new PlanRequestError(recovery.message, { ...recovery, code: err.code ?? null, detail: formatErrorDetail(response.status, { error: err }, response.headers.get('x-request-id') ?? '') });
        } else if (event.type === 'response.incomplete') {
          const reason = event.response?.incomplete_details?.reason ?? 'unspecified';
          failed = new PlanRequestError(`Responses stream was incomplete (${reason}); it is not treated as a successful answer.`, { kind: 'incomplete', pause: true, detail: reason });
        } else if (event.type === 'error') {
          const recovery = classifyPlanFailure(response.status, { error: event.error ?? event });
          failed = new PlanRequestError(recovery.message, { ...recovery, code: event.error?.code ?? null });
        }
      }
      if (failed) throw failed;
    }
  } finally { reader.releaseLock(); }
  if (!completed) throw new PlanRequestError('Responses stream ended without response.completed. Partial text is saved, but the call was not treated as successful.', { kind: 'incomplete', pause: true });
  return output;
}

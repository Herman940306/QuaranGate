export class McpClientError extends Error {
  constructor(message, { code = 'MCP_ERROR', status = 0, data, cause } = {}) {
    super(message, { cause });
    this.name = 'McpClientError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export class McpClient {
  #credential = '';
  #requestId = 0;

  constructor({ endpoint = '/mcp', fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
  }

  get connected() {
    return this.#credential.length > 0;
  }

  setCredential(value) {
    const next = typeof value === 'string' ? value.trim() : '';
    if (!next) throw new McpClientError('Enter a QuaranGate API key.', { code: 'MISSING_CREDENTIAL' });
    this.#credential = next;
  }

  clearCredential() {
    this.#credential = '';
  }

  async request(method, params = {}, { signal } = {}) {
    if (!this.#credential) throw new McpClientError('Console is not connected.', { code: 'UNAUTHENTICATED', status: 401 });
    const id = ++this.#requestId;
    let response;
    try {
      response = await Reflect.apply(this.fetchImpl, globalThis, [this.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.#credential}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal,
      }]);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new McpClientError('QuaranGate could not be reached. Check the gateway and try again.', { code: 'NETWORK_ERROR', cause: error });
    }

    const text = await response.text();
    let payload;
    try {
      payload = parseTransportPayload(text, response.headers?.get?.('content-type') ?? '');
    } catch (error) {
      throw new McpClientError('QuaranGate returned an unreadable response.', { code: 'INVALID_RESPONSE', status: response.status, cause: error });
    }

    if (!response.ok) {
      const code = payload?.error?.data || (response.status === 401 ? 'UNAUTHENTICATED' : response.status === 403 ? 'FORBIDDEN' : 'HTTP_ERROR');
      throw new McpClientError(safeErrorMessage(payload?.error?.message, response.status), { code, status: response.status, data: payload?.error?.data });
    }
    if (payload?.error) {
      throw new McpClientError(safeErrorMessage(payload.error.message), { code: payload.error.data || 'MCP_ERROR', status: response.status, data: payload.error.data });
    }
    if (!payload || payload.id !== id) {
      throw new McpClientError('QuaranGate returned a response for an unexpected request.', { code: 'MISMATCHED_RESPONSE', status: response.status });
    }
    return payload.result;
  }

  async listTools({ signal } = {}) {
    const result = await this.request('tools/list', {}, { signal });
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args = {}, { signal } = {}) {
    const result = await this.request('tools/call', { name, arguments: args }, { signal });
    if (result?.isError) {
      const parsed = structuredFromResult(result);
      const message = typeof parsed?.message === 'string' ? parsed.message : `Tool ${name} was denied or failed.`;
      const code = typeof parsed?.error === 'string' ? parsed.error : 'TOOL_ERROR';
      throw new McpClientError(message, { code, status: code.startsWith('FORBIDDEN') ? 403 : 400, data: parsed });
    }
    return structuredFromResult(result);
  }
}

export function structuredFromResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const textPart = Array.isArray(result?.content) ? result.content.find((part) => part?.type === 'text' && typeof part.text === 'string') : undefined;
  if (!textPart) return result ?? {};
  try { return JSON.parse(textPart.text); } catch { return { text: textPart.text }; }
}

export function parseTransportPayload(text, contentType = '') {
  if (!text) return {};
  if (contentType.toLowerCase().includes('text/event-stream') || text.trimStart().startsWith('event:') || text.trimStart().startsWith('data:')) {
    const events = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try { events.push(JSON.parse(raw)); } catch { /* a partial event is ignored; a later complete event may follow */ }
    }
    if (!events.length) throw new Error('no JSON data event');
    return events.at(-1);
  }
  return JSON.parse(text);
}

function safeErrorMessage(value, status = 0) {
  if (typeof value === 'string' && value.trim()) return value.slice(0, 2000);
  if (status === 401) return 'Authentication failed. Check the API key and reconnect.';
  if (status === 403) return 'This principal is not authorized for that operation.';
  return 'QuaranGate rejected the request.';
}

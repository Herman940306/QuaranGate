#!/usr/bin/env node
/**
 * Deterministic mock of the Kiro CLI 2.5.0 ACP line protocol, used to prove the
 * AcpDriver against the REAL message shapes without any paid provider call.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout and enforces the
 * shapes validated live (see a4-kiro-acp-runtime-facts):
 *   - initialize      -> {protocolVersion:1, agentCapabilities, authMethods:[], agentInfo}
 *   - session/new     -> {sessionId, models}
 *   - session/load    -> restores a known provider session (A8 R1)
 *   - session/prompt  requires {sessionId:string, prompt:[{type:"text",text}]}
 *                     emits session/update notifications, then {stopReason}
 *   - session/cancel  notification (no response)
 *
 * The prompt text selects behavior:
 *   default   -> echo "MARKER:<text>" via agent_message_chunk + a `read` tool_call
 *   "PRIV"    -> first send a server->client fs/write_text_file REQUEST (must be refused)
 *   "SLOW"    -> delay the response past a short timeout
 *   "WIDEN"   -> emit a `bash` (shell) tool_call to test read-only validation
 */
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';

let sessionId = null;
let sessionKnown = false;

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
function respondErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return; }

  // A response to our server->client request (the driver refuses privileged ones).
  if (msg.method === undefined && msg.id !== undefined) return;

  const { id, method, params } = msg;
  if (method && process.env.MOCK_ACP_TRACE_FILE) {
    appendFileSync(process.env.MOCK_ACP_TRACE_FILE, method + '\n');
  }

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: process.env.MOCK_ACP_LOAD_MODE !== 'unsupported', mcpCapabilities: { http: true } },
      authMethods: [],
      agentInfo: { name: 'Mock Kiro CLI Agent', version: '2.5.0' },
    });
    // A known Kiro extension notification the driver must tolerate.
    notify('_kiro.dev/metadata', { hello: true });
    return;
  }

  if (method === 'session/new') {
    if (!params || !Array.isArray(params.mcpServers) || params.mcpServers.length !== 0) {
      respondErr(id, -32602, 'session/new requires mcpServers:[]');
      return;
    }
    sessionId = 'sess-' + Math.random().toString(16).slice(2, 10);
    sessionKnown = true;
    respond(id, { sessionId, modes: { current: 'default' }, models: ['claude-haiku-4.5', 'auto'] });
    return;
  }

  if (method === 'session/load') {
    if (process.env.MOCK_ACP_LOAD_MODE === 'unsupported') {
      respondErr(id, -32601, 'session/load unsupported');
      return;
    }
    if (!params || typeof params.sessionId !== 'string' || typeof params.cwd !== 'string'
      || !Array.isArray(params.mcpServers) || params.mcpServers.length !== 0) {
      respondErr(id, -32602, 'session/load requires sessionId,cwd,mcpServers:[]');
      return;
    }
    if (params.sessionId.includes('dead')) {
      respondErr(id, -32004, 'session not found');
      return;
    }
    if (process.env.MOCK_ACP_LOAD_MODE === 'malformed') {
      respond(id, null);
      return;
    }
    sessionId = params.sessionId;
    sessionKnown = true;
    respond(id, { modes: { current: 'default' }, models: ['claude-haiku-4.5', 'auto'] });
    return;
  }

  if (method === 'session/cancel') {
    // Notification — no response. End the turn if one is pending.
    notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[cancelled]' } } });
    return;
  }

  if (method === 'session/prompt') {
    // Enforce the REAL shape.
    if (!params || typeof params.sessionId !== 'string') {
      respondErr(id, -32602, 'session/prompt requires sessionId:string');
      return;
    }
    if (!sessionKnown || params.sessionId !== sessionId) {
      respondErr(id, -32004, 'session must be created or loaded before prompt');
      return;
    }
    if (!Array.isArray(params.prompt) || params.prompt[0]?.type !== 'text' || typeof params.prompt[0]?.text !== 'string') {
      respondErr(id, -32602, 'session/prompt requires prompt:[{type:"text",text}]');
      return;
    }
    if ('model' in params) {
      respondErr(id, -32602, 'session/prompt must NOT carry a model field (use startup --model)');
      return;
    }
    const text = params.prompt[0].text;

    if (text.includes('PRIV')) {
      // Server->client privileged request. The driver must refuse (error) and
      // NOT fulfil it. We then complete the turn regardless.
      send({ jsonrpc: '2.0', id: 9001, method: 'fs/write_text_file', params: { path: '/workspace/x', content: 'y' } });
    }

    const emit = () => {
      if (text.includes('WIDEN')) {
        notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'bash', title: 'run shell', status: 'pending' } });
        notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } });
      } else {
        notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', title: 'read fixture', status: 'pending' } });
        notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } });
      }
      notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'MARKER:' + text } } });
      respond(id, { stopReason: 'end_turn' });
    };

    if (text.includes('SLOW')) setTimeout(emit, 3000);
    else emit();
    return;
  }

  // Unknown request -> error (should not happen in these tests).
  if (id !== undefined) respondErr(id, -32601, 'unknown method ' + method);
});

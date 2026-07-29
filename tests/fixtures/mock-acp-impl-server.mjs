#!/usr/bin/env node
/**
 * Deterministic mock of Kiro CLI 2.5.0 ACP for the A5 IMPLEMENT lane.
 *
 * Models the CORRECT in-process write path: Kiro's fsWrite tool writes files
 * directly (no server->client fs/write_text_file delegation). The mock writes
 * files using Node fs itself — exactly as the real kiro-cli would when its
 * fsWrite tool is pre-approved via allowedTools + --trust-tools.
 *
 * Prompt behavior:
 *   contains "IMPLEMENT" -> write target.ts (modify) and generated.ts (create)
 *     directly to /workspace, emit read + edit tool_calls, then end_turn.
 *   contains "WIDEN"     -> emit a `bash` tool_call to prove forbidden kinds
 *     still fail read/write validation.
 *
 * No server->client fs requests are issued here — that was the speculative
 * client-FS path removed in the A5 forensic gate.
 */
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

let sessionId = null;
const WORKSPACE = '/workspace';

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
  // Responses to any server->client requests (none expected here): ignore.
  if (msg.method === undefined && msg.id !== undefined) return;
  const { id, method, params } = msg;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
      agentInfo: { name: 'Mock Kiro CLI Agent', version: '2.5.0' },
    });
    return;
  }
  if (method === 'session/new') {
    sessionId = 'sess-' + Math.random().toString(16).slice(2, 10);
    respond(id, { sessionId, modes: { current: 'default' }, models: ['claude-sonnet-4.5', 'auto'] });
    return;
  }
  if (method === 'session/cancel') { return; }
  if (method === 'session/prompt') {
    if (!params || typeof params.sessionId !== 'string') { respondErr(id, -32602, 'need sessionId'); return; }
    const text = Array.isArray(params.prompt) ? (params.prompt[0]?.text ?? '') : '';

    if (text.includes('WIDEN')) {
      notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'w1', kind: 'bash', title: 'run shell', status: 'completed' } });
      notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WIDEN' } } });
      respond(id, { stopReason: 'end_turn' });
      return;
    }

    if (text.includes('FAIL')) {
      // Models the two REAL A5 failures: the write/edit tool is CALLED but the
      // mutation FAILS (e.g. permission denied) — no file is written — yet the
      // turn still reaches end_turn. The Executor must treat this as FAILED_AGENT
      // from the tool STATUS, never from the assistant prose.
      notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'r1', kind: 'read', title: 'read target', status: 'completed' } });
      notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'e1', kind: 'edit', title: 'write files', status: 'pending' } });
      notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'failed' } });
      notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done! Successfully implemented everything.' } } });
      respond(id, { stopReason: 'end_turn' });
      return;
    }

    // Model reads a file (in-process read), then writes files IN-PROCESS via
    // its fsWrite tool (pre-approved by allowedTools + --trust-tools).
    notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'r1', kind: 'read', title: 'read target', status: 'completed' } });

    // Write files directly — this is the real path for an approved fsWrite.
    try {
      fs.writeFileSync(path.join(WORKSPACE, 'target.ts'), 'export const target = 2;\n', 'utf8');
      fs.writeFileSync(path.join(WORKSPACE, 'generated.ts'), 'export const generated = true;\n', 'utf8');
    } catch (e) {
      // If workspace isn't mounted (unit test context), tolerate the error.
    }

    notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'e1', kind: 'edit', title: 'write files', status: 'completed' } });
    notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Implemented in sandbox.' } } });
    respond(id, { stopReason: 'end_turn' });
    return;
  }
  if (id !== undefined) respondErr(id, -32601, 'unknown method ' + method);
});

#!/usr/bin/env node
/**
 * Bounded authenticated MCP initialize soak.
 *
 * The bearer token is read from a caller-owned mode-0600 file and is never
 * printed, placed in argv, or stored in results. Response bodies are parsed for
 * protocol success but are never printed.
 */
import { readFileSync, statSync } from 'node:fs';

const url = process.env.MCP_SOAK_URL ?? 'http://127.0.0.1:8787/mcp';
const bearerFile = process.env.MCP_BEARER_FILE;
const attempts = positiveInteger('MCP_SOAK_ATTEMPTS', 500);
const concurrency = positiveInteger('MCP_SOAK_CONCURRENCY', 1);
const intervalMs = nonnegativeInteger('MCP_SOAK_INTERVAL_MS', 0);
const timeoutMs = positiveInteger('MCP_SOAK_TIMEOUT_MS', 15_000);

if (!bearerFile) fail('MCP_BEARER_FILE is required');
const mode = statSync(bearerFile).mode & 0o777;
if ((mode & 0o077) !== 0) fail('MCP_BEARER_FILE must not be accessible by group or other users');
const bearer = readFileSync(bearerFile, 'utf8').trim();
if (!bearer) fail('MCP_BEARER_FILE is empty');
if (concurrency > 4) fail('MCP_SOAK_CONCURRENCY must be between 1 and 4');

const latencies = [];
const failures = new Map();
let nextAttempt = 0;
let passes = 0;
const startedAt = new Date();
const startedNs = process.hrtime.bigint();

async function one(attempt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = process.hrtime.bigint();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: attempt,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'quarangate-soak', version: '1.0.0' },
        },
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    const ok = response.status === 200
      && body !== null
      && body.jsonrpc === '2.0'
      && body.id === attempt
      && typeof body.result?.protocolVersion === 'string';
    if (ok) {
      passes += 1;
    } else {
      incrementFailure(`http_${response.status}_protocol_invalid`);
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    incrementFailure(name === 'AbortError' ? 'timeout' : `network_${name}`);
  } finally {
    clearTimeout(timer);
    latencies.push(Number(process.hrtime.bigint() - start) / 1_000_000);
  }
}

function incrementFailure(category) {
  failures.set(category, (failures.get(category) ?? 0) + 1);
}

async function worker() {
  while (true) {
    const attempt = nextAttempt + 1;
    nextAttempt = attempt;
    if (attempt > attempts) return;
    await one(attempt);
    if (intervalMs > 0 && attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
const durationMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
latencies.sort((a, b) => a - b);
const summary = {
  startedAt: startedAt.toISOString(),
  completedAt: new Date().toISOString(),
  url: sanitizedUrl(url),
  attempts,
  passes,
  failureCount: attempts - passes,
  failures: Object.fromEntries([...failures.entries()].sort()),
  concurrency,
  intervalMs,
  timeoutMs,
  durationMs: round(durationMs),
  latencyMs: {
    p50: percentile(0.50),
    p95: percentile(0.95),
    max: latencies.length ? round(latencies[latencies.length - 1]) : null,
  },
};
console.log(JSON.stringify(summary));
process.exitCode = summary.failureCount === 0 ? 0 : 1;

function percentile(q) {
  if (!latencies.length) return null;
  const index = Math.min(latencies.length - 1, Math.max(0, Math.ceil(q * latencies.length) - 1));
  return round(latencies[index]);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function sanitizedUrl(value) {
  const parsed = new URL(value);
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) fail(`${name} must be a positive integer`);
  return value;
}

function nonnegativeInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) fail(`${name} must be a non-negative integer`);
  return value;
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(2);
}

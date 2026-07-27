/** Per-request principal binding via AsyncLocalStorage. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from './config.js';

const als = new AsyncLocalStorage<Principal>();

export function withPrincipal<T>(p: Principal, fn: () => T): T {
  return als.run(p, fn);
}

export function currentPrincipal(): Principal | undefined {
  return als.getStore();
}

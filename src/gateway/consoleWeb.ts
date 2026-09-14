import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const CONSOLE_ROOT = fileURLToPath(new URL('../../console/', import.meta.url));

const CONSOLE_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join('; ');

/**
 * Mount the additive QuaranGate Console web facade.
 *
 * The facade receives no privileged shortcut: browser actions still traverse
 * the existing authenticated `/mcp` transport and the same server-side
 * authorization/executor boundaries as every other client.
 */
export function mountConsoleWeb(app: express.Application): void {
  app.use('/console', (_req, res, next) => {
    res.setHeader('Content-Security-Policy', CONSOLE_CSP);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Some existing gateway unit tests intentionally replace Express with a
  // narrow recorder that has no `static()` helper. Preserve that established
  // test seam without changing production behavior: the real Express runtime
  // always supplies `static`, while the recorder receives a no-op middleware.
  const staticMiddleware = typeof express.static === 'function'
    ? express.static(path.resolve(CONSOLE_ROOT), {
        index: 'index.html',
        fallthrough: false,
        redirect: true,
        dotfiles: 'deny',
        etag: false,
        maxAge: 0,
      })
    : (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();

  app.use('/console', staticMiddleware);
}

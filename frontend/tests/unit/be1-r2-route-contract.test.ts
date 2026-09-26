import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

const routes = [
  ["GET", "src/app/api/product/auth/login/route.ts"],
  ["GET", "src/app/api/product/auth/callback/route.ts"],
  ["GET", "src/app/api/product/session/current/route.ts"],
  ["POST", "src/app/api/product/session/workspace/route.ts"],
  ["POST", "src/app/api/product/session/logout/route.ts"],
] as const;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? routeFiles(path) : name === "route.ts" ? [relative(root, path)] : [];
  });
}

describe("BE1-R2 canonical route contract", () => {
  it.each(routes)("%s %s is the canonical handler", (method, path) => {
    const source = readFileSync(join(root, path), "utf8");
    expect(source).toContain(`export async function ${method}`);
    expect(source).toContain('dynamic = "force-dynamic"');
  });

  it("has exactly five BE1 route handlers and no aliases", () => {
    expect(routeFiles(join(root, "src/app/api/product")).sort()).toEqual(routes.map(([, path]) => path).sort());
  });
});

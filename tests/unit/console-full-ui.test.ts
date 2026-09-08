import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const app = () => readFileSync(join(root, 'console/app.js'), 'utf8');
const styles = () => readFileSync(join(root, 'console/styles.css'), 'utf8');

describe('QuaranGate Console full U1 product contract', () => {
  it('implements every owner-approved primary route without dead placeholder navigation', () => {
    const text = app();
    for (const route of [
      'overview','chat','projects','targets','files','terminal','git','processes','agents','jobs','review','ide-sessions','github','models','monitoring','statistics','security','audit','recovery','settings','tool-lab',
    ]) expect(text).toContain(`['${route}',`);
    for (const handler of [
      'renderProjects','renderReview','renderIdeSessions','renderGitHub','renderModels','renderMonitoring','renderStatistics','renderSecurity','renderAuditEvidence','renderRecovery','renderSettings',
    ]) expect(text).toContain(`function ${handler}(`);
  });

  it('ships the accepted observability and operations views with truthful unknown/deferred states', () => {
    const text = app();
    for (const term of [
      'MCP Traffic & Activity','Runtime topology & provenance','Source → image → runtime drift','Egress policy monitor','Queue & provider health',
      'Incident center','Resource lifecycle & orphan inspector','Authority Explorer / policy preflight','Evidence lineage / chain of custody',
      'Provider capability / qualification matrix','Session continuity inspector','Managed outside Console',
    ]) expect(text).toContain(term);
    expect(text).toContain('UNKNOWN');
    expect(text).toContain('NOT_IMPLEMENTED');
  });

  it('keeps credentials memory-only and never introduces browser persistence or unsafe browser primitives', () => {
    const text = [app(), readFileSync(join(root, 'console/mcp-client.js'), 'utf8')].join('\n');
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(text).not.toMatch(/\balert\s*\(|\bconfirm\s*\(|\bprompt\s*\(/);
    expect(text).not.toMatch(/\beval\s*\(|new Function/);
  });

  it('provides keyboard command search without bypassing normal tool gates', () => {
    const text = app();
    expect(text).toContain("event.key.toLowerCase() === 'k'");
    expect(text).toContain('openCommandPalette()');
    expect(text).toContain("href:`#/tool-lab`");
    expect(text).not.toContain('paletteExecuteTool');
  });

  it('has responsive and accessible operational styling for new surfaces', () => {
    const text = styles();
    expect(text).toContain('.metric-grid');
    expect(text).toContain('.topology-node');
    expect(text).toContain('.palette-results');
    expect(text).toContain('@media (max-width: 620px)');
    expect(text).toContain('@media (prefers-reduced-motion: reduce)');
    expect(text).toContain('@media (forced-colors: active)');
  });
});

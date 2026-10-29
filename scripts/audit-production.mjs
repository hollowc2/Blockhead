import { spawnSync } from 'node:child_process';
// The sole reviewed exception: see docs/public-viewer-security.md. Inherited
// packages have no separate advisory and are checked through their root cause.
const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
let audit;
try { audit = JSON.parse(result.stdout); } catch { throw new Error('Production audit unavailable'); }
if (audit.error || !audit.metadata) throw new Error('Production audit unavailable');
let failed = false;
for (const [name, finding] of Object.entries(audit.vulnerabilities ?? {})) {
  for (const advisory of finding.via) {
    if (typeof advisory === 'string') continue;
    const reviewed = name === 'uuid' && advisory.url === 'https://github.com/advisories/GHSA-w5hq-g745-h8pq' && finding.severity === 'moderate';
    console.log(`${reviewed ? 'REVIEWED (follow-up required)' : 'UNREVIEWED'}: ${name} ${advisory.url}`);
    if (!reviewed) failed = true;
  }
}
console.log(JSON.stringify(audit.metadata.vulnerabilities));
if (failed) process.exitCode = 1;

// Stands in for Renovate in the tests: reads the generated configuration, prints Renovate-style JSON log
// lines, writes a report and behaves as FAKE_MODE says. FAKE_DUMP names a file that receives the
// configuration and the environment the process saw.
import { readFileSync, writeFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(process.env.RENOVATE_CONFIG_FILE, 'utf8'));
const mode = process.env.FAKE_MODE ?? 'ok';
const log = (level, msg, extra = {}) => console.log(JSON.stringify({ name: 'renovate', level, msg, time: new Date().toISOString(), ...extra }));

if (process.env.FAKE_DUMP) {
  const previous = (() => { try { return JSON.parse(readFileSync(process.env.FAKE_DUMP, 'utf8')); } catch { return []; } })();
  writeFileSync(process.env.FAKE_DUMP, JSON.stringify([...previous, { config, env: process.env }]));
}

log(30, 'Renovate started');

if (mode === 'sleep') {
  setInterval(() => {}, 1000);
} else if (mode === 'auth') {
  log(50, 'Authentication failure: Bad credentials');
  process.exit(1);
} else if (mode === 'oom') {
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'plain-text') {
  console.error('something went wrong without JSON');
  process.exit(2);
} else {
  const report = { repositories: {} };
  for (const repository of config.repositories) {
    log(30, 'Repository started', { repository });
    report.repositories[repository] = {
      problems: mode === 'warn' ? [{ level: 40, msg: 'Something odd' }] : [],
      branches: [{ branchName: 'renovate/left-pad-1.x', prNo: 4, prTitle: 'Update dependency left-pad to v1.3.0', result: 'pr-created', upgrades: [{ depName: 'left-pad', currentVersion: '1.0.0', newVersion: '1.3.0', updateType: 'minor' }] }],
      packageFiles: { npm: [{ deps: [{ depName: 'left-pad', updates: [{ newVersion: '1.3.0' }] }, { depName: 'x' }] }] },
    };
    log(30, 'Repository finished', { repository });
  }
  writeFileSync(config.reportPath, JSON.stringify(report));
}

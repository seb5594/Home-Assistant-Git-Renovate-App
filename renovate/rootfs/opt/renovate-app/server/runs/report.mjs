// Reads the report Renovate writes at the end of a run (reportType "file") and reduces it to what the
// web interface shows: pending updates, branches and pull requests per repository, and problems.
const MAX_BRANCHES = 60;
const MAX_UPGRADES = 8;
const MAX_PROBLEMS = 10;

const CREATED = new Set(['pr-created']);
const UPDATED = new Set(['pr-edited', 'rebase']);

function countPendingUpdates(packageFiles) {
  let dependencies = 0;
  for (const files of Object.values(packageFiles ?? {})) {
    for (const file of files) {
      for (const dependency of file.deps ?? []) if (dependency.updates?.length) dependencies += 1;
    }
  }
  return dependencies;
}

function compactBranch(branch) {
  return {
    name: branch.branchName,
    prNo: branch.prNo ?? null,
    prTitle: branch.prTitle ?? null,
    result: branch.result ?? null,
    upgrades: (branch.upgrades ?? []).slice(0, MAX_UPGRADES).map((upgrade) => ({
      depName: upgrade.depName ?? null,
      from: upgrade.currentVersion ?? upgrade.currentValue ?? null,
      to: upgrade.newVersion ?? upgrade.newValue ?? null,
      type: upgrade.updateType ?? null,
    })),
  };
}

/**
 * @param {any} report parsed report.json
 * @returns {Map<string, object>} summary per repository name
 */
export function summarizeReport(report) {
  const summaries = new Map();
  for (const [name, repository] of Object.entries(report?.repositories ?? {})) {
    const branches = repository.branches ?? [];
    const problems = repository.problems ?? [];
    summaries.set(name, {
      pending: countPendingUpdates(repository.packageFiles),
      openPrs: branches.filter((branch) => branch.prNo && branch.result !== 'automerged').length,
      prsCreated: branches.filter((branch) => CREATED.has(branch.result)).length,
      prsUpdated: branches.filter((branch) => UPDATED.has(branch.result)).length,
      automerged: branches.filter((branch) => branch.result === 'automerged').length,
      errors: problems.filter((problem) => problem.level >= 50).length,
      warnings: problems.filter((problem) => problem.level === 40).length,
      problems: problems.slice(0, MAX_PROBLEMS).map((problem) => ({ level: problem.level >= 50 ? 'error' : 'warn', message: [problem.msg, problem.err?.message].filter(Boolean).join(': ').slice(0, 300) })),
      branches: branches.slice(0, MAX_BRANCHES).map(compactBranch),
    });
  }
  return summaries;
}

/** Totals over all repositories of a run. */
export function totals(perRepository) {
  const sum = (key) => [...perRepository.values()].reduce((total, repository) => total + (repository[key] ?? 0), 0);
  return {
    repositories: perRepository.size,
    pending: sum('pending'),
    openPrs: sum('openPrs'),
    prsCreated: sum('prsCreated'),
    prsUpdated: sum('prsUpdated'),
    automerged: sum('automerged'),
    errors: sum('errors'),
    warnings: sum('warnings'),
  };
}

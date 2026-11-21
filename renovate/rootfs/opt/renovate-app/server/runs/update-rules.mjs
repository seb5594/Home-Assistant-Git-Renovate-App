// Turns the "updates" settings into Renovate configuration. Pure function: the result is merged into the
// configuration of every run (see config-builder.mjs) and is covered by unit tests.
//
// What each action means for the updates of one kind (major, minor or patch):
//   repository  nothing is added: the configuration of the repository decides
//   pr          a pull request is opened and left for you to merge
//   approval    the update is listed in the Dependency Dashboard and gets its pull request when you tick it
//   automerge   a pull request is opened and merged by Renovate as soon as its checks are green
//   ignore      the update is not offered at all

// Digests and pins are tiny, mechanical changes: they follow the patch setting.
const UPDATE_TYPES = {
  major: ['major'],
  minor: ['minor'],
  patch: ['patch', 'pin', 'digest', 'pinDigest'],
};

const NON_MAJOR = [...UPDATE_TYPES.minor, ...UPDATE_TYPES.patch];

const RULE_FOR_ACTION = {
  pr: { automerge: false },
  approval: { dependencyDashboardApproval: true, automerge: false },
  automerge: { automerge: true },
  ignore: { enabled: false },
};

/**
 * @param {Record<string, any>} settings effective settings
 * @returns {{packageRules: object[], options: object}} rules to append and options for the top level
 */
export function buildUpdateRules(settings) {
  const packageRules = [];
  const actions = Object.keys(UPDATE_TYPES).map((kind) => settings[`updates.${kind}`]);

  for (const kind of Object.keys(UPDATE_TYPES)) {
    const rule = RULE_FOR_ACTION[settings[`updates.${kind}`]];
    if (rule) packageRules.push({ description: `Renovate app: ${kind} updates`, matchUpdateTypes: UPDATE_TYPES[kind], ...rule });
  }

  if (settings['updates.group_non_major']) {
    packageRules.push({
      description: 'Renovate app: one pull request for all non-major updates',
      matchUpdateTypes: NON_MAJOR,
      groupName: 'all non-major dependencies',
      groupSlug: 'all-non-major',
    });
  }

  const options = {};
  const days = settings['updates.minimum_age_days'];
  if (days > 0) {
    options.minimumReleaseAge = `${days} day${days === 1 ? '' : 's'}`;
    // Many sources (container tags, for example) publish no release date. By default Renovate then holds
    // such updates back forever; here they pass instead, so the wait never silently stops an update.
    options.minimumReleaseAgeBehaviour = 'timestamp-optional';
  }
  if (settings['updates.merge_method'] !== 'auto') options.automergeStrategy = settings['updates.merge_method'];
  // Approval happens on the dashboard, so it has to exist; otherwise the user's choice is respected.
  const dashboard = settings['updates.dashboard'];
  if (actions.includes('approval') || dashboard === true) options.dependencyDashboard = true;
  else if (dashboard === false) options.dependencyDashboard = false;

  return { packageRules, options };
}

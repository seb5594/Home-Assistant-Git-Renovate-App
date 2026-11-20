// Repository name patterns for the include and exclude lists: `*` matches inside one path segment,
// `**` matches across segments and `?` matches one character. Matching ignores case, like most git servers.
const cache = new Map();

export function globToRegExp(pattern) {
  let regex = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      regex += '.*';
      index += 1;
    } else if (char === '*') {
      regex += '[^/]*';
    } else if (char === '?') {
      regex += '[^/]';
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${regex}$`, 'i');
}

export function matchesAny(patterns, name) {
  return patterns.some((pattern) => {
    let regex = cache.get(pattern);
    if (!regex) {
      regex = globToRegExp(pattern);
      cache.set(pattern, regex);
    }
    return regex.test(name);
  });
}

/** Whether a repository is switched on for its connection (see the connections table for the rules). */
export function isRepositoryEnabled(connection, repository) {
  if (!repository.present) return false;
  if (repository.override_enabled === 1) return true;
  if (repository.override_enabled === 0) return false;
  if (connection.mode !== 'all') return false;
  if (!repository.can_push) return false;
  if (connection.skip_archived && repository.is_archived) return false;
  if (connection.skip_forks && repository.is_fork) return false;
  const include = connection.include_patterns;
  if (include.length > 0 && !matchesAny(include, repository.full_name)) return false;
  return !matchesAny(connection.exclude_patterns, repository.full_name);
}

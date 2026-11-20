// Turns the "resources" settings and the size of the machine into limits for Renovate runs.
//
// Renovate is a Node.js program that holds the dependency data of a whole repository in memory, so its
// peak memory decides whether it fits on a small machine. The profiles trade speed for a smaller footprint:
//   light        Raspberry Pi 3/4 with up to 2 GB: one run at a time, small batches, low priority
//   balanced     the default for 2-6 GB
//   performance  more memory and a second parallel run for mini PCs and servers

const MB = 1024 * 1024;

export const PROFILES = Object.freeze({
  light: { maxConcurrentRuns: 1, memoryLimitMb: 512, batchSize: 3, cpuPriority: 15 },
  balanced: { maxConcurrentRuns: 1, memoryLimitMb: 1024, batchSize: 10, cpuPriority: 10 },
  performance: { maxConcurrentRuns: 2, memoryLimitMb: 2048, batchSize: 25, cpuPriority: 5 },
});

/** The profile that fits a machine, by installed memory. */
export function autoProfile(totalMemoryMb) {
  if (totalMemoryMb < 2300) return 'light';
  if (totalMemoryMb < 6000) return 'balanced';
  return 'performance';
}

/**
 * @param {Record<string, any>} values effective settings (see settings/store.mjs)
 * @param {{totalMemoryMb:number, cpus:number}} machine
 */
export function resolveResources(values, machine) {
  const requested = values['resources.profile'];
  const profile = requested === 'auto' ? autoProfile(machine.totalMemoryMb) : requested;
  const base = PROFILES[profile];
  const pick = (key, fallback) => values[`resources.${key}`] ?? fallback;
  // Never plan more parallel runs than there are spare cores, and never let one run take most of the memory.
  const maxConcurrentRuns = Math.max(1, Math.min(pick('max_concurrent_runs', base.maxConcurrentRuns), Math.max(1, machine.cpus - 1)));
  const memoryCeiling = Math.max(256, Math.floor(machine.totalMemoryMb * 0.6));
  return {
    profile,
    automatic: requested === 'auto',
    maxConcurrentRuns,
    memoryLimitMb: Math.min(pick('memory_limit_mb', base.memoryLimitMb), memoryCeiling),
    batchSize: pick('batch_size', base.batchSize),
    cpuPriority: pick('cpu_priority', base.cpuPriority),
    timeoutMs: values['resources.run_timeout_minutes'] * 60_000,
  };
}

export function detectMachine(os) {
  return { totalMemoryMb: Math.round(os.totalmem() / MB), cpus: os.availableParallelism?.() ?? os.cpus().length };
}

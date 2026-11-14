// Blink timeline: one step per exposure, ordered by time.

/**
 * Turn the exposures from /api/view into blink steps.
 * Sorted by mjd, one step per uri (first occurrence wins). No pixels here, so
 * NaN does not apply.
 * @param {Array<{uri: string, mjd: number, date: string, detector: number}>} exposures
 * @returns {Array<{uri: string, mjd: number, date: string, detector: number}>}
 */
export function buildSteps(exposures) {
  const seen = new Set();
  const steps = [];
  for (const e of exposures ?? []) {
    if (seen.has(e.uri)) continue;
    seen.add(e.uri);
    steps.push({ uri: e.uri, mjd: e.mjd, date: e.date, detector: e.detector });
  }
  return steps.sort((a, b) => a.mjd - b.mjd);
}

/**
 * After the step list changes, find which index shows the same exposure as
 * `steps[index]` did. If that uri is gone, pick the step with the nearest mjd.
 * Returns 0 when there is nothing to point at.
 */
export function keepStep(steps, newSteps, index) {
  if (!newSteps.length) return 0;
  const old = steps[index];
  if (!old) return 0;
  const same = newSteps.findIndex((s) => s.uri === old.uri);
  if (same !== -1) return same;
  let best = 0;
  for (let i = 1; i < newSteps.length; i++) {
    if (Math.abs(newSteps[i].mjd - old.mjd) < Math.abs(newSteps[best].mjd - old.mjd)) best = i;
  }
  return best;
}

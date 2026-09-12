const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const GROK_KEYS = Object.freeze([
  'autoUpdate', 'channel', 'currentVersion', 'error', 'installer', 'latestVersion', 'updateAvailable',
]);

export function parseStrictSemver(value) {
  if (typeof value !== 'string') invalid('version_type');
  const match = SEMVER.exec(value);
  if (!match) invalid('version_schema');
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  if (prerelease.some((identifier) => /^\d+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) {
    invalid('version_schema');
  }
  return {
    value,
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

export function compareSemver(left, right) {
  const a = parseStrictSemver(left);
  const b = parseStrictSemver(right);
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] < b.core[index]) return -1;
    if (a.core[index] > b.core[index]) return 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function parseNpmLatestJson(text) {
  let value;
  try { value = JSON.parse(text); } catch { invalid('npm_latest_json'); }
  // npm 12は単一結果も配列で返す。複数版をlatestとして選ばない。
  if (Array.isArray(value) && value.length === 1) [value] = value;
  parseStrictSemver(value);
  return value;
}

export function validateGrokUpdateCheck(value, { postUpdate = false } = {}) {
  if (!isPlainObject(value) || !hasExactKeys(value, GROK_KEYS)) invalid('grok_update_schema');
  parseStrictSemver(value.currentVersion);
  parseStrictSemver(value.latestVersion);
  if (typeof value.updateAvailable !== 'boolean' || value.installer !== 'internal' || value.channel !== 'stable' ||
      !(value.autoUpdate === null || typeof value.autoUpdate === 'boolean') || value.error !== null) {
    invalid('grok_update_schema');
  }
  const relation = compareSemver(value.currentVersion, value.latestVersion);
  if (relation > 0) invalid('downgrade_refused');
  if ((relation < 0) !== value.updateAvailable || (relation === 0) === value.updateAvailable) {
    invalid('grok_update_inconsistent');
  }
  if (postUpdate && (relation !== 0 || value.updateAvailable !== false)) invalid('grok_post_update_incomplete');
  return { ...value };
}

export function parseGrokUpdateJson(text, options = {}) {
  let value;
  try { value = JSON.parse(text); } catch { invalid('grok_update_json'); }
  return validateGrokUpdateCheck(value, options);
}

function invalid(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

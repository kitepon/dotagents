import fs from 'node:fs';

export const RUNNER_PROFILE_PATH = '/etc/dotagents/factory-runner-profile.json';

export function parseDedicatedRunnerProfile(source, metadata) {
  if (!metadata.isFile || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
    throw new Error('dedicated runner profile must be a root-owned regular file without group/other write access');
  }
  const value = JSON.parse(source);
  const expected = {
    schema: 'dotagents.runner-profile.v1', mode: 'dedicated',
    name: 'factory-linux-rabbit-u', user: 'factory-runner',
    service: 'actions.runner.kitepon.factory-linux-rabbit-u.service',
    root: '/home/factory-runner/actions-runner', label: 'linux-workstation',
  };
  for (const [key, wanted] of Object.entries(expected)) {
    if (value[key] !== wanted) throw new Error(`invalid dedicated runner profile field: ${key}`);
  }
  if (value.state !== 'active') throw new Error('dedicated runner profile is not active');
  return Object.fromEntries([...Object.keys(expected), 'state'].map((key) => [key, value[key]]));
}

export function readRunnerProfile(path = RUNNER_PROFILE_PATH) {
  let initial;
  try { initial = fs.lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return { mode: 'legacy' };
    throw error;
  }
  if (!initial.isFile() || initial.uid !== 0 || (initial.mode & 0o022) !== 0) {
    throw new Error('dedicated runner profile must be a root-owned regular file without group/other write access');
  }
  let descriptor;
  descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    const metadata = { isFile: stat.isFile(), uid: stat.uid, mode: stat.mode };
    if (!metadata.isFile || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new Error('dedicated runner profile must be a root-owned regular file without group/other write access');
    }
    return parseDedicatedRunnerProfile(fs.readFileSync(descriptor, 'utf8'), metadata);
  } finally { fs.closeSync(descriptor); }
}

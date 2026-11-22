// Rootless Docker owned by factory-runner on Rabbit (linux-workstation). Contract: docs/feature-map/runner-capacity.md.
// The runner principal stays group-less; jobs reach Docker only through DOCKER_HOST in each pool root's `.env`.
export const DOCKER_SERVICE = 'factory-runner-dockerd.service';
export const DOCKER_RUNTIME_DIR = 'factory-runner-docker';
export const DOCKER_SOCKET = `/run/${DOCKER_RUNTIME_DIR}/docker.sock`;
export const DOCKER_HOST = `unix://${DOCKER_SOCKET}`;
const RUNNER_USER = 'factory-runner';
// The Engine's own rootless launcher: docker-ce-rootless-extras (Docker's apt repository) or Ubuntu's docker.io (contrib).
export const ROOTLESS_SCRIPTS = Object.freeze({
  'docker-ce': '/usr/bin/dockerd-rootless.sh',
  'docker.io': '/usr/share/docker.io/contrib/dockerd-rootless.sh',
});
const HOST_LINE = `DOCKER_HOST=${DOCKER_HOST}`;

// The Listener reads `<root>/.env` as KEY=VALUE lines at start (actions/runner Program.LoadAndSetEnv); jobs inherit it.
export function setDockerHost(source) {
  const lines = source.split('\n').filter((line) => line !== '' && !line.startsWith('DOCKER_HOST='));
  return `${[...lines, HOST_LINE].join('\n')}\n`;
}

export function hasDockerHost(source) {
  const lines = source.split('\n').filter((line) => line.startsWith('DOCKER_HOST='));
  return lines.length === 1 && lines[0] === HOST_LINE;
}

// First free id after every existing range of /etc/subuid or /etc/subgid (user:start:count lines).
export function nextSubidStart(source, floor = 100000) {
  let end = floor;
  for (const line of source.split('\n')) {
    const [, start, count] = line.split(':');
    if (/^\d+$/.test(start ?? '') && /^\d+$/.test(count ?? '')) end = Math.max(end, Number(start) + Number(count));
  }
  return end;
}

export function hasSubidRange(source, count = 65536) {
  return source.split('\n').some((line) => {
    const [user, , size] = line.split(':');
    return user === RUNNER_USER && Number(size) >= count;
  });
}

// newuidmap/newgidmap are setuid, so this unit cannot set NoNewPrivileges; the runner/scaler unit keeps it.
// Nice/CPUWeight match the scaler unit: build work runs in this cgroup, not the scaler's, and must also yield to the Owner.
export function renderDockerdUnit(script = ROOTLESS_SCRIPTS['docker-ce']) {
  if (!Object.values(ROOTLESS_SCRIPTS).includes(script)) throw new Error(`unknown rootless launcher: ${script}`);
  return `[Unit]
Description=Rootless Docker for the dotagents factory runner (factory-runner)
Documentation=https://github.com/kitepon/dotagents/blob/main/docs/feature-map/runner-capacity.md
After=network-online.target systemd-binfmt.service
Wants=network-online.target

[Service]
User=${RUNNER_USER}
Group=${RUNNER_USER}
Environment=HOME=/home/${RUNNER_USER}
Environment=XDG_RUNTIME_DIR=/run/${DOCKER_RUNTIME_DIR}
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns
RuntimeDirectory=${DOCKER_RUNTIME_DIR}
RuntimeDirectoryMode=0700
ExecStart=${script} --host ${DOCKER_HOST}
Restart=on-failure
RestartSec=5
TimeoutStartSec=120
Delegate=cpu cpuset io memory pids
KillMode=mixed
LimitNOFILE=infinity
LimitNPROC=infinity
TasksMax=infinity
UMask=0022
Nice=10
CPUWeight=20

[Install]
WantedBy=multi-user.target
`;
}

#!/usr/bin/env python3
"""Record a live launcher's limited inputs. Never start a writer or restore NVM."""
import argparse
import hashlib
import json
import os
import signal
import stat
import sys
import time

PHASES = {'launcher_input', 'wrapper_before_nvm', 'wrapper_after_nvm',
          'writer_input', 'writer_after_nvm'}
INPUTS = {'HOME', 'PATH', 'PWD', 'SHELL', 'NVM_DIR', 'AGENTS_UPDATE_PATH_PREFIX',
          'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'BASH_ENV', 'ENV',
          'NVM_SYMLINK_CURRENT', 'NVM_CD_FLAGS', 'MANPATH'}
MAX_WINDOW_MS = 48 * 60 * 60 * 1000


class ObservationError(Exception):
    pass


def process_identity(pid):
    with open(f'/proc/{pid}/stat', encoding='utf-8') as handle:
        text = handle.read()
    fields = text[text.rindex(')') + 2:].split()
    status = {}
    with open(f'/proc/{pid}/status', encoding='utf-8') as handle:
        for line in handle:
            key, _, value = line.partition(':')
            if key in {'Uid', 'Gid'}:
                status[key] = [int(item) for item in value.split()]
    cgroups, cgroup_error = None, None
    try:
        with open(f'/proc/{pid}/cgroup', encoding='utf-8') as handle:
            cgroups = [line.rstrip('\n').split(':', 2)[2] for line in handle]
    except (OSError, IndexError) as error:
        cgroup_error = type(error).__name__
    return {'pid': pid, 'ppid': int(fields[1]), 'start_ticks': int(fields[19]),
            'comm': text[text.index('(') + 1:text.rindex(')')],
            'uid_fields': status['Uid'], 'gid_fields': status['Gid'],
            'cgroups': cgroups, 'cgroup_error': cgroup_error}


def token(boot_id, process):
    return f'{boot_id}:{process["pid"]}:{process["start_ticks"]}'


def read_anchor(directory):
    fd = os.open('launcher_input.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 131072:
            raise ObservationError('input_original_not_private')
        with os.fdopen(fd, 'r', encoding='utf-8', closefd=False) as handle:
            return json.load(handle)
    finally:
        os.close(fd)


def collect(args):
    now = time.time_ns() // 1000000
    if args.expires_at <= now or args.expires_at - now > MAX_WINDOW_MS:
        raise ObservationError('capture_window_invalid_or_expired')
    if args.parent_pid != os.getppid():
        raise ObservationError('caller_is_not_direct_parent')
    if not os.path.isabs(args.entry) or not os.path.isabs(args.output_dir):
        raise ObservationError('absolute_path_required')
    if os.path.realpath(args.output_dir) != os.path.normpath(args.output_dir):
        raise ObservationError('output_directory_alias_unaccepted')
    inputs = {}
    for key, present, exported, encoded_value in args.input:
        if not encoded_value.startswith('v:'):
            raise ObservationError('input_encoding_invalid')
        value = encoded_value[2:]
        if key not in INPUTS or key in inputs or present not in {'yes', 'no'} or exported not in {'yes', 'no'} or len(value) > 32768:
            raise ObservationError('input_shape_invalid')
        if present == 'no' and (value or exported != 'no'):
            raise ObservationError('missing_input_has_value')
        if exported == 'yes' and os.environ.get(key) != value:
            raise ObservationError('exported_input_not_inherited')
        if exported == 'no' and key in os.environ:
            raise ObservationError('input_export_state_mismatch')
        inputs[key] = {'present': present == 'yes', 'exported': exported == 'yes', 'value': value if present == 'yes' else None}
    if set(inputs) != INPUTS:
        raise ObservationError('input_whitelist_incomplete')
    directory = os.open(args.output_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(directory)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ObservationError('output_directory_not_private')
        # A surviving pending original is an interrupted capture, never a lock
        # to guess away or an invitation to capture a different job.
        if any(name.endswith('.pending') for name in os.listdir(directory)):
            raise ObservationError('incomplete_capture_original')
        try:
            os.stat(args.phase + '.json', dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ObservationError('stage_already_recorded')
        with open('/proc/sys/kernel/random/boot_id', encoding='ascii') as handle:
            boot_id = handle.read().strip()
        parent = process_identity(args.parent_pid)
        if parent['uid_fields'][1] != os.geteuid():
            raise ObservationError('parent_principal_mismatch')
        identity = token(boot_id, parent)
        ancestry = []
        cursor = parent['ppid']
        ancestry_gap = None
        for _ in range(8):
            if cursor <= 0:
                break
            try:
                ancestor = process_identity(cursor)
                ancestry.append({**ancestor, 'identity': token(boot_id, ancestor)})
                cursor = ancestor['ppid']
            except (OSError, ValueError, KeyError) as error:
                ancestry_gap = type(error).__name__
                break
        if args.phase == 'launcher_input':
            root_identity = identity
        else:
            anchor = read_anchor(directory)
            root_identity = anchor['launcher_identity']
            if root_identity not in [identity] + [item['identity'] for item in ancestry]:
                raise ObservationError('different_launcher_invocation')
        entry_realpath = os.path.realpath(args.entry)
        entry_fd = os.open(entry_realpath, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(entry_fd, 'rb') as handle:
            entry_info = os.fstat(handle.fileno())
            if not stat.S_ISREG(entry_info.st_mode):
                raise ObservationError('entry_source_not_regular')
            entry_bytes = handle.read(1048577)
        if len(entry_bytes) > 1048576:
            raise ObservationError('entry_source_too_large')
        cwd = os.readlink(f'/proc/{args.parent_pid}/cwd')
        after = process_identity(args.parent_pid)
        if parent != after:
            raise ObservationError('parent_changed_during_capture')
        payload = {'schema': 'dotagents.launcher-input-observation.v1', 'kind': 'observed_launcher',
                   'phase': args.phase, 'observed_at_utc_ms': now, 'process': parent,
                   'process_identity': identity, 'launcher_identity': root_identity,
                   'parent_chain': ancestry, 'parent_chain_gap': ancestry_gap,
                   'cwd': cwd, 'invoked_entry': args.entry, 'entry_realpath': entry_realpath,
                   'entry_sha256': hashlib.sha256(entry_bytes).hexdigest(),
                   'restore_inputs': inputs, 'capture_expires_at_utc_ms': args.expires_at,
                   'input_scope': 'explicit nonsecret whitelist; not environment equivalence',
                   'normal_job_binding': 'unknown_until_dispatcher_source_correlation',
                   'nvm_branch_execution': 'not_inferred_from_boundary',
                   'reporting_allowed': False, 'resource_read_authorized': False,
                   'observer_invoked_node_npm_or_nvm': False}
        body = (json.dumps(payload, ensure_ascii=False, sort_keys=True) + '\n').encode()
        if len(body) > 131072:
            raise ObservationError('observation_original_too_large')
        pending, final = args.phase + '.pending', args.phase + '.json'
        fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            file_info = os.fstat(fd)
            if file_info.st_uid != os.geteuid() or stat.S_IMODE(file_info.st_mode) != 0o600:
                raise ObservationError('observation_file_permission_mismatch')
            view = memoryview(body)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise ObservationError('observation_short_write')
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        # link is an exclusive publication, never replacement of a prior job.
        os.link(pending, final, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
        os.unlink(pending, dir_fd=directory)
        os.fsync(directory)
        return {'ok': True, 'phase': args.phase, 'file': final, 'sha256': hashlib.sha256(body).hexdigest()}
    finally:
        os.close(directory)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--phase', choices=sorted(PHASES), required=True)
    parser.add_argument('--parent-pid', type=int, required=True)
    parser.add_argument('--entry', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--expires-at', type=int, required=True)
    parser.add_argument('--input', action='append', nargs=4, default=[])
    args = parser.parse_args()
    try:
        if sys.platform != 'linux':
            raise ObservationError('linux_scope_only')
        def deadline(_signum, _frame):
            raise ObservationError('observer_deadline')
        signal.signal(signal.SIGALRM, deadline)
        signal.alarm(2)
        result = collect(args)
        result['component'] = 'update-context-observer'
        print(json.dumps(result), file=sys.stderr)
        return 0
    except (ObservationError, OSError, ValueError, KeyError) as error:
        result = {'ok': False, 'component': 'update-context-observer', 'phase': args.phase,
                  'reason': str(error) if isinstance(error, ObservationError) else type(error).__name__,
                  'errno': getattr(error, 'errno', None)}
        print(json.dumps(result), file=sys.stderr)
        return 1
    finally:
        if sys.platform == 'linux':
            signal.alarm(0)


if __name__ == '__main__':
    sys.exit(main())

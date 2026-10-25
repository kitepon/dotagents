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
          'writer_input', 'writer_after_nvm', 'prefix_before', 'prefix_result',
          'global_bin_after', 'root_before', 'root_result',
          'public_setup_before', 'public_setup_after'}
OPERATION_PHASES = {'prefix_before', 'prefix_result', 'global_bin_after',
                    'root_before', 'root_result', 'public_setup_before', 'public_setup_after'}
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
        if args.phase in OPERATION_PHASES:
            payload['kind'] = 'observed_writer_operation'
            resolutions = {}
            for name, kind, encoded in args.resolution:
                if name not in {'node', 'npm'} or name in resolutions or not encoded.startswith('v:'):
                    raise ObservationError('resolution_shape_invalid')
                value = encoded[2:]
                if kind not in {'file', 'function', 'builtin', 'alias', 'keyword', 'missing'}:
                    raise ObservationError('resolution_kind_invalid')
                valid = kind == 'file' and os.path.isabs(value) and '\n' not in value and '\r' not in value
                metadata = None
                if valid:
                    realpath = os.path.realpath(value)
                    try:
                        info = os.stat(realpath)
                        metadata = {'realpath': realpath, 'exists_as_regular_file': stat.S_ISREG(info.st_mode),
                                    'device': info.st_dev, 'inode': info.st_ino, 'mtime_ns': info.st_mtime_ns,
                                    'uid': info.st_uid, 'mode': stat.S_IMODE(info.st_mode)}
                    except OSError as error:
                        metadata = {'realpath': realpath, 'read_error': type(error).__name__}
                resolutions[name] = {'kind': kind, 'resolved_path': value if valid else None,
                                     'file_metadata': metadata, 'actual_runtime_or_version': 'unknown'}
            if set(resolutions) != {'node', 'npm'}:
                raise ObservationError('resolution_incomplete')
            payload['command_resolution'] = resolutions
            original = {'exit': args.operation_exit, 'started_at_utc_us': None,
                        'ended_at_utc_us': None, 'clock_status': 'unknown',
                        'value': None, 'value_sha256': None, 'value_status': 'not_captured',
                        'value_semantics': 'existing Bash command-substitution value, trailing LF already removed'}
            if args.operation_exit is not None and not 0 <= args.operation_exit <= 255:
                raise ObservationError('operation_exit_invalid')
            if args.operation_start and args.operation_end:
                try:
                    def micros(text):
                        seconds, fraction = text.split('.')
                        if not seconds.isdecimal() or not fraction.isdecimal() or len(fraction) != 6:
                            raise ValueError('clock')
                        return int(seconds) * 1000000 + int(fraction)
                    start, end = micros(args.operation_start), micros(args.operation_end)
                    if 0 < start <= end <= time.time_ns() // 1000 + 1000000:
                        original.update(started_at_utc_us=start, ended_at_utc_us=end, clock_status='shell_epochrealtime')
                except ValueError:
                    pass
            if args.operation_value is not None:
                if not args.operation_value.startswith('v:'):
                    raise ObservationError('operation_value_encoding_invalid')
                value = args.operation_value[2:]
                original.update(value_sha256=hashlib.sha256(value.encode()).hexdigest(),
                                value_bytes=len(value.encode()), value_status='invalid_path')
                if args.operation_exit == 0 and os.path.isabs(value) and '\n' not in value and '\r' not in value and len(value) <= 32768:
                    original.update(value=value, value_status='absolute_single_path')
            payload['operation_original'] = original
            if args.global_bin is not None:
                if not os.path.isabs(args.global_bin):
                    raise ObservationError('global_bin_not_absolute')
                payload['global_bin_metadata'] = {'path': args.global_bin,
                    'exists_as_directory': os.path.isdir(args.global_bin),
                    'realpath': os.path.realpath(args.global_bin), 'method': 'filesystem metadata only'}
            if args.runtime_exec_path is not None or args.runtime_version is not None:
                import re
                if args.phase not in {'public_setup_before', 'public_setup_after'} or not args.runtime_exec_path or not args.runtime_version or not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?', args.runtime_version):
                    raise ObservationError('runtime_metadata_invalid')
                actual_exe = os.readlink(f'/proc/{args.parent_pid}/exe')
                if os.path.realpath(args.runtime_exec_path) != actual_exe:
                    raise ObservationError('runtime_process_executable_mismatch')
                payload['factory_bridge_runtime'] = {'exec_path': args.runtime_exec_path,
                    'kernel_executable': actual_exe, 'process_version': args.runtime_version,
                    'scope': 'this factory JS process only; product child/core runtime unknown'}
            if args.result_sha256 is not None:
                import re
                if args.phase != 'public_setup_after' or not re.fullmatch('[0-9a-f]{64}', args.result_sha256):
                    raise ObservationError('result_digest_invalid')
                payload['public_setup_stdout_sha256'] = args.result_sha256
            # Prior exact source packets are linked by bytes, never reconstructed from plan.
            predecessors = {
                'prefix_before': ['writer_after_nvm'], 'prefix_result': ['prefix_before'],
                'global_bin_after': ['prefix_result'], 'root_before': ['global_bin_after'],
                'root_result': ['root_before'], 'public_setup_before': ['root_result'],
                'public_setup_after': ['public_setup_before'],
            }
            refs = []
            for phase in predecessors[args.phase]:
                fd = os.open(phase + '.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
                try:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 131072:
                        raise ObservationError('predecessor_not_private')
                    with os.fdopen(fd, 'rb', closefd=False) as handle:
                        packet = handle.read(131073)
                    previous = json.loads(packet)
                    if previous['launcher_identity'] != root_identity or previous.get('phase') != phase:
                        raise ObservationError('predecessor_launcher_mismatch')
                    prior_identity = previous['process_identity']
                    if args.phase in {'prefix_result', 'root_result', 'public_setup_after'}:
                        if prior_identity != identity:
                            raise ObservationError('operation_process_changed')
                    elif args.phase == 'global_bin_after':
                        if identity not in [prior_identity] + [item['identity'] for item in previous['parent_chain']]:
                            raise ObservationError('operation_writer_parent_mismatch')
                    elif prior_identity not in [identity] + [item['identity'] for item in ancestry]:
                        raise ObservationError('predecessor_process_not_ancestor')
                    refs.append({'phase': phase, 'sha256': hashlib.sha256(packet).hexdigest()})
                finally:
                    os.close(fd)
            payload['predecessor_originals'] = refs
            payload['public_core_actual_run'] = 'unknown_requires_product_owned_original'
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
    parser.add_argument('--resolution', action='append', nargs=3, default=[])
    parser.add_argument('--operation-exit', type=int)
    parser.add_argument('--operation-start')
    parser.add_argument('--operation-end')
    parser.add_argument('--operation-value')
    parser.add_argument('--global-bin')
    parser.add_argument('--runtime-exec-path')
    parser.add_argument('--runtime-version')
    parser.add_argument('--result-sha256')
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

"""Core observation protocol. One entry/store; product owns JSON field admission.

Actual activation and product admission verifiers are separate trusted ports.
The ordinary CLI has neither adapter yet and stops unknown. Caller metadata,
including any expected digest, cannot install either verifier.
"""
import hashlib
import json
import os
import re
import stat
import time

MAX_FRAME = 65536
MAX_REPLY = 16384
MAX_PACKET = 131072


class CoreError(Exception):
    pass


def unknown(reason):
    return {'status': 'unknown', 'reason': reason, 'result_original': None,
            'normal_job_binding': 'unknown_until_dispatcher_source_correlation',
            'reporting_allowed': False, 'resource_read_authorized': False}


def integer(value):
    return type(value) is int and value >= 0


def original_ref(name, data):
    return {'ref': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}


def safe_metadata(value):
    """Only the product verifier's bounded metadata, never arbitrary gate text."""
    if not isinstance(value, dict):
        return {}
    result = {}
    if value.get('schema') == 'gpt-connector.setup.v1':
        result['schema'] = value['schema']
    version = value.get('version')
    if isinstance(version, str) and len(version) <= 128 and re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?', version):
        result['version'] = version
    if isinstance(value.get('overall'), str) and value['overall'] in {'ready', 'partial', 'action_required', 'failed'}:
        result['overall'] = value['overall']
    return result


def snapshot(args, shared):
    if args.parent_pid != os.getppid():
        raise CoreError('caller_is_not_direct_parent')
    parent = shared.process_identity(args.parent_pid)
    if parent['uid_fields'][1] != os.geteuid() or parent['gid_fields'][1] != os.getegid():
        raise CoreError('parent_principal_mismatch')
    with open('/proc/sys/kernel/random/boot_id', encoding='ascii') as stream:
        boot = stream.read().strip()
    identity = shared.token(boot, parent)
    ancestors, cursor = [], parent['ppid']
    for _ in range(8):
        if cursor <= 0:
            break
        item = shared.process_identity(cursor)
        ancestors.append({**item, 'identity': shared.token(boot, item)})
        cursor = item['ppid']
    entry = os.path.realpath(args.entry)
    fd = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise CoreError('entry_not_regular')
        data = stream.read(1048577)
    if len(data) > 1048576:
        raise CoreError('entry_too_large')
    cwd = os.readlink(f'/proc/{args.parent_pid}/cwd')
    executable = os.readlink(f'/proc/{args.parent_pid}/exe')
    if shared.process_identity(args.parent_pid) != parent:
        raise CoreError('parent_changed_during_capture')
    return {'process': parent, 'process_identity': identity, 'parent_chain': ancestors,
            'kernel_identity': {'boot_id': boot, 'pid': args.parent_pid,
                                'start_ticks': str(parent['start_ticks']),
                                'effective_uid': parent['uid_fields'][1],
                                'effective_gid': parent['gid_fields'][1],
                                'cwd': cwd, 'executable_realpath': executable},
            'entry_realpath': entry, 'entry_sha256': hashlib.sha256(data).hexdigest()}


def runtime_matches(runtime, observed):
    if not isinstance(runtime, dict):
        return False
    expected = {'pid', 'ppid', 'uid', 'gid', 'cwd', 'exec_path', 'process_version', 'entry_path'}
    if set(runtime) != expected or not all(integer(runtime[k]) for k in ['pid', 'ppid', 'uid', 'gid']):
        return False
    kernel, proc = observed['kernel_identity'], observed['process']
    if proc['uid_fields'][0] != proc['uid_fields'][1] or proc['gid_fields'][0] != proc['gid_fields'][1]:
        return False
    if any(not isinstance(runtime[k], str) or len(runtime[k].encode()) > 4096 for k in ['cwd', 'exec_path', 'process_version', 'entry_path']):
        return False
    return (runtime['pid'] == kernel['pid'] and runtime['ppid'] == proc['ppid']
            and runtime['uid'] == kernel['effective_uid'] and runtime['gid'] == kernel['effective_gid']
            and runtime['cwd'] == kernel['cwd']
            and os.path.isabs(runtime['exec_path'])
            and os.path.realpath(runtime['exec_path']) == kernel['executable_realpath']
            and os.path.isabs(runtime['entry_path'])
            and os.path.realpath(runtime['entry_path']) == observed['entry_realpath']
            and re.fullmatch(r'v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?', runtime['process_version']) is not None)


def handle_core(args, shared, *, verify_activation=None, verify_frame=None,
                frame_input=None, after_frame_saved=None):
    """Injected ports are adopted code, never a callback named by caller JSON.

    Fixtures inject explicitly fixture-kind provenance. No production provenance
    adapter or product parser is invented by this source implementation.
    """
    if verify_activation is None:
        return unknown('expected_pins_provenance_missing')
    directory = None
    try:
        now = time.time_ns() // 1000000
        if not integer(args.expires_at) or not now < args.expires_at <= now + 48 * 3600000:
            raise CoreError('capture_window_invalid_or_expired')
        if not os.path.isabs(args.output_dir) or os.path.realpath(args.output_dir) != os.path.normpath(args.output_dir):
            raise CoreError('activation_alias_unaccepted')
        if not os.path.isabs(args.entry):
            raise CoreError('entry_not_absolute')
        control_text = args.core_control_json or ''
        if len(control_text.encode()) > MAX_REPLY:
            raise CoreError('control_input_too_large')
        control = json.loads(control_text)
        required = {'mode', 'run_id', 'runtime_self'}
        optional = {'core_started_original', 'completion'}
        if not isinstance(control, dict) or not required <= set(control) or set(control) - required - optional:
            raise CoreError('control_shape_invalid')
        if control['mode'] not in {'setup', 'check'} or not isinstance(control['run_id'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', control['run_id']):
            raise CoreError('run_shape_invalid')
        directory = os.open(args.output_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        info = os.fstat(directory)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise CoreError('activation_not_private')
        names = os.listdir(directory)
        if any(name.endswith('.pending') for name in names):
            raise CoreError('incomplete_original_retained')
        observed = snapshot(args, shared)
        if not runtime_matches(control['runtime_self'], observed):
            raise CoreError('runtime_mismatch')
        before_raw = shared.read_original(directory, 'public_setup_before.json')
        before = json.loads(before_raw)
        ancestors = [item['identity'] for item in observed['parent_chain']]
        if before.get('phase') != 'public_setup_before' or before.get('process_identity') not in ancestors:
            raise CoreError('factory_parent_not_ancestor')
        launcher_raw = shared.read_original(directory, 'launcher_input.json')
        launcher = json.loads(launcher_raw)
        if before.get('launcher_identity') != launcher.get('launcher_identity') or launcher.get('launcher_identity') not in ancestors:
            raise CoreError('launcher_mismatch')
        if before.get('capture_expires_at_utc_ms') != args.expires_at or launcher.get('capture_expires_at_utc_ms') != args.expires_at:
            raise CoreError('activation_deadline_mismatch')
        if not integer(before.get('observed_at_utc_ms')) or not integer(launcher.get('observed_at_utc_ms')) or not launcher['observed_at_utc_ms'] <= before['observed_at_utc_ms'] <= now:
            raise CoreError('prior_observation_time_invalid')
        policy = verify_activation(args, observed, before, original_ref('public_setup_before.json', before_raw))
        if not isinstance(policy, dict) or policy.get('kind') not in {'fixture', 'observed'} or not isinstance(policy.get('provenance_ref'), str) or not policy['provenance_ref'] or len(policy['provenance_ref']) > 4096:
            raise CoreError('expected_pins_provenance_unconfirmed')
        # The trusted port must bind exact whole-source pins plus the existing
        # deployment/activation provenance. Mere caller SHA maps are not used.
        if policy.get('whole_source_pins_verified') is not True:
            raise CoreError('whole_source_pins_unconfirmed')
        kind = 'fixture_core' if policy['kind'] == 'fixture' else 'observed_core'
        common = {'schema': 'dotagents.product-core-observation.v1', 'kind': kind,
                  'mode': control['mode'], 'run_id': control['run_id'],
                  **observed, 'runtime_self': control['runtime_self'],
                  'launcher_identity': launcher['launcher_identity'],
                  'public_setup_before': original_ref('public_setup_before.json', before_raw),
                  'activation_provenance_ref': policy['provenance_ref'],
                  'observed_at_utc_ms': now, 'capture_expires_at_utc_ms': args.expires_at,
                  'normal_job_binding': 'unknown_until_dispatcher_source_correlation',
                  'reporting_allowed': False, 'resource_read_authorized': False}
        if args.phase == 'core_begin':
            if set(control) != required or 'core_begin.json' in names:
                raise CoreError('core_begin_already_present_or_invalid')
            body = (json.dumps({**common, 'phase': 'core_begin'}, sort_keys=True) + '\n').encode()
            if len(body) > MAX_PACKET:
                raise CoreError('core_packet_too_large')
            saved = shared.publish(directory, 'core_begin.json', body, readback=True)
            return {'status': 'recorded_raw', 'kind': kind, 'original': saved,
                    'kernel_identity': observed['kernel_identity'],
                    'launcher_identity': launcher['launcher_identity'],
                    'public_setup_before': common['public_setup_before'],
                    'normal_job_binding': common['normal_job_binding'],
                    'reporting_allowed': False, 'resource_read_authorized': False}
        if args.phase != 'core_result' or 'core_result.json' in names or 'core_result.frame' in names:
            raise CoreError('result_present_or_orphan_retained')
        begin_raw = shared.read_original(directory, 'core_begin.json')
        begin = json.loads(begin_raw)
        if control.get('core_started_original') != original_ref('core_begin.json', begin_raw):
            raise CoreError('core_begin_ref_mismatch')
        if any(begin.get(k) != common[k] for k in ['mode', 'run_id', 'process_identity', 'launcher_identity', 'entry_sha256', 'activation_provenance_ref', 'public_setup_before']):
            raise CoreError('core_run_mismatch')
        completion = control.get('completion')
        keys = {'completed_at_utc_ms', 'exit_code', 'serialized_result_sha256', 'serialized_result_bytes', 'stdout_write', 'frame_admission'}
        if not isinstance(completion, dict) or set(completion) != keys:
            raise CoreError('completion_shape_invalid')
        if not integer(completion['exit_code']) or completion['exit_code'] > 255 or not integer(completion['completed_at_utc_ms']) or not begin['observed_at_utc_ms'] <= completion['completed_at_utc_ms'] <= now + 1000:
            raise CoreError('completion_exit_or_time_invalid')
        if not integer(completion['serialized_result_bytes']) or not isinstance(completion['serialized_result_sha256'], str) or not re.fullmatch('[0-9a-f]{64}', completion['serialized_result_sha256']) or completion['stdout_write'] not in {'callback_completed', 'failed', 'not_written'}:
            raise CoreError('completion_digest_or_write_invalid')
        admission = completion['frame_admission']
        admission_keys = {'schema', 'policy', 'decision', 'frame_sha256', 'frame_bytes', 'reason'}
        if not isinstance(admission, dict) or set(admission) != admission_keys or admission['schema'] != 'gpt-connector.core-frame-admission.v1' or admission['policy'] != 'setup_v1_private_metadata_v1' or admission['decision'] not in {'full_frame', 'metadata_only'} or admission['reason'] not in {'accepted', 'frame_too_large', 'invalid_frame', 'unsupported_fields'} or not integer(admission['frame_bytes']) or not isinstance(admission['frame_sha256'], str) or not re.fullmatch('[0-9a-f]{64}', admission['frame_sha256']):
            raise CoreError('frame_admission_shape_invalid')
        admission_matches = (admission['frame_sha256'] == completion['serialized_result_sha256']
                             and admission['frame_bytes'] == completion['serialized_result_bytes'])
        frame, complete_bytes, digest, exact, gate = None, False, None, False, None
        # The product deliberately sends no body for metadata-only admission
        # or an unconfirmed ordinary write. Do not classify that as bad UTF8,
        # termination, or a false digest of an empty original.
        if not admission_matches:
            reason = 'admission_digest_or_size_mismatch'
        elif admission['decision'] != 'full_frame' or admission['reason'] != 'accepted':
            reason = 'product_admission_unknown'
        elif completion['stdout_write'] != 'callback_completed':
            reason = 'output_unconfirmed'
        else:
            if frame_input is None:
                raise CoreError('frame_input_missing')
            frame = frame_input.read(MAX_FRAME + 1)
            complete_bytes = len(frame) <= MAX_FRAME
            digest = hashlib.sha256(frame).hexdigest() if complete_bytes else None
            exact = complete_bytes and len(frame) == completion['serialized_result_bytes'] and digest == completion['serialized_result_sha256']
            reason = 'frame_unconfirmed'
            if complete_bytes:
                try:
                    frame.decode('utf-8', errors='strict')
                    if not frame.endswith(b'\n'):
                        reason = 'frame_termination_invalid'
                    elif not exact:
                        reason = 'frame_digest_or_size_mismatch'
                    elif verify_frame is None:
                        reason = 'product_admission_unavailable'
                    else:
                        # Product owns its one parse/nested gate; verify only
                        # the same-byte admission through the adopted port.
                        gate = verify_frame(frame, admission, policy)
                        reason = 'product_admission_unknown'
                except UnicodeError:
                    reason = 'frame_utf8_invalid'
            else:
                reason = 'frame_too_large'
        allowed = (exact and completion['stdout_write'] == 'callback_completed'
                   and isinstance(gate, dict) and gate.get('status') == 'allowed_full')
        frame_ref = None
        if allowed:
            frame_ref = shared.publish(directory, 'core_result.frame', frame, readback=True)
            if after_frame_saved is not None:
                after_frame_saved()  # Fixture crash seam; never supplied by CLI.
        record = {**common, 'phase': 'core_result', 'core_started_original': original_ref('core_begin.json', begin_raw),
                  'completion': completion, 'result_original': frame_ref,
                  'input_frame_sha256': digest, 'input_frame_bytes': len(frame) if complete_bytes else None,
                  'frame_body_supplied': frame is not None,
                  'metadata_only': not allowed, 'reason': None if allowed else reason,
                  'validated_product_metadata': safe_metadata(gate)}
        body = (json.dumps(record, sort_keys=True) + '\n').encode()
        if len(body) > MAX_PACKET:
            raise CoreError('core_packet_too_large')
        saved = shared.publish(directory, 'core_result.json', body, readback=True)
        if not allowed:
            return {**unknown(reason), 'metadata_original': saved, 'kind': kind}
        return {'status': 'recorded_raw', 'kind': kind, 'original': saved,
                'result_original': frame_ref, 'normal_job_binding': common['normal_job_binding'],
                'reporting_allowed': False, 'resource_read_authorized': False}
    except CoreError as error:
        return unknown(str(error))
    except (OSError, ValueError, TypeError, KeyError, shared.error):
        return unknown('storage_or_source_unconfirmed')
    finally:
        if directory is not None:
            os.close(directory)


def write_reply(reply, fd=3):
    channel = os.fstat(fd)
    if not (stat.S_ISFIFO(channel.st_mode) or stat.S_ISSOCK(channel.st_mode)):
        raise CoreError('reply_channel_not_pipe')
    normal = os.fstat(1)
    if (channel.st_dev, channel.st_ino) == (normal.st_dev, normal.st_ino):
        raise CoreError('reply_channel_is_normal_stdout')
    data = (json.dumps(reply, separators=(',', ':')) + '\n').encode()
    if len(data) > MAX_REPLY:
        data = (json.dumps(unknown('reply_too_large'), separators=(',', ':')) + '\n').encode()
    view = memoryview(data)
    while view:
        count = os.write(fd, view)
        if count <= 0:
            raise CoreError('reply_short_write')
        view = view[count:]

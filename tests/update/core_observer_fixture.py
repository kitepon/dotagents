"""Dedicated fixture adapter. Never imported by the ordinary helper CLI."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import time
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


legacy = module('fixture_shared_observer', ROOT / 'bin/factory-update-context-observer.py')
core = module('fixture_core_protocol', ROOT / 'lib/factory/update_context_core.py')
shared = SimpleNamespace(process_identity=legacy.process_identity, token=legacy.token,
                         read_original=legacy.read_private_original,
                         publish=legacy.publish_original, error=legacy.ObservationError)


def main():
    case, phase, directory, expiry, control_json = sys.argv[1:]
    control = json.loads(control_json)
    args = SimpleNamespace(phase=phase, parent_pid=os.getppid(), entry=control['runtime_self']['entry_path'],
                           output_dir=directory, expires_at=int(expiry), core_control_json=control_json)

    def deadline(_signal, _frame):
        raise legacy.ObservationError('observer_deadline')

    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(2)
    try:
        if phase == 'fixture_bootstrap':
            # Synthetic predecessor packets are explicitly fixture evidence.
            observed = core.snapshot(args, shared)
            now = time.time_ns() // 1000000
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                common = {**observed, 'kind': 'fixture', 'launcher_identity': observed['process_identity'],
                          'observed_at_utc_ms': now, 'capture_expires_at_utc_ms': int(expiry)}
                for name in ['launcher_input', 'public_setup_before']:
                    record = {**common, 'phase': name}
                    if case == 'wrong_factory_parent' and name == 'public_setup_before':
                        record['process_identity'] = 'fixture-wrong-ancestor'
                    shared.publish(fd, name + '.json', (json.dumps(record) + '\n').encode(), readback=True)
            finally:
                os.close(fd)
            core.write_reply({'status': 'fixture_predecessors_created'})
            return

        if case == 'oversized_reply':
            core.write_reply({'padding': 'x' * core.MAX_REPLY})
            return

        # This independently prepared fixture policy is never loaded by the
        # production entry. Its result remains fixture_core, not observed proof.
        policy_path = Path(directory) / 'fixture-policy.json'

        def verify_activation(_args, observed, before, _before_ref):
            raw = policy_path.read_bytes()
            policy = json.loads(raw)
            if policy['kind'] != 'fixture' or case == 'untrusted_pins':
                return None
            for path, expected in policy['source_pins'].items():
                if hashlib.sha256(Path(path).read_bytes()).hexdigest() != expected:
                    return None
            if observed['entry_sha256'] != policy['core_entry_sha256'] or before['entry_sha256'] != policy['factory_entry_sha256']:
                return None
            return {'kind': 'fixture', 'provenance_ref': 'fixture:' + hashlib.sha256(raw).hexdigest(),
                    'whole_source_pins_verified': True}

        def verify_frame(frame, gate, _policy):
            # Synthetic admission seam tests transport/store, not the product
            # schema. Product's one-parse strict validator has its own fixtures.
            allowed = (isinstance(gate, dict) and gate.get('decision') == 'full_frame'
                       and gate.get('frame_sha256') == hashlib.sha256(frame).hexdigest()
                       and gate.get('frame_bytes') == len(frame))
            return {'status': 'allowed_full' if allowed else 'metadata_only_unknown',
                    'schema': 'gpt-connector.setup.v1', 'version': '0.16.4', 'overall': 'partial'}

        stream = sys.stdin.buffer
        if case == 'stall_frame' and phase == 'core_result':
            class StalledFrame:
                def read(self, _limit):
                    time.sleep(3)
                    return b''
            stream = StalledFrame()
        reply = core.handle_core(args, shared, verify_activation=verify_activation,
                                 verify_frame=verify_frame, frame_input=stream,
                                 after_frame_saved=(lambda: os._exit(99)) if case == 'crash_after_frame' else None)
        core.write_reply(reply)
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    main()

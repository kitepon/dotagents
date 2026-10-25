"""Reverse kernel binding for an original factory-process authority sender.

Explicit source port only: no default verifier or CLI/credential/HTTP loader.
The original factory process must own this endpoint and send the response.
A separate process cannot replace its SCM_CREDENTIALS sender identity.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import struct

MAX_REQUEST = 16384
MAX_RESPONSE = 131072
HELPER = str(Path(__file__).resolve().parents[2] / 'bin/factory-update-context-observer.py')
PYTHON = '/usr/bin/python3'


class BrokerError(ValueError):
    pass


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class CoreAuthorityBroker:
    def __init__(self, endpoint, *, product_pid, product_entry, activation, expires_at, before_ref, shared,
                 verify_subjects=None, evidence_kind='observed', factory_sender_pid=None):
        if (endpoint.family != socket.AF_UNIX
                or endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_SEQPACKET
                or evidence_kind not in {'fixture', 'observed'}):
            raise BrokerError('broker_scope_invalid')
        self.endpoint = endpoint
        self.product_pid, self.product_entry = product_pid, os.path.realpath(product_entry)
        self.activation, self.expires_at = activation, expires_at
        self.before_ref = copy.deepcopy(before_ref)
        self.shared, self.verify = shared, verify_subjects
        self.kind = evidence_kind
        self.next_phase, self.run, self.challenges = 'core_begin', None, set()
        with open('/proc/sys/kernel/random/boot_id', encoding='ascii') as stream:
            self.boot = stream.read().strip()
        sender_pid = os.getpid() if factory_sender_pid is None else factory_sender_pid
        if sender_pid not in {os.getpid(), os.getppid()}:
            raise BrokerError('broker_factory_sender_not_parent')
        self.sender = copy.deepcopy(shared.process_identity(sender_pid))
        self.sender_identity = shared.token(self.boot, self.sender)
        endpoint.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        endpoint.settimeout(3.0)

    def _measure(self, helper_pid):
        helper = self.shared.process_identity(helper_pid)
        product = self.shared.process_identity(self.product_pid)
        if helper['ppid'] != self.product_pid or product['ppid'] != self.sender['pid']:
            raise BrokerError('broker_parent_mismatch')
        for value in [helper, product]:
            if (value['uid_fields'][0] != os.geteuid() or value['uid_fields'][1] != os.geteuid()
                    or value['gid_fields'][0] != os.getegid() or value['gid_fields'][1] != os.getegid()):
                raise BrokerError('broker_principal_mismatch')
        with open(f'/proc/{helper_pid}/cmdline', 'rb') as stream:
            argv = stream.read(65537).split(b'\0')
        if argv[-1] == b'': argv.pop()
        argv = [value.decode('utf-8', errors='strict') for value in argv]
        if os.readlink(f'/proc/{helper_pid}/exe') != os.path.realpath(PYTHON):
            raise BrokerError('broker_helper_executable_mismatch')
        with open(self.product_entry, 'rb') as stream:
            entry_raw = stream.read(1048577)
        if len(entry_raw) > 1048576:
            raise BrokerError('broker_entry_too_large')
        kernel = {'boot_id': self.boot, 'pid': product['pid'], 'start_ticks': str(product['start_ticks']),
                  'effective_uid': product['uid_fields'][1], 'effective_gid': product['gid_fields'][1],
                  'cwd': os.readlink(f'/proc/{product["pid"]}/cwd'),
                  'executable_realpath': os.readlink(f'/proc/{product["pid"]}/exe')}
        if helper != self.shared.process_identity(helper_pid) or product != self.shared.process_identity(product['pid']):
            raise BrokerError('broker_process_changed')
        return helper, product, argv, kernel, {'path': self.product_entry, 'sha256': sha(entry_raw)}

    def _authorize(self, request, credentials, *, kernel_only=False):
        pid, uid, gid = credentials
        if (uid, gid) != (os.geteuid(), os.getegid()):
            raise BrokerError('broker_sender_principal_mismatch')
        binding = request['binding']
        helper, product, argv, kernel, entry = self._measure(pid)
        # The expected invocation comes from the actual helper argv and the
        # factory-owned child/activation, not from desired caller pins.
        prefix = [PYTHON, '-I', '-S', HELPER, '--phase', self.next_phase,
                  '--parent-pid', str(self.product_pid), '--entry', self.product_entry,
                  '--output-dir', self.activation, '--expires-at', str(self.expires_at), '--core-control-json']
        if argv[:len(prefix)] != prefix or len(argv) != len(prefix) + 2 or argv[-1] != '--core-authority':
            raise BrokerError('broker_fixed_invocation_mismatch')
        control_raw = argv[len(prefix)].encode()
        if len(control_raw) > MAX_REQUEST:
            raise BrokerError('broker_control_too_large')
        control = json.loads(control_raw)
        expected = {'phase': self.next_phase, 'run_id': control['run_id'], 'mode': control['mode'],
                    'control_sha256': sha(control_raw), 'control_bytes': len(control_raw),
                    'activation': self.activation, 'expires_at': self.expires_at,
                    'process_identity': self.shared.token(self.boot, product), 'kernel_identity': kernel,
                    'factory_identity': self.sender_identity, 'public_setup_before': self.before_ref,
                    'entry': entry, 'helper_entry': 'bin/factory-update-context-observer.py',
                    'authority_fd': 4, 'reply_fd': 3}
        if binding != expected or (self.run is not None and self.run != (control['run_id'], control['mode'])):
            raise BrokerError('broker_run_binding_mismatch')
        self.run = (control['run_id'], control['mode'])
        self.next_phase = 'core_result' if self.next_phase == 'core_begin' else None
        if kernel_only:
            return {'status': 'kernel_bound', 'binding': expected,
                    'sender': copy.deepcopy(self.sender), 'helper': helper, 'product': product}
        if self.verify is None:
            raise BrokerError('broker_verifier_unavailable')
        subjects = copy.deepcopy(self.verify(copy.deepcopy(expected)))
        if not isinstance(subjects, dict) or set(subjects) != {'factory', 'product'}:
            raise BrokerError('broker_subjects_unconfirmed')
        if (helper != self.shared.process_identity(pid) or product != self.shared.process_identity(product['pid'])
                or self.sender != self.shared.process_identity(self.sender['pid'])):
            raise BrokerError('broker_process_changed')
        return {'status': 'verified', 'kind': self.kind, 'binding': expected, 'subjects': subjects}

    def receive_for_original_node(self):
        # Fixed child receiver returns kernel evidence only. It never writes an
        # authority response and never verifies/labels source subjects.
        if self.sender['pid'] != os.getppid():
            raise BrokerError('broker_original_node_not_parent')
        raw, ancillary, flags, _address = self.endpoint.recvmsg(MAX_REQUEST + 1, socket.CMSG_SPACE(12))
        credentials = [struct.unpack('3i', value) for level, kind, value in ancillary
                       if level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(value) == 12]
        if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or len(raw) > MAX_REQUEST or len(credentials) != 1:
            raise BrokerError('broker_request_incomplete')
        request = json.loads(raw)
        if (not isinstance(request, dict) or request.get('schema') != 'dotagents.core-authority-request.v1'
                or not isinstance(request.get('challenge'), str) or not re.fullmatch('[0-9a-f]{64}', request['challenge'])):
            raise BrokerError('broker_request_invalid')
        result = self._authorize(request, credentials[0], kernel_only=True)
        return {'schema': 'dotagents.core-kernel-receipt.v1', 'request_sha256': sha(raw),
                'challenge': request['challenge'], **result}

    def serve_once(self):
        if self.sender['pid'] != os.getpid():
            raise BrokerError('broker_receiver_cannot_replace_sender')
        raw, ancillary, flags, _address = self.endpoint.recvmsg(MAX_REQUEST + 1, socket.CMSG_SPACE(12))
        credentials = [struct.unpack('3i', value) for level, kind, value in ancillary
                       if level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(value) == 12]
        response = {'status': 'unknown', 'reason': 'broker_request_unconfirmed'}
        try:
            if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or len(raw) > MAX_REQUEST or len(credentials) != 1:
                raise BrokerError('broker_request_incomplete')
            request = json.loads(raw)
            if (not isinstance(request, dict) or request.get('schema') != 'dotagents.core-authority-request.v1'
                    or not isinstance(request.get('challenge'), str)
                    or not re.fullmatch('[0-9a-f]{64}', request['challenge'])
                    or request['challenge'] in self.challenges):
                raise BrokerError('broker_request_replay_or_invalid')
            self.challenges.add(request['challenge'])
            response = self._authorize(request, credentials[0])
        except Exception:
            # No private argv, source bytes, arbitrary verifier exception text.
            response = {'status': 'unknown', 'reason': 'broker_authority_unconfirmed'}
        response.update(schema='dotagents.core-authority-response.v1', request_sha256=sha(raw))
        body = encode(response)
        if len(body) > MAX_RESPONSE:
            body = encode({'schema': response['schema'], 'request_sha256': sha(raw), 'status': 'unknown', 'reason': 'broker_response_too_large'})
        if self.endpoint.send(body) != len(body):
            raise BrokerError('broker_response_short_write')
        return response['status']

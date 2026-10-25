"""Source-only authority channel adapter; the ordinary CLI never imports it.

Fixed bootstrap owns AF_UNIX/SOCK_SEQPACKET fd4 and trusted factory identity.
The existing deployment verifier must run before its broker sends a response.
No credential, module name, expected-pins map or verifier is read from control.
This module checks transport/binding, not issuer trust or nested product JSON.
"""
import base64
import copy
import hashlib
import json
import os
import secrets
import stat
import socket
import struct

HELPER_ENTRY = 'bin/factory-update-context-observer.py'
AUTHORITY_FD = 4
REPLY_FD = 3
MAX_AUTHORITY = 131072
FACTORY_ROLES = {'helper', 'core_protocol', 'trust_adapter', 'trusted_loader',
                 'authority_broker', 'launcher', 'wrapper', 'writer', 'public_bridge',
                 'node_authority_broker', 'kernel_receiver', 'channel_provisioner',
                 'subject_sources', 'product_bootstrap', 'public_preload', 'preload_record', 'bootstrap_record'}
PRODUCT_ROLES = {'core', 'formatter', 'serializer', 'admission', 'core_registration'}


class AuthorityError(ValueError):
    pass


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False).encode('utf-8')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def original(packet):
    if not isinstance(packet, dict) or set(packet) != {'bytes_base64', 'sha256', 'bytes'}:
        raise AuthorityError('authority_original_invalid')
    raw = base64.b64decode(packet['bytes_base64'], validate=True)
    if (base64.b64encode(raw).decode('ascii') != packet['bytes_base64']
            or type(packet['bytes']) is not int or packet['bytes'] != len(raw)
            or len(raw) > MAX_AUTHORITY or packet['sha256'] != digest(raw)):
        raise AuthorityError('authority_original_mismatch')
    return raw, json.loads(raw)


class AuthorityChannel:
    """One request per helper invocation, on a fixed bootstrap-owned endpoint.

    sender is an adopted bootstrap measurement (pid/uid/gid/start_ticks), never
    values supplied by product JSON. SCM_CREDENTIALS authenticates each message;
    SO_PEERCRED alone describes socket creation, before descriptor inheritance.
    Bootstrap must retain only the opposite endpoint in its own process.
    """
    def __init__(self, endpoint, sender, process_identity):
        if (endpoint.family != socket.AF_UNIX
                or endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_SEQPACKET):
            raise AuthorityError('authority_channel_kind_invalid')
        self._socket = endpoint
        self._sender = copy.deepcopy(sender)
        self._identity = process_identity
        self._used = False
        endpoint.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        endpoint.settimeout(1.0)

    def exchange(self, request):
        if self._used:
            raise AuthorityError('authority_channel_reused')
        self._used = True  # Reserve before any external work.
        bound = {'schema': 'dotagents.core-authority-request.v1',
                 'challenge': secrets.token_hex(32), 'binding': copy.deepcopy(request)}
        request_bytes = encoded(bound)
        if len(request_bytes) > 16384:
            raise AuthorityError('authority_request_too_large')
        endpoint = self._socket
        try:
            if endpoint.send(request_bytes) != len(request_bytes):
                raise AuthorityError('authority_request_short_write')
            raw, ancillary, flags, _address = endpoint.recvmsg(MAX_AUTHORITY + 1, socket.CMSG_SPACE(12))
            credentials = [struct.unpack('3i', data) for level, kind, data in ancillary
                           if level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(data) == 12]
            if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or len(raw) > MAX_AUTHORITY or len(credentials) != 1:
                raise AuthorityError('authority_response_incomplete')
            pid, uid, gid = credentials[0]
            expected = self._sender
            if (pid, uid, gid) != (expected['pid'], expected['uid_fields'][1], expected['gid_fields'][1]):
                raise AuthorityError('authority_sender_mismatch')
            if self._identity(pid) != expected:
                raise AuthorityError('authority_sender_changed')
            response = json.loads(raw)
            if (response.get('schema') != 'dotagents.core-authority-response.v1'
                    or response.get('request_sha256') != digest(request_bytes)):
                raise AuthorityError('authority_response_replay_or_binding_mismatch')
            return response
        finally:
            endpoint.close()


def verified_subject(value, kind, entry):
    """Check originals delivered by the authenticated, trusted verifier process.

    Checks are exact retained verifier outputs, not pre-verification inputs.
    The broker owns existing verifyProvenance/verifyAdoption/verifyCurrent and
    issuer resolution. A missing implementation must send status=unknown.
    """
    if not isinstance(value, dict) or value.get('subject') != kind:
        raise AuthorityError('authority_subject_missing')
    _bundle_bytes, bundle = original(value['source_original'])
    _receipt_bytes, receipt = original(value['receipt_original'])
    _checks_bytes, checks = original(value['verification_original'])
    if (checks.get('status') != 'verified' or not checks.get('issuer') or not checks.get('trust_ref')
            or checks.get('source_original_sha256') != value['source_original']['sha256']
            or checks.get('receipt_original_sha256') != value['receipt_original']['sha256']
            or bundle.get('schema') != 'factory.deployment-sources.v1'
            or bundle.get('factory_payload_sha256') != checks.get('factory_payload_sha256')
            or checks.get('current_receipt_sha256') != value['receipt_original']['sha256']):
        raise AuthorityError('authority_verification_unconfirmed')
    # Full verifier returns must survive transport. Extra fields are retained.
    if checks.get('provenance') != bundle.get('provenance', {}).get('subject') or not isinstance(checks.get('provenance'), dict):
        raise AuthorityError('authority_provenance_mismatch')
    if checks.get('adoption') != bundle.get('adoption', {}).get('subject') or not isinstance(checks.get('adoption'), dict):
        raise AuthorityError('authority_adoption_mismatch')
    if receipt.get('evidence_ref') != checks.get('evidence_ref'):
        raise AuthorityError('authority_receipt_mismatch')
    capture = bundle.get('capture', {})
    if kind == 'product' and (capture.get('artifact_or_tree_kind') != 'artifact'
                              or not capture.get('artifact_sha256')):
        raise AuthorityError('authority_product_artifact_missing')
    manifest_bytes = base64.b64decode(capture['manifest_bytes_base64'], validate=True)
    if digest(manifest_bytes) != capture.get('manifest_sha256') or checks.get('manifest_sha256') != capture.get('manifest_sha256'):
        raise AuthorityError('authority_manifest_mismatch')
    manifest = json.loads(manifest_bytes)
    roles = FACTORY_ROLES if kind == 'factory' else PRODUCT_ROLES
    files = manifest.get('files', [])
    if not roles <= {item.get('role') for item in files}:
        raise AuthorityError('authority_whole_source_incomplete')
    role = 'public_bridge' if kind == 'factory' else 'core'
    matching = [item for item in files if item.get('role') == role]
    if len(matching) != 1 or matching[0].get('path') != entry['path'] or matching[0].get('sha256') != entry['sha256']:
        raise AuthorityError('authority_entry_mismatch')
    return copy.deepcopy(value)


def activation_subject(request, subjects, kind):
    """Run-common verified identity, distinct from each phase's authority proof.

    Rechecking current authority can yield new timestamps/proof bytes. Retain
    those exact phase originals, but compare the same accepted source/receipt,
    issuer/trust and run binding across begin/result. Never drop a run field.
    """
    keys = ('run_id', 'mode', 'activation', 'expires_at', 'process_identity',
            'kernel_identity', 'factory_identity', 'public_setup_before',
            'entry', 'helper_entry', 'authority_fd', 'reply_fd')
    accepted = {}
    for name in ('factory', 'product'):
        value = subjects[name]
        _raw, checks = original(value['verification_original'])
        accepted[name] = {
            'source_original': {key: value['source_original'][key] for key in ('sha256', 'bytes')},
            'receipt_original': {key: value['receipt_original'][key] for key in ('sha256', 'bytes')},
            'issuer': checks['issuer'], 'trust_ref': checks['trust_ref'],
        }
    return {'schema': 'dotagents.core-activation-subject.v1', 'kind': kind,
            'binding': {key: copy.deepcopy(request[key]) for key in keys},
            'subjects': accepted}


def retain_authority(args, shared, body):
    """Use the existing private, nonreplacement store; never another root."""
    if len(body) > MAX_AUTHORITY:
        raise AuthorityError('authority_retained_original_too_large')
    directory = os.open(args.output_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(directory)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise AuthorityError('authority_store_not_private')
        if args.phase not in {'core_begin', 'core_result'}:
            raise AuthorityError('authority_phase_invalid')
        name = args.phase + '.authority.json'
        saved = shared.publish(directory, name, body, readback=True)
        if saved != {'ref': name, 'sha256': digest(body), 'bytes': len(body)}:
            raise AuthorityError('authority_retention_unconfirmed')
        return saved
    finally:
        os.close(directory)


def create_core_ports(channel, *, sender_identity, retain_original):
    """Fixed helper bootstrap composition; no CLI/module/plugin lookup.

    Returns callbacks for the existing single-store handle_core. The local
    policy object is private per invocation; it is never a serialized token.
    """
    owned = {'used': False}

    def verify_activation(args, observed, before, before_ref):
        if owned['used']:
            raise AuthorityError('authority_activation_reused')
        owned['used'] = True
        if before.get('process_identity') != sender_identity or sender_identity not in {row['identity'] for row in observed['parent_chain']}:
            raise AuthorityError('authority_factory_ancestor_mismatch')
        control_bytes = (args.core_control_json or '').encode('utf-8')
        control = json.loads(control_bytes)
        request = {'phase': args.phase, 'run_id': control['run_id'], 'mode': control['mode'],
                   'control_sha256': digest(control_bytes), 'control_bytes': len(control_bytes),
                   'activation': args.output_dir, 'expires_at': args.expires_at,
                   'process_identity': observed['process_identity'], 'kernel_identity': observed['kernel_identity'],
                   'factory_identity': sender_identity, 'public_setup_before': before_ref,
                   'entry': {'path': observed['entry_realpath'], 'sha256': observed['entry_sha256']},
                   'helper_entry': HELPER_ENTRY, 'authority_fd': AUTHORITY_FD, 'reply_fd': REPLY_FD}
        response = channel.exchange(request)
        if response.get('status') != 'verified' or response.get('binding') != request or response.get('kind') not in {'fixture', 'observed'}:
            raise AuthorityError('authority_binding_unconfirmed')
        subjects = response.get('subjects', {})
        if set(subjects) != {'factory', 'product'}:
            raise AuthorityError('authority_two_subjects_required')
        factory = verified_subject(subjects['factory'], 'factory', {'path': before['entry_realpath'], 'sha256': before['entry_sha256']})
        product = verified_subject(subjects['product'], 'product', request['entry'])
        # These exact original packets are available to the existing metadata
        # store as one private provenance reference. They are not stdout data.
        activation = activation_subject(request, {'factory': factory, 'product': product}, response['kind'])
        provenance = {'factory': factory, 'product': product, 'binding': request,
                      'activation_subject': activation}
        policy = {'kind': response['kind'],
                  'provenance_ref': 'authority-activation-sha256:' + digest(encoded(activation)),
                  'whole_source_pins_verified': True}
        retained = retain_original(args, encoded(provenance))
        if (not isinstance(retained, dict) or retained.get('sha256') != digest(encoded(provenance))
                or retained.get('bytes') != len(encoded(provenance))
                or retained.get('ref') != args.phase + '.authority.json'):
            raise AuthorityError('authority_retention_unconfirmed')
        policy['authority_original'] = copy.deepcopy(retained)
        owned.update(policy=policy, completion=copy.deepcopy(control.get('completion')), frame_used=False,
                     originals=copy.deepcopy(provenance))
        return policy

    def verify_frame(frame, admission, policy):
        if policy is not owned.get('policy') or owned.get('frame_used', True):
            raise AuthorityError('authority_frame_reused_or_foreign')
        owned['frame_used'] = True
        completion = owned['completion']
        if (not isinstance(completion, dict) or completion.get('frame_admission') != admission
                or completion.get('stdout_write') != 'callback_completed'
                or admission.get('decision') != 'full_frame' or admission.get('reason') != 'accepted'
                or admission.get('frame_sha256') != digest(frame) or admission.get('frame_bytes') != len(frame)
                or completion.get('serialized_result_sha256') != digest(frame)
                or completion.get('serialized_result_bytes') != len(frame)):
            raise AuthorityError('authority_frame_binding_mismatch')
        return {'status': 'allowed_full'}  # No nested product parser/serializer.

    def originals():
        return copy.deepcopy(owned.get('originals'))

    return verify_activation, verify_frame, originals

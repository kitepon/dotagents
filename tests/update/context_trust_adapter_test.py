"""New authority transport/binding conditions only; all verifiers are fixtures."""
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import socket
import struct
import unittest
import tempfile
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('trust_adapter', ROOT / 'lib/factory/update_context_trust.py')
trust = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trust)


def packet(value):
    body = trust.encoded(value)
    return {'bytes_base64': base64.b64encode(body).decode(), 'bytes': len(body), 'sha256': trust.digest(body)}


def subject(kind, entry):
    roles = trust.FACTORY_ROLES if kind == 'factory' else trust.PRODUCT_ROLES
    main = 'public_bridge' if kind == 'factory' else 'core'
    manifest = trust.encoded({'files': [{'role': role, **(entry if role == main else {'path': '/fixture/' + role, 'sha256': 'c' * 64})} for role in sorted(roles)]})
    capture = {'artifact_or_tree_kind': 'tree' if kind == 'factory' else 'artifact',
               'artifact_sha256': None if kind == 'factory' else 'a' * 64,
               'manifest_bytes_base64': base64.b64encode(manifest).decode(), 'manifest_sha256': trust.digest(manifest)}
    provenance, adoption = {'fixture_source': kind, 'extra': ['retained']}, {'targets': ['fixture_target'], 'extra': 'retained'}
    bundle = packet({'schema': 'factory.deployment-sources.v1', 'factory_payload_sha256': 'b' * 64,
                     'capture': capture, 'provenance': {'subject': provenance}, 'adoption': {'subject': adoption}})
    receipt = packet({'evidence_ref': 'fixture:' + kind})
    checks = packet({'status': 'verified', 'issuer': 'fixture-only', 'trust_ref': 'fixture:trust',
                     'source_original_sha256': bundle['sha256'], 'receipt_original_sha256': receipt['sha256'],
                     'current_receipt_sha256': receipt['sha256'], 'factory_payload_sha256': 'b' * 64,
                     'manifest_sha256': capture['manifest_sha256'], 'provenance': provenance, 'adoption': adoption,
                     'evidence_ref': 'fixture:' + kind})
    return {'subject': kind, 'source_original': bundle, 'receipt_original': receipt, 'verification_original': checks}


class AdapterTests(unittest.TestCase):
    def fixture(self, mutate=lambda value: None, retain=None):
        frame = b'{"fixture":"this is not product schema"}\n'
        admission = {'decision': 'full_frame', 'reason': 'accepted', 'frame_sha256': trust.digest(frame), 'frame_bytes': len(frame)}
        completion = {'stdout_write': 'callback_completed', 'frame_admission': admission,
                      'serialized_result_sha256': trust.digest(frame), 'serialized_result_bytes': len(frame), 'exit_code': 2}
        control = {'run_id': 'fixture-run', 'mode': 'setup', 'completion': completion}
        args = SimpleNamespace(phase='core_result', core_control_json=json.dumps(control), output_dir='/fixture/private', expires_at=12345)
        observed = {'process_identity': 'fixture:product', 'kernel_identity': {'pid': 222},
                    'parent_chain': [{'identity': 'fixture:factory'}], 'entry_realpath': '/fixture/core', 'entry_sha256': 'a' * 64}
        before = {'process_identity': 'fixture:factory', 'entry_realpath': '/fixture/bridge', 'entry_sha256': 'b' * 64}
        saved = []
        class Channel:
            def exchange(self, request):
                response = {'status': 'verified', 'binding': copy.deepcopy(request), 'kind': 'fixture',
                            'subjects': {'factory': subject('factory', {'path': '/fixture/bridge', 'sha256': 'b' * 64}),
                                         'product': subject('product', {'path': '/fixture/core', 'sha256': 'a' * 64})}}
                mutate(response)
                return response
        def retain_fixture(args, body):
            saved.append(body)
            return {'ref': args.phase + '.authority.json', 'sha256': trust.digest(body), 'bytes': len(body)}
        activation, verify, originals = trust.create_core_ports(Channel(), sender_identity='fixture:factory', retain_original=retain or retain_fixture)
        return args, observed, before, frame, admission, activation, verify, originals, saved

    def test_same_run_exact_originals_and_single_frame(self):
        args, observed, before, frame, gate, activate, verify, originals, saved = self.fixture()
        policy = activate(args, observed, before, {'sha256': 'd' * 64, 'bytes': 12, 'ref': 'public_setup_before.json'})
        self.assertEqual(policy['kind'], 'fixture')
        self.assertEqual(verify(frame, gate, policy), {'status': 'allowed_full'})
        self.assertEqual(len(saved), 1)
        source = originals(); source['factory'].clear()
        self.assertTrue(originals()['factory'])
        with self.assertRaises(trust.AuthorityError):
            verify(frame, gate, policy)

    def test_two_independent_subjects_are_required(self):
        for kind in ['factory', 'product']:
            with self.subTest(kind=kind):
                self.assert_rejected(lambda response: response['subjects'].pop(kind))

    def assert_rejected(self, mutate):
        args, observed, before, _frame, _gate, activate, _verify, _originals, saved = self.fixture(mutate)
        with self.assertRaises((trust.AuthorityError, KeyError)):
            activate(args, observed, before, {})
        self.assertEqual(saved, [])

    def test_wrong_run_activation_or_phase_cannot_reuse_authority(self):
        for key in ['run_id', 'activation', 'phase', 'process_identity', 'control_sha256']:
            with self.subTest(key=key):
                self.assert_rejected(lambda response: response['binding'].__setitem__(key, 'foreign'))

    def test_exact_original_or_subject_change_is_rejected(self):
        self.assert_rejected(lambda response: response['subjects']['product']['source_original'].__setitem__('sha256', 'e' * 64))
        self.assert_rejected(lambda response: response['subjects']['product'].__setitem__('subject', 'factory'))
        def changed_source(response):
            value = response['subjects']['product']; _raw, bundle = trust.original(value['source_original'])
            bundle['capture']['artifact_or_tree_kind'] = 'tree'
            value['source_original'] = packet(bundle)
            _raw, checks = trust.original(value['verification_original'])
            checks['source_original_sha256'] = value['source_original']['sha256']
            value['verification_original'] = packet(checks)
        self.assert_rejected(changed_source)

    def test_unverified_issuer_or_whole_source_is_rejected(self):
        for key in ['status', 'issuer', 'trust_ref']:
            def change(response):
                value = response['subjects']['factory']; _raw, checks = trust.original(value['verification_original'])
                checks[key] = 'unknown' if key == 'status' else None
                value['verification_original'] = packet(checks)
            with self.subTest(key=key): self.assert_rejected(change)

    def test_incomplete_whole_source_or_wrong_entry_is_rejected(self):
        for mutation in ['missing_role', 'wrong_entry']:
            def change(response):
                value = response['subjects']['factory']
                _raw, bundle = trust.original(value['source_original'])
                manifest = json.loads(base64.b64decode(bundle['capture']['manifest_bytes_base64']))
                if mutation == 'missing_role':
                    manifest['files'] = [row for row in manifest['files'] if row['role'] != 'trusted_loader']
                else:
                    for row in manifest['files']:
                        if row['role'] == 'public_bridge': row['sha256'] = 'e' * 64
                raw = trust.encoded(manifest)
                bundle['capture']['manifest_bytes_base64'] = base64.b64encode(raw).decode()
                bundle['capture']['manifest_sha256'] = trust.digest(raw)
                value['source_original'] = packet(bundle)
                _raw, checks = trust.original(value['verification_original'])
                checks['source_original_sha256'] = value['source_original']['sha256']
                checks['manifest_sha256'] = bundle['capture']['manifest_sha256']
                value['verification_original'] = packet(checks)
            with self.subTest(mutation=mutation): self.assert_rejected(change)

    def test_foreign_policy_or_frame_preserves_original_completion(self):
        args, observed, before, frame, gate, activate, verify, originals, _saved = self.fixture()
        policy = activate(args, observed, before, {})
        with self.assertRaises(trust.AuthorityError): verify(frame, gate, copy.deepcopy(policy))
        with self.assertRaises(trust.AuthorityError): verify(frame + b' ', gate, policy)
        self.assertEqual(originals()['binding']['control_sha256'], trust.digest(args.core_control_json.encode()))

    def test_existing_private_store_readback_and_nonreplacement(self):
        spec = importlib.util.spec_from_file_location('authority_fixture_store', ROOT / 'bin/factory-update-context-observer.py')
        store = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(store)
        with tempfile.TemporaryDirectory(prefix='core-authority-') as directory:
            args = SimpleNamespace(output_dir=directory, phase='core_result')
            body = b'{"fixture_authority":"original"}\n'
            shared = SimpleNamespace(publish=store.publish_original)
            saved = trust.retain_authority(args, shared, body)
            self.assertEqual(saved, {'ref': 'core_result.authority.json', 'sha256': trust.digest(body), 'bytes': len(body)})
            self.assertEqual((Path(directory) / saved['ref']).read_bytes(), body)
            with self.assertRaises((store.ObservationError, OSError)):
                trust.retain_authority(args, shared, b'replacement')
            self.assertEqual((Path(directory) / saved['ref']).read_bytes(), body)

    def test_failed_retention_cannot_authorize_frame(self):
        values = self.fixture(retain=lambda _args, _body: None)
        args, observed, before, frame, gate, activate, verify, _originals, _saved = values
        with self.assertRaises(trust.AuthorityError): activate(args, observed, before, {})
        with self.assertRaises(trust.AuthorityError): verify(frame, gate, {})


@unittest.skipUnless(hasattr(socket, 'SCM_CREDENTIALS'), 'Linux authority channel only')
class ChannelTests(unittest.TestCase):
    def exchange(self, response_mode='normal', sender_mode='normal'):
        client, server = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        child = os.fork()
        if child == 0:
            try:
                client.close()
                raw = server.recv(16384)
                body = {'schema': 'dotagents.core-authority-response.v1', 'request_sha256': trust.digest(raw), 'status': 'unknown'}
                if response_mode == 'replay': body['request_sha256'] = '0' * 64
                if response_mode == 'oversize': body['padding'] = 'x' * trust.MAX_AUTHORITY
                server.send(trust.encoded(body))
            finally:
                server.close()
                os._exit(0)
        server.close()
        identity = {'pid': child, 'uid_fields': [os.getuid(), os.geteuid()], 'gid_fields': [os.getgid(), os.getegid()], 'start_ticks': 123}
        expected = copy.deepcopy(identity)
        if sender_mode == 'wrong_pid': expected['pid'] = os.getpid()
        channel = trust.AuthorityChannel(client, expected, lambda _pid: identity)
        try:
            return channel.exchange({'run_id': 'fixture-run'})
        finally:
            os.waitpid(child, 0)

    def test_kernel_sender_and_unique_request_are_required(self):
        self.assertEqual(self.exchange()['status'], 'unknown')
        for mode in ['replay', 'oversize']:
            with self.subTest(mode=mode), self.assertRaises(trust.AuthorityError): self.exchange(response_mode=mode)
        with self.assertRaises(trust.AuthorityError): self.exchange(sender_mode='wrong_pid')

    def test_channel_cannot_be_selected_as_a_stream(self):
        client, server = socket.socketpair()
        try:
            with self.assertRaises(trust.AuthorityError): trust.AuthorityChannel(client, {}, lambda _pid: {})
        finally:
            client.close(); server.close()


if __name__ == '__main__':
    unittest.main()

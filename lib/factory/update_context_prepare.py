"""Prepare sender metadata only; the kernel broker still verifies authority."""
import hashlib
import json
import os
import stat
import time


def prepare(args, shared):
    now = time.time_ns() // 1000000
    if (not now < args.expires_at <= now + 48 * 3600000 or args.parent_pid != os.getppid()
            or os.path.realpath(args.output_dir) != args.output_dir):
        raise ValueError('core_prepare_scope_unconfirmed')
    expected = json.loads(args.core_control_json)
    if (set(expected) != {'ref', 'sha256', 'bytes'}
            or expected['ref'] != 'public_setup_before.json'):
        raise ValueError('core_prepare_before_unconfirmed')
    directory = os.open(args.output_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(directory)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('core_prepare_scope_unconfirmed')
        if any(name.endswith('.pending') for name in os.listdir(directory)):
            raise ValueError('core_prepare_scope_unconfirmed')
        raw = shared.read_original(directory, 'public_setup_before.json')
        if len(raw) != expected['bytes'] or hashlib.sha256(raw).hexdigest() != expected['sha256']:
            raise ValueError('core_prepare_before_unconfirmed')
        before = json.loads(raw)
        sender = shared.process_identity(args.parent_pid)
        with open('/proc/sys/kernel/random/boot_id', encoding='ascii') as handle:
            identity = shared.token(handle.read().strip(), sender)
        with open(args.entry, 'rb') as handle:
            entry_sha256 = hashlib.sha256(handle.read()).hexdigest()
        if (before.get('phase') != 'public_setup_before' or before.get('process_identity') != identity
                or before.get('capture_expires_at_utc_ms') != args.expires_at
                or before.get('entry_realpath') != os.path.realpath(args.entry)
                or before.get('entry_sha256') != entry_sha256):
            raise ValueError('core_prepare_before_unconfirmed')
        value = dict(schema='dotagents.core-authority-bootstrap.v1', activation=args.output_dir,
                     expires_at=args.expires_at, factory_identity=identity, sender=sender,
                     before_original=expected)
        body = (json.dumps(value, sort_keys=True) + '\n').encode()
        original = shared.publish(directory, 'core_authority_bootstrap.json', body, readback=True)
        return dict(status='recorded_raw', kind='factory_bootstrap_metadata', original=original,
                    before_original=expected, reporting_allowed=False, resource_read_authorized=False)
    finally:
        os.close(directory)

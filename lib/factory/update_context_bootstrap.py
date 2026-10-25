"""Fixed helper composition. No module/issuer/pins are selected from control."""
import importlib.util
import json
import os
from pathlib import Path
import socket


def source(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def create_ports(args, shared):
    trust = source('dotagents_fixed_authority', Path(__file__).with_name('update_context_trust.py'))
    directory = os.open(args.output_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        bootstrap = json.loads(shared.read_original(directory, 'core_authority_bootstrap.json'))
        before = json.loads(shared.read_original(directory, 'public_setup_before.json'))
    finally:
        os.close(directory)
    sender = bootstrap['sender']
    with open('/proc/sys/kernel/random/boot_id', encoding='ascii') as stream:
        boot = stream.read().strip()
    identity = shared.token(boot, sender)
    if (bootstrap.get('schema') != 'dotagents.core-authority-bootstrap.v1'
            or bootstrap.get('activation') != args.output_dir or bootstrap.get('expires_at') != args.expires_at
            or bootstrap.get('factory_identity') != identity or before.get('process_identity') != identity
            or shared.process_identity(sender['pid']) != sender):
        raise trust.AuthorityError('authority_bootstrap_unconfirmed')
    endpoint = socket.socket(fileno=trust.AUTHORITY_FD)
    channel = trust.AuthorityChannel(endpoint, sender, shared.process_identity)
    return trust.create_core_ports(channel, sender_identity=identity,
                                   retain_original=lambda values, body: trust.retain_authority(values, shared, body))[:2]

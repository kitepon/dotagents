#!/usr/bin/env python3
"""Fixed original-Node child, kernel receive only; no authority socket writes."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


def main():
    if sys.platform != 'linux' or len(sys.argv) != 2 or len(sys.argv[1].encode()) > 16384:
        raise ValueError('kernel_receiver_scope_invalid')
    signal.signal(signal.SIGALRM, lambda *_args: (_ for _ in ()).throw(TimeoutError()))
    signal.alarm(2)
    scope = json.loads(sys.argv[1])
    store = load('receiver_store', 'bin/factory-update-context-observer.py')
    broker = load('receiver_broker', 'lib/factory/update_context_broker.py')
    endpoint = socket.socket(fileno=4)
    reader = broker.CoreAuthorityBroker(endpoint, product_pid=scope['product_pid'], product_entry=scope['product_entry'],
        activation=scope['activation'], expires_at=scope['expires_at'], before_ref=scope['before_ref'],
        shared=SimpleNamespace(process_identity=store.process_identity, token=store.token), factory_sender_pid=os.getppid())
    reader.next_phase = scope['phase']
    reader.run = tuple(scope['run']) if scope['run'] is not None else None
    receipt = reader.receive_for_original_node()
    body = broker.encode(receipt)
    if len(body) > 131072: raise ValueError('kernel_receipt_too_large')
    sys.stdout.buffer.write(body + b'\n'); sys.stdout.buffer.flush()
    endpoint.close()


if __name__ == '__main__':
    try: main()
    except Exception:
        # Arbitrary process argv or verifier text never enters diagnostics.
        sys.stderr.write('core_kernel_receiver_unconfirmed\n'); sys.exit(2)

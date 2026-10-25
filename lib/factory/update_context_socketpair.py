"""Adopted dispatcher source port, before the original factory Node exec.

No standalone CLI, environment switch or product-selected command. The caller
owns the fixed adopted factory entry and original command/env. Node keeps fd5
(server), hands original fd6 to product fd4 and closes its local fd6 afterwards.
"""
import fcntl
import os
import socket


def exec_original_factory(node_executable, factory_entry, arguments, environment):
    for path in [node_executable, factory_entry]:
        if not os.path.isabs(path) or os.path.realpath(path) != path:
            raise ValueError('core_channel_factory_path_unconfirmed')
    for descriptor in [5, 6]:
        try:
            os.fstat(descriptor)
        except OSError as error:
            if error.errno != 9: raise
        else:
            raise ValueError('core_channel_reserved_descriptor_in_use')
    server, caller = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
    saved_server = fcntl.fcntl(server.fileno(), fcntl.F_DUPFD_CLOEXEC, 10)
    saved_caller = fcntl.fcntl(caller.fileno(), fcntl.F_DUPFD_CLOEXEC, 10)
    server.close(); caller.close()
    try:
        os.dup2(saved_server, 5, inheritable=True)
        os.dup2(saved_caller, 6, inheritable=True)
        os.execve(node_executable, [node_executable, factory_entry, *arguments], environment)
    finally:
        os.close(saved_server); os.close(saved_caller)
        os.close(5); os.close(6)

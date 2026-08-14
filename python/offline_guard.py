"""Process-wide outbound network guard for MuxMelt's Python backend.

The Electron main process sets ``MUXMELT_OFFLINE=1`` before starting Python.
Installing the guard before importing media/model libraries makes Offline Mode
fail closed even when an upstream package tries to download a model implicitly.
Loopback is still allowed because the renderer talks to FastAPI on 127.0.0.1.
"""

from __future__ import annotations

import ipaddress
import os
import socket
from typing import Any


class OfflineModeError(OSError):
    """Raised when code attempts an external connection in Offline Mode."""


_installed = False
_original_socket_connect = socket.socket.connect
_original_socket_connect_ex = socket.socket.connect_ex
_original_socket_sendto = socket.socket.sendto
_original_socket_sendmsg = getattr(socket.socket, 'sendmsg', None)
_original_create_connection = socket.create_connection
_original_getaddrinfo = socket.getaddrinfo
_original_gethostbyname = socket.gethostbyname
_original_gethostbyname_ex = socket.gethostbyname_ex
_original_gethostbyaddr = socket.gethostbyaddr
_original_getnameinfo = socket.getnameinfo


def _loopback_address(address: Any) -> bool:
    if isinstance(address, str):
        # Unix-domain sockets are local filesystem IPC, not network traffic.
        return True
    if not isinstance(address, tuple) or not address:
        return False
    host = address[0]
    if not isinstance(host, str):
        return False
    if host.lower() == 'localhost':
        return True
    try:
        return ipaddress.ip_address(host.split('%', 1)[0]).is_loopback
    except ValueError:
        # Do not resolve hostnames here: DNS itself would disclose traffic.
        return False


def _blocked_message(address: Any) -> str:
    host = address[0] if isinstance(address, tuple) and address else address
    return f'Offline Mode blocked an external connection to {host!r}'


def _loopback_host(host: Any) -> bool:
    if host is None or host == '':
        return True
    if isinstance(host, bytes):
        try:
            host = host.decode('ascii')
        except UnicodeDecodeError:
            return False
    if not isinstance(host, str):
        return False
    if host.lower() == 'localhost':
        return True
    try:
        return ipaddress.ip_address(host.split('%', 1)[0]).is_loopback
    except ValueError:
        return False


def install_if_requested() -> bool:
    """Install the socket guard once and report whether it is active."""
    global _installed
    if _installed:
        return True
    if os.environ.get('MUXMELT_OFFLINE') != '1':
        return False

    def guarded_connect(sock: socket.socket, address: Any):
        if not _loopback_address(address):
            raise OfflineModeError(_blocked_message(address))
        return _original_socket_connect(sock, address)

    def guarded_create_connection(address: Any, *args: Any, **kwargs: Any):
        if not _loopback_address(address):
            raise OfflineModeError(_blocked_message(address))
        return _original_create_connection(address, *args, **kwargs)

    def guarded_connect_ex(sock: socket.socket, address: Any):
        if not _loopback_address(address):
            raise OfflineModeError(_blocked_message(address))
        return _original_socket_connect_ex(sock, address)

    def guarded_sendto(sock: socket.socket, data: Any, *args: Any):
        address = args[-1] if args else None
        if address is not None and not _loopback_address(address):
            raise OfflineModeError(_blocked_message(address))
        return _original_socket_sendto(sock, data, *args)

    def guarded_sendmsg(sock: socket.socket, buffers: Any, *args: Any):
        address = args[2] if len(args) >= 3 else None
        if address is not None and not _loopback_address(address):
            raise OfflineModeError(_blocked_message(address))
        return _original_socket_sendmsg(sock, buffers, *args)

    def guarded_getaddrinfo(host: Any, *args: Any, **kwargs: Any):
        if not _loopback_host(host):
            raise OfflineModeError(_blocked_message((host, 0)))
        return _original_getaddrinfo(host, *args, **kwargs)

    def guarded_gethostbyname(host: Any):
        if not _loopback_host(host):
            raise OfflineModeError(_blocked_message((host, 0)))
        return _original_gethostbyname(host)

    def guarded_gethostbyname_ex(host: Any):
        if not _loopback_host(host):
            raise OfflineModeError(_blocked_message((host, 0)))
        return _original_gethostbyname_ex(host)

    def guarded_gethostbyaddr(host: Any):
        # Reverse DNS is outbound name-resolution traffic too. Only literal
        # loopback addresses are eligible for the platform resolver.
        if not _loopback_host(host):
            raise OfflineModeError(_blocked_message((host, 0)))
        return _original_gethostbyaddr(host)

    def guarded_getnameinfo(sockaddr: Any, flags: int):
        if not _loopback_address(sockaddr):
            raise OfflineModeError(_blocked_message(sockaddr))
        return _original_getnameinfo(sockaddr, flags)

    socket.socket.connect = guarded_connect
    socket.socket.connect_ex = guarded_connect_ex
    socket.socket.sendto = guarded_sendto
    if _original_socket_sendmsg is not None:
        socket.socket.sendmsg = guarded_sendmsg
    socket.create_connection = guarded_create_connection
    socket.getaddrinfo = guarded_getaddrinfo
    socket.gethostbyname = guarded_gethostbyname
    socket.gethostbyname_ex = guarded_gethostbyname_ex
    socket.gethostbyaddr = guarded_gethostbyaddr
    socket.getnameinfo = guarded_getnameinfo
    _installed = True
    return True


__all__ = ['OfflineModeError', 'install_if_requested']

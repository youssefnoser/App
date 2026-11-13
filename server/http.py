"""HTTP client setup for talking to IRSA.

TLS verification is on unless the environment variable SPHEREX_INSECURE_TLS=1
is set. That escape hatch exists only for sandboxed environments where a TLS
interception proxy breaks verification; it must stay off everywhere else.
"""

import os

import httpx

TIMEOUT_SECONDS = 60.0


def tls_verify() -> bool:
    """True unless SPHEREX_INSECURE_TLS is exactly "1"."""
    return os.environ.get("SPHEREX_INSECURE_TLS", "") != "1"


def make_client() -> httpx.Client:
    """An httpx client with a 60 s timeout and TLS verification per tls_verify()."""
    return httpx.Client(timeout=TIMEOUT_SECONDS, verify=tls_verify())

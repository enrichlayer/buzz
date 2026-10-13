"""Dependency-free verification of Tauri updater (minisign) signatures.

Tauri's BUZZ_UPDATER_PUBLIC_KEY and each `.sig` file are base64-wrapped
minisign documents. Verification follows the minisign format: Ed25519 over
BLAKE2b-512 of the file ("ED", prehashed) or the file itself ("Ed", legacy),
plus the global signature over the signature and trusted comment. Ed25519 is
the RFC 8032 section 6 reference verifier; it handles public data only.
"""
import base64
import binascii
import hashlib
from pathlib import Path

PINNED_KEY = Path(__file__).resolve().parents[1] / "desktop" / "enrichlayer-updater.pub"

_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _recover_x(y, sign):
    if y >= _P:
        return None
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P) % _P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P:
        x = x * _SQRT_M1 % _P
    if (x * x - x2) % _P:
        return None
    if (x & 1) != sign:
        x = _P - x
    return x


def _decompress(data):
    if len(data) != 32:
        return None
    y = int.from_bytes(data, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    return None if x is None else (x, y, 1, x * y % _P)


def _add(a, b):
    x1, y1, z1, t1 = a
    x2, y2, z2, t2 = b
    pa = (y1 - x1) * (y2 - x2) % _P
    pb = (y1 + x1) * (y2 + x2) % _P
    pc = t1 * 2 * _D * t2 % _P
    pd = z1 * 2 * z2 % _P
    e, f, g, h = pb - pa, pd - pc, pd + pc, pb + pa
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _mul(scalar, point):
    result = (0, 1, 1, 0)
    while scalar:
        if scalar & 1:
            result = _add(result, point)
        point = _add(point, point)
        scalar >>= 1
    return result


def _equal(a, b):
    return (a[0] * b[2] - b[0] * a[2]) % _P == 0 and (a[1] * b[2] - b[1] * a[2]) % _P == 0


_GY = 4 * pow(5, _P - 2, _P) % _P
_GX = _recover_x(_GY, 0)
_G = (_GX, _GY, 1, _GX * _GY % _P)


def ed25519_verify(public, signature, chunks):
    """Verify an Ed25519 signature over the concatenation of byte chunks."""
    if len(public) != 32 or len(signature) != 64:
        return False
    a = _decompress(public)
    r = _decompress(signature[:32])
    s = int.from_bytes(signature[32:], "little")
    if a is None or r is None or s >= _L:
        return False
    hasher = hashlib.sha512(signature[:32] + public)
    for chunk in chunks:
        hasher.update(chunk)
    h = int.from_bytes(hasher.digest(), "little") % _L
    return _equal(_mul(s, _G), _add(r, _mul(h, a)))


def _document(text):
    """Accept a raw minisign document or Tauri's base64-wrapped form."""
    if isinstance(text, bytes):
        text = text.decode()
    text = text.strip()
    if not text.startswith("untrusted comment:"):
        try:
            text = base64.b64decode(text, validate=True).decode()
        except (binascii.Error, UnicodeDecodeError) as error:
            raise ValueError("Malformed minisign document") from error
    return [line.rstrip("\r") for line in text.strip().split("\n")]


def _b64(line, size):
    try:
        data = base64.b64decode(line.strip(), validate=True)
    except binascii.Error as error:
        raise ValueError("Malformed minisign field") from error
    if len(data) != size:
        raise ValueError("Malformed minisign field")
    return data


def parse_public_key(text):
    lines = _document(text)
    if len(lines) < 2:
        raise ValueError("Malformed minisign public key")
    data = _b64(lines[1], 42)
    if data[:2] != b"Ed":
        raise ValueError("Unsupported minisign public key algorithm")
    return data[2:10], data[10:]


def pinned_public_key(path=PINNED_KEY):
    if not path.is_file():
        raise ValueError(f"Pinned updater public key missing: {path}")
    return path.read_text().strip()


def verify_stream(public_key_text, signature_text, stream):
    """Raise ValueError unless signature_text signs the stream with the key."""
    key_id, public = parse_public_key(public_key_text)
    lines = _document(signature_text)
    if len(lines) < 4 or not lines[2].startswith("trusted comment: "):
        raise ValueError("Malformed minisign signature")
    data = _b64(lines[1], 74)
    algorithm, signer, signature = data[:2], data[2:10], data[10:]
    if signer != key_id:
        raise ValueError("Signature is from a different updater key")
    if algorithm == b"ED":
        hasher = hashlib.blake2b(digest_size=64)
        while chunk := stream.read(1024 * 1024):
            hasher.update(chunk)
        message = [hasher.digest()]
    elif algorithm == b"Ed":
        message = iter(lambda: stream.read(1024 * 1024), b"")
    else:
        raise ValueError("Unsupported minisign signature algorithm")
    if not ed25519_verify(public, signature, message):
        raise ValueError("Updater signature verification failed")
    trusted = lines[2][len("trusted comment: "):].encode()
    if not ed25519_verify(public, _b64(lines[3], 64), [signature, trusted]):
        raise ValueError("Updater signature trusted comment verification failed")

import base64
import importlib.util
import io
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("minisign", Path(__file__).with_name("enrichlayer-minisign.py"))
minisign = importlib.util.module_from_spec(spec)
spec.loader.exec_module(minisign)

# Generated once with an independent Ed25519 implementation (pyca/cryptography)
# in minisign format: a fixed test key, never a release key.
PUBLIC_KEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDA4MDcwNjA1MDQwMzAyMDEKUldRQkFnTUVCUVlIQ0FPaEI3L3p6aEMrSFhEZEdPZEx3SmxuNU5Zd202VU5YeDNjaG1RU1ZURzQK'
DATA = b'buzz updater archive fixture\nbuzz updater archive fixture\nbuzz updater archive fixture\n'
PREHASHED_SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRQkFnTUVCUVlIQ0RMVnRaVDUzZ0lNekQ5OGVvSVJrNFhGeVExMmh4SXBQRnU4UkRsN3lXNExhUk1lR1NTbkFJem4xUTRlL0x6QjVJQ241M1dUMnAvT1lLM1VkYzFmV1FjPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYwMTQwODAwCWZpbGU6QnV6el8xLjIuM19kYXJ3aW4tYWFyY2g2NC5hcHAudGFyLmd6ClNReUZpRDJDeE11amdDVmFIT2tIL0tUcDFMQXc2ckltQ1NnM01jR0VWdnBXVVplbEI0VDhTd2V0WDZNVnltYkxxVDRzMU53MU5aQUU5Vmg5Rzcwd0JnPT0K'
LEGACY_SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUldRQkFnTUVCUVlIQ002OXhhZFJTeXFBZEhOdjNaT0diaUFZby9HaGtsWEIxRmE1MGZWb2dnRndLNFFwU3Q0SnFPN3lFV2lyZUZJYy9SRis0MzBlb3Z4WnllM0lEYmdNTWdBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYwMTQwODAwCWZpbGU6QnV6el8xLjIuM19kYXJ3aW4tYWFyY2g2NC5hcHAudGFyLmd6CjFYWWNoWTF2OUgvVFNiZ2IxMUlPeGdJakQ1Nzg1UTFNbUxRWDhJS3JBY3cySElPRUJKL2dUWDQwL1N5ZVU3dU1LOXJQV3d1SWl4L0gzMS81VU1UVUFnPT0K'

# RFC 8032 section 7.1, tests 1 and 2.
RFC = [
    ("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
     "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
    ("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
     "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
]


def wrap(lines):
    return base64.b64encode("\n".join(lines).encode()).decode()


def lines(signature):
    return base64.b64decode(signature).decode().split("\n")


class MinisignTest(unittest.TestCase):
    def verify(self, signature, data=DATA, key=PUBLIC_KEY):
        minisign.verify_stream(key, signature, io.BytesIO(data))

    def test_rfc8032_vectors(self):
        for public, message, signature in RFC:
            public, message, signature = map(bytes.fromhex, (public, message, signature))
            self.assertTrue(minisign.ed25519_verify(public, signature, [message]))
            self.assertFalse(minisign.ed25519_verify(public, signature, [message + b"x"]))
            tampered = signature[:63] + bytes([signature[63] ^ 1])
            self.assertFalse(minisign.ed25519_verify(public, tampered, [message]))

    def test_non_canonical_scalar_rejected(self):
        public, message, signature = map(bytes.fromhex, RFC[0])
        s = int.from_bytes(signature[32:], "little") + minisign._L
        self.assertFalse(minisign.ed25519_verify(public, signature[:32] + s.to_bytes(32, "little"), [message]))

    def test_prehashed_and_legacy_signatures_verify(self):
        self.verify(PREHASHED_SIG)
        self.verify(LEGACY_SIG)
        self.verify(base64.b64decode(PREHASHED_SIG))

    def test_tampered_archive_rejected(self):
        for signature in (PREHASHED_SIG, LEGACY_SIG):
            with self.assertRaisesRegex(ValueError, "verification failed"):
                self.verify(signature, DATA + b"!")

    def test_tampered_trusted_comment_rejected(self):
        parts = lines(PREHASHED_SIG)
        parts[2] = parts[2].replace("darwin-aarch64", "darwin-x86_64")
        with self.assertRaisesRegex(ValueError, "trusted comment"):
            self.verify(wrap(parts))

    def test_other_key_rejected(self):
        parts = base64.b64decode(PUBLIC_KEY).decode().split("\n")
        raw = bytearray(base64.b64decode(parts[1]))
        raw[10:42] = bytes.fromhex(RFC[0][0])
        parts[1] = base64.b64encode(bytes(raw)).decode()
        with self.assertRaisesRegex(ValueError, "verification failed"):
            self.verify(PREHASHED_SIG, key=wrap(parts))
        raw[2:10] = b"\0" * 8
        parts[1] = base64.b64encode(bytes(raw)).decode()
        with self.assertRaisesRegex(ValueError, "different updater key"):
            self.verify(PREHASHED_SIG, key=wrap(parts))

    def test_malformed_documents_rejected(self):
        for signature in ("", "not base64!", wrap(["untrusted comment: x", "AAAA"])):
            with self.assertRaises(ValueError):
                self.verify(signature)

    def test_committed_release_key_parses(self):
        key_id, public = minisign.parse_public_key(minisign.pinned_public_key())
        self.assertEqual((len(key_id), len(public)), (8, 32))
        with self.assertRaisesRegex(ValueError, "missing"):
            minisign.pinned_public_key(Path(__file__).with_name("does-not-exist.pub"))


if __name__ == "__main__":
    unittest.main()

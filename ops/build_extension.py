#!/usr/bin/env python3
"""Pack + sign the Chrome extension into a CRX3, and publish it for the
self-hosted auto-update endpoints.

What it does:
  1. Ensures a persistent RSA signing key (data/extension/keys/key.pem).
  2. Pins the public key into the extension manifest ("key" field) so an
     UNPACKED dev-mode install and the signed .crx share the SAME extension id
     (required for update_url auto-update to target dev-mode installs).
  3. Builds a deterministic .zip of the extension dir.
  4. Wraps it in a valid CRX3 container (hand-encoded protobuf header).
  5. Also copies the plain .zip (for first-time "Load unpacked").
  6. Writes data/extension/meta.json {version, extension_id, changelog, built_at}.

Usage:
  python ops/build_extension.py [--changelog "text"]

The CrxFileHeader / SignedData protobuf is tiny, so it's encoded by hand rather
than pulling in the protobuf runtime.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import struct
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

ROOT = Path(__file__).resolve().parent.parent
EXT_SRC = ROOT / "extension"
DATA_EXT = ROOT / "data" / "extension"
KEYS_DIR = DATA_EXT / "keys"
KEY_PEM = KEYS_DIR / "key.pem"
CRX_OUT = DATA_EXT / "tailorresume-extension.crx"
ZIP_OUT = DATA_EXT / "tailorresume-extension.zip"
META_OUT = DATA_EXT / "meta.json"


# ---- protobuf wire helpers (varint + length-delimited fields) --------------
def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            break
    return bytes(out)


def _field(field_no: int, wire: int) -> bytes:
    return _varint((field_no << 3) | wire)


def _len_delim(field_no: int, data: bytes) -> bytes:
    return _field(field_no, 2) + _varint(len(data)) + data


def ensure_key() -> rsa.RSAPrivateKey:
    KEYS_DIR.mkdir(parents=True, exist_ok=True)
    if KEY_PEM.exists():
        return serialization.load_pem_private_key(KEY_PEM.read_bytes(), password=None)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    KEY_PEM.write_bytes(key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    KEY_PEM.chmod(0o600)
    print(f"  generated new signing key -> {KEY_PEM}")
    return key


def public_der(key: rsa.RSAPrivateKey) -> bytes:
    return key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def extension_id(pub_der: bytes) -> str:
    """Chrome's id = first 16 bytes of sha256(pubkey), mapped 0-9a-f -> a-p."""
    digest = hashlib.sha256(pub_der).digest()[:16]
    return "".join(chr(ord("a") + (b >> 4)) + chr(ord("a") + (b & 0xF)) for b in digest)


def crx_id(pub_der: bytes) -> bytes:
    return hashlib.sha256(pub_der).digest()[:16]


def pin_manifest_key(pub_der: bytes) -> str:
    """Write the base64 public key into manifest 'key' and return the version."""
    import base64
    mpath = EXT_SRC / "manifest.json"
    m = json.loads(mpath.read_text())
    m["key"] = base64.b64encode(pub_der).decode("ascii")
    # keep keys ordered with version near the top for readability
    mpath.write_text(json.dumps(m, indent=2) + "\n")
    return m.get("version", "0.0.0")


def build_zip() -> bytes:
    """Deterministic zip of the extension dir (sorted, fixed timestamps)."""
    buf = io.BytesIO()
    files = sorted(p for p in EXT_SRC.rglob("*") if p.is_file())
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            arc = str(f.relative_to(EXT_SRC))
            zi = zipfile.ZipInfo(arc, date_time=(2020, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, f.read_bytes())
    return buf.getvalue()


def build_crx(key: rsa.RSAPrivateKey, pub_der: bytes, zip_bytes: bytes) -> bytes:
    cid = crx_id(pub_der)
    # SignedData protobuf: field 1 = crx_id (bytes)
    signed_data = _len_delim(1, cid)

    # Data the signature covers:
    #   "CRX3 SignedData\x00" + uint32_le(len(signed_data)) + signed_data + zip
    to_sign = b"CRX3 SignedData\x00" + struct.pack("<I", len(signed_data)) + signed_data + zip_bytes
    signature = key.sign(to_sign, padding.PKCS1v15(), hashes.SHA256())

    # AsymmetricKeyProof: field 1 = public_key, field 2 = signature
    proof = _len_delim(1, pub_der) + _len_delim(2, signature)

    # CrxFileHeader: field 2 = sha256_with_rsa (repeated AsymmetricKeyProof),
    #                field 10000 = signed_header_data (SignedData)
    header = _len_delim(2, proof) + _len_delim(10000, signed_data)

    out = bytearray()
    out += b"Cr24"                       # magic
    out += struct.pack("<I", 3)          # version 3
    out += struct.pack("<I", len(header))
    out += header
    out += zip_bytes
    return bytes(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--changelog", default="")
    args = ap.parse_args()

    DATA_EXT.mkdir(parents=True, exist_ok=True)
    print("Building TailorResume extension…")
    key = ensure_key()
    pub = public_der(key)
    ext_id = extension_id(pub)
    version = pin_manifest_key(pub)
    print(f"  extension id: {ext_id}")
    print(f"  version:      {version}")

    zip_bytes = build_zip()
    ZIP_OUT.write_bytes(zip_bytes)
    crx = build_crx(key, pub, zip_bytes)
    CRX_OUT.write_bytes(crx)
    print(f"  wrote {ZIP_OUT.name} ({len(zip_bytes)} bytes)")
    print(f"  wrote {CRX_OUT.name} ({len(crx)} bytes)")

    META_OUT.write_text(json.dumps({
        "version": version,
        "extension_id": ext_id,
        "changelog": args.changelog,
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }, indent=2))
    print(f"  wrote {META_OUT.name}")
    print("Done. Bump 'version' in extension/manifest.json before each release.")


if __name__ == "__main__":
    main()

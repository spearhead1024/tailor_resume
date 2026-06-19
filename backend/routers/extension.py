"""Chrome-extension distribution + self-hosted auto-update.

Serves the packed/signed .crx, the Chrome `gupdate` update manifest (which the
extension's manifest `update_url` points at), and a small JSON version endpoint
the in-app Extension tab reads. The build/sign script (ops/build_extension.sh)
writes the .crx + meta into data/extension/.
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response, FileResponse

from auth import get_current_user

router = APIRouter(prefix="/api/extension", tags=["extension"])

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
EXT_DIR = DATA_DIR / "extension"
EXT_DIR.mkdir(parents=True, exist_ok=True)

CRX_PATH = EXT_DIR / "tailorresume-extension.crx"
ZIP_PATH = EXT_DIR / "tailorresume-extension.zip"
META_PATH = EXT_DIR / "meta.json"          # {version, extension_id, changelog, built_at}

# Public base the extension/update manifest is reached at.
PUBLIC_BASE = "https://tailorresume.duckdns.org"


def _meta() -> dict:
    if META_PATH.exists():
        try:
            return json.loads(META_PATH.read_text())
        except Exception:
            pass
    return {"version": "0.0.0", "extension_id": "", "changelog": "", "built_at": ""}


@router.get("/version")
def extension_version(user: dict = Depends(get_current_user)):
    """Current published version + changelog, for the in-app Extension tab."""
    m = _meta()
    return {
        "version": m.get("version", "0.0.0"),
        "extension_id": m.get("extension_id", ""),
        "changelog": m.get("changelog", ""),
        "built_at": m.get("built_at", ""),
        "available": ZIP_PATH.exists(),
        "zip_url": f"{PUBLIC_BASE}/api/extension/latest.zip",
        "crx_url": f"{PUBLIC_BASE}/api/extension/latest.crx",
        "update_url": f"{PUBLIC_BASE}/api/extension/update.xml",
    }


@router.get("/update.xml")
def update_manifest():
    """Chrome auto-update manifest (gupdate). Public, no auth — Chrome fetches it
    on its own schedule without the user's session."""
    m = _meta()
    ext_id = m.get("extension_id", "")
    version = m.get("version", "0.0.0")
    if not ext_id or not CRX_PATH.exists():
        raise HTTPException(status_code=404, detail="No extension published yet.")
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">\n'
        f'  <app appid="{ext_id}">\n'
        f'    <updatecheck codebase="{PUBLIC_BASE}/api/extension/latest.crx" version="{version}" />\n'
        '  </app>\n'
        '</gupdate>\n'
    )
    return Response(content=xml, media_type="application/xml")


@router.get("/latest.crx")
def latest_crx():
    """The packed/signed extension. Used by Chrome's policy-based force-install
    + auto-update (NOT drag-install, which Chrome blocks for off-store .crx)."""
    if not CRX_PATH.exists():
        raise HTTPException(status_code=404, detail="No extension published yet.")
    return FileResponse(
        CRX_PATH,
        media_type="application/x-chrome-extension",
        filename="tailorresume-extension.crx",
    )


@router.get("/latest.zip")
def latest_zip():
    """The unpacked extension as a .zip — for 'Load unpacked' install, which is
    the friction-free way to side-load on regular Chrome."""
    if not ZIP_PATH.exists():
        raise HTTPException(status_code=404, detail="No extension published yet.")
    return FileResponse(
        ZIP_PATH,
        media_type="application/zip",
        filename="tailorresume-extension.zip",
    )


@router.get("/policy.json")
def managed_policy():
    """Chrome managed-policy file that force-installs the extension from our
    server and keeps it auto-updated. Drop it into the OS policy directory.

    Public (no auth) — like update.xml / latest.crx — so it downloads from a
    plain link (which can't carry the bearer token). Contains only the public
    extension id + update URL, nothing sensitive."""
    m = _meta()
    ext_id = m.get("extension_id", "")
    if not ext_id:
        raise HTTPException(status_code=404, detail="No extension published yet.")
    policy = {
        "ExtensionInstallForcelist": [
            f"{ext_id};{PUBLIC_BASE}/api/extension/update.xml"
        ],
        "ExtensionInstallSources": [
            f"{PUBLIC_BASE}/*"
        ],
    }
    import json as _json
    return Response(
        content=_json.dumps(policy, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="tailorresume_policy.json"'},
    )


@router.get("/policy.reg")
def managed_policy_reg():
    """Windows registry file (.reg) that force-installs + auto-updates the
    extension. Double-click → Yes → restart Chrome. Public (see policy.json)."""
    m = _meta()
    ext_id = m.get("extension_id", "")
    if not ext_id:
        raise HTTPException(status_code=404, detail="No extension published yet.")
    entry = f"{ext_id};{PUBLIC_BASE}/api/extension/update.xml"
    # .reg files want CRLF line endings.
    lines = [
        "Windows Registry Editor Version 5.00",
        "",
        r"[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist]",
        f'"1"="{entry}"',
        "",
    ]
    content = "\r\n".join(lines)
    return Response(
        content=content,
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="tailorresume_policy.reg"'},
    )

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


# ── Automatic updates for a "Load unpacked" install on Windows ───────────────────
# Chrome only auto-updates a self-hosted extension on enterprise-managed machines (policy
# above). On a normal PC this one-time installer keeps %LOCALAPPDATA%\TailorResume\extension
# at the latest version — a scheduled task (no admin rights) runs updater.ps1 every 30 minutes
# — and the extension restarts itself into a new version it finds on disk
# (extension/lib/self-update.js). The bidder loads that folder once with "Load unpacked".

_UPDATER_PS1 = r"""# TailorResume extension updater (Windows).
# Keeps %LOCALAPPDATA%\TailorResume\extension at the latest published version. Chrome loads
# that folder ("Load unpacked"); the extension restarts itself into a new version.
# Run every 30 minutes by the scheduled task "TailorResume extension updater".
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Base = '__BASE__/api/extension'
$Root = Join-Path $env:LOCALAPPDATA 'TailorResume'
$Ext  = Join-Path $Root 'extension'
$Tmp  = Join-Path $Root 'incoming'
$Old  = Join-Path $Root 'extension.old'
$Log  = Join-Path $Root 'updater.log'
function Write-Log($m) { Add-Content -Path $Log -Value ((Get-Date -Format s) + '  ' + $m) }
try {
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  [xml]$xml = (Invoke-WebRequest -UseBasicParsing -Uri "$Base/update.xml" -TimeoutSec 30).Content
  $remote = [string]$xml.gupdate.app.updatecheck.version
  $local = ''
  $mf = Join-Path $Ext 'manifest.json'
  if (Test-Path $mf) { $local = [string](Get-Content -Raw -Path $mf | ConvertFrom-Json).version }
  if (-not $remote -or $remote -eq $local) { exit 0 }
  $zip = Join-Path $Root 'latest.zip'
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/latest.zip" -OutFile $zip -TimeoutSec 180
  if (Test-Path $Tmp) { Remove-Item -Recurse -Force $Tmp }
  Expand-Archive -Path $zip -DestinationPath $Tmp -Force
  Remove-Item -Force $zip
  if (-not (Test-Path (Join-Path $Tmp 'manifest.json'))) { throw 'the download has no manifest.json' }
  # Swap folders by renaming: the old version stays whole until the new one is complete.
  if (Test-Path $Old) { Remove-Item -Recurse -Force $Old }
  if (Test-Path $Ext) { Rename-Item -Path $Ext -NewName 'extension.old' }
  try { Rename-Item -Path $Tmp -NewName 'extension' }
  catch { if (Test-Path $Old) { Rename-Item -Path $Old -NewName 'extension' }; throw }
  Remove-Item -Recurse -Force $Old -ErrorAction SilentlyContinue
  Write-Log ("updated " + ($(if ($local) { $local } else { '(none)' })) + " -> " + $remote)
} catch {
  Write-Log ("failed: " + $_.Exception.Message)
  exit 1
}
"""

_INSTALL_CMD = r'''@echo off
setlocal
title TailorResume extension - automatic updates
set "ROOT=%LOCALAPPDATA%\TailorResume"
echo Setting up automatic updates for the TailorResume extension...
if not exist "%ROOT%" mkdir "%ROOT%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing -Uri '__BASE__/api/extension/updater.ps1' -OutFile '%ROOT%\updater.ps1'"
if errorlevel 1 goto fail
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\updater.ps1"
if not exist "%ROOT%\extension\manifest.json" goto fail
> "%ROOT%\updater.vbs" echo CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""%ROOT%\updater.ps1""", 0, False
schtasks /Create /F /TN "TailorResume extension updater" /SC MINUTE /MO 30 /TR "wscript.exe \"%ROOT%\updater.vbs\"" >nul
if errorlevel 1 goto fail
echo.
echo Done. The extension is in this folder (it opens now):
echo    %ROOT%\extension
echo A new version is fetched automatically - checked every 30 minutes.
echo.
echo ONE LAST STEP, only this once:
echo   1. In Chrome open  chrome://extensions  and Remove any old "TailorResume Assistant".
echo   2. Turn on "Developer mode" (top right), click "Load unpacked" and choose the folder above.
echo From then on, new versions install by themselves.
explorer "%ROOT%\extension"
echo.
pause
exit /b 0
:fail
echo.
echo Something went wrong. Details: %ROOT%\updater.log
echo Check the internet connection and run this file again, or ask the admin.
pause
exit /b 1
'''


@router.get("/updater.ps1")
def windows_updater():
    """The Windows updater script (public — the installer and the scheduled task fetch it)."""
    content = _UPDATER_PS1.replace("__BASE__", PUBLIC_BASE).replace("\r\n", "\n").replace("\n", "\r\n")
    return Response(content=content, media_type="text/plain; charset=utf-8")


@router.get("/install-windows.cmd")
def windows_installer():
    """One-time installer: downloads the extension + updater and schedules the update check.
    Double-click it (no admin rights needed), then "Load unpacked" the folder it opens."""
    content = _INSTALL_CMD.replace("__BASE__", PUBLIC_BASE).replace("\r\n", "\n").replace("\n", "\r\n")
    return Response(
        content=content,
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="TailorResume-auto-update-setup.cmd"'},
    )

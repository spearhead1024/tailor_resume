#!/usr/bin/env bash
# Install the fonts CV templates use, so generated PDFs match the uploaded DOCX exactly.
#
# The PDF is made by LibreOffice (unoserver); a font it can't find is replaced by another one
# (e.g. Segoe Print → DejaVu Sans), and the CV no longer looks like the template.
#
#   1. Free fonts from Ubuntu (fallbacks: Caladea ≈ Cambria and Carlito ≈ Calibri, same widths).
#   2. The Windows fonts in Fonts/ (copied from a licensed Windows PC: C:\Windows\Fonts).
#      They are NOT in git — Microsoft's licence does not allow publishing them, and the repo is
#      public. Copy the folder onto the server by hand before running this.
#   3. Rebuild the font cache and restart unoserver (it reads the font list only at start).
#
# Usage (as root):  ops/install_fonts.sh [path/to/Fonts]
set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)/Fonts}"
DEST=/usr/local/share/fonts/windows

export DEBIAN_FRONTEND=noninteractive
apt-get install -y -q fonts-crosextra-caladea fonts-crosextra-carlito fonts-noto-core fonts-noto-extra \
  fonts-roboto fonts-open-sans fonts-lato >/dev/null

if [ -d "$SRC" ]; then
  mkdir -p "$DEST"
  find "$SRC" -maxdepth 1 -type f \( -iname '*.ttf' -o -iname '*.ttc' -o -iname '*.otf' \) -exec cp -p {} "$DEST"/ \;
  chmod 644 "$DEST"/*
  # A variable font (one file, every weight) is skipped when the same family also has static
  # files: LibreOffice embeds a variable font's bold/italic in the PDF as Type 3 glyph drawings,
  # which some ATS parsers can't read; static files embed as normal TrueType.
  is_variable() { fc-query -f '%{variable}\n' "$1" 2>/dev/null | grep -q True; }
  family_of() { fc-query -f '%{family[0]}\n' "$1" 2>/dev/null | head -1; }
  declare -A static_family=()
  for f in "$DEST"/*; do is_variable "$f" || static_family["$(family_of "$f")"]=1; done
  for f in "$DEST"/*; do
    if is_variable "$f" && [ -n "${static_family["$(family_of "$f")"]:-}" ]; then
      rm -f "$f"; echo "Skipped variable $(basename "$f") — static files of $(family_of "$SRC/$(basename "$f")") are installed"
    fi
  done
  echo "Installed $(ls "$DEST" | wc -l) Windows fonts into $DEST"
  # The Windows set has newer copies of the old "core fonts" package: keep one copy of each.
  apt-get purge -y -q ttf-mscorefonts-installer >/dev/null 2>&1 || true
else
  echo "No $SRC folder — only the free fonts were installed (Windows-only fonts fall back)." >&2
fi

fc-cache -f >/dev/null
for f in "Segoe Print" "Cambria" "Calibri" "Times New Roman" "Arial"; do
  printf '  %-16s -> %s\n' "$f" "$(fc-match "$f")"
done
pm2 restart unoserver >/dev/null 2>&1 && echo "unoserver restarted" || echo "Restart unoserver yourself so LibreOffice sees the new fonts." >&2

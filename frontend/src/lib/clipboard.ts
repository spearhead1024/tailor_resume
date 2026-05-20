/**
 * Copy text to the clipboard.
 *
 * Tries the modern `navigator.clipboard` API first, then falls back to
 * `document.execCommand('copy')` via a hidden textarea — which is the only
 * thing that works on insecure (HTTP) origins.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  // Modern API — works on HTTPS / localhost
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path
    }
  }

  // Legacy fallback — works on HTTP
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    // Off-screen, off-tabflow
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    textarea.setAttribute('readonly', '');
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

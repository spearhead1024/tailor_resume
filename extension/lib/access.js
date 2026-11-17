// Reading job sites (the Add Jobs tab's "Fetch Job Details") needs access to them — an optional
// permission, asked once. Chrome only shows the prompt from a click, so callers await this FIRST
// in their click handler.
export const requestSiteAccess = () => chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);

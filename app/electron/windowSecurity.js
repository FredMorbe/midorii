/** Keep the broker-capable preload on the application's own document. */
export function restrictWindowNavigation(contents, documentUrl) {
  const trusted = new URL(documentUrl);
  const allowed = (url) => {
    try {
      const next = new URL(url);
      return next.protocol === trusted.protocol && next.host === trusted.host
        && next.pathname === trusted.pathname && !next.username && !next.password;
    } catch { return false; }
  };
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

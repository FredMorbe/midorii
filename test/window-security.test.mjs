import { describe, expect, it, vi } from 'vitest';
import { restrictWindowNavigation } from '../app/electron/windowSecurity.js';

describe('broker window navigation', () => {
  function content(url) {
    const listeners = new Map();
    let open;
    restrictWindowNavigation({ on: (name, fn) => listeners.set(name, fn), setWindowOpenHandler: (fn) => { open = fn; } }, url);
    return { listeners, open: () => open() };
  }
  it('blocks external pages, other local documents, redirects, popups and embedded webviews', () => {
    const view = content('http://localhost:5301/');
    for (const name of ['will-navigate', 'will-redirect']) {
      for (const url of ['https://example.com/', 'http://localhost:5301/other.html', 'http://localhost:5302/', 'not a URL']) {
        const event = { preventDefault: vi.fn() };
        view.listeners.get(name)(event, url);
        expect(event.preventDefault).toHaveBeenCalledOnce();
      }
    }
    expect(view.open()).toEqual({ action: 'deny' });
    const event = { preventDefault: vi.fn() };
    view.listeners.get('will-attach-webview')(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
  it('permits reloads and hash navigation only on the packaged application document', () => {
    const url = 'file:///D:/Workspace/Midorii/app/dist/index.html';
    const view = content(url);
    const reload = { preventDefault: vi.fn() };
    view.listeners.get('will-navigate')(reload, `${url}#bot`);
    expect(reload.preventDefault).not.toHaveBeenCalled();
    const other = { preventDefault: vi.fn() };
    view.listeners.get('will-navigate')(other, 'file:///D:/other.html');
    expect(other.preventDefault).toHaveBeenCalledOnce();
  });
});

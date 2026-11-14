const { contextBridge, ipcRenderer } = require('electron');

/* Electron words a failed handler as "Error invoking remote method 'channel': Error: <message>".
 * The channel and the wrapper mean nothing to the person reading it in a banner, and the message
 * is what the handler actually said, so that is what the renderer gets. */
const REMOTE_ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/;
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.replace(REMOTE_ERROR_PREFIX, ''));
  });
}

/* The renderer sees exactly this and nothing else — no ipcRenderer, no Node.
 *
 * Only namespaces with handlers behind them are exposed: drawings come back once
 * their IPC handlers exist. Exposing a method with nothing behind it fails with a
 * confusing "no handler registered" instead of being plainly absent.
 */
contextBridge.exposeInMainWorld('midori', {
  /** `'darwin'` gets native traffic lights; everywhere else draws its own window
   *  controls in the app topbar (see app/renderer/shell/appTopbar.ts). */
  platform: process.platform,

  research: {
    strategies: () => invoke('research:strategies'),
    onChanged: (handler) => {
      const listener = (_event, change) => handler(change ?? {});
      ipcRenderer.on('research:changed', listener);
      return () => ipcRenderer.off('research:changed', listener);
    },
  },

  ui: {
    /* `background` is the palette's own surface colour. The name alone was enough while
       there were two palettes; there are more now, and the window's paint colour — what
       shows during a resize and before the page has painted — has to be the one the page
       is about to paint. Omitted, the main process falls back to the name's default. */
    setTheme: (theme, background) => invoke('ui:set-theme', theme, background),
  },

  /** What the custom title bar's own minimize/maximize/close buttons call — a
   *  renderer cannot reach a BrowserWindow directly. */
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    readyToClose: () => ipcRenderer.send('window:close-ready'),
    onCloseRequested: (handler) => {
      const listener = () => handler();
      ipcRenderer.on('window:close-requested', listener);
      return () => ipcRenderer.off('window:close-requested', listener);
    },
    isMaximized: () => invoke('window:is-maximized'),
    /* Fires on every maximize/restore, including ones Windows makes on its own
     * (Aero Snap, a double-click on the drag region) — the maximize button's
     * glyph has no other way to learn about those. Returns its own unsubscribe. */
    onMaximizedChange: (handler) => {
      const listener = (_event, maximized) => handler(maximized);
      ipcRenderer.on('window:maximized-changed', listener);
      return () => ipcRenderer.off('window:maximized-changed', listener);
    },
    /** Bring the window to the front from a minimized/background state — what a
     *  triggered alert's notification calls on click. */
    restore: () => ipcRenderer.send('window:restore'),
  },

  data: {
    datasets: () => invoke('data:datasets'),
    meta: (symbol) => invoke('data:meta', symbol),
    /** The venues bars can be downloaded from — id, label, and how each names a market. */
    sources: () => invoke('data:sources'),
    symbols: (source) => invoke('data:symbols', source),
    bars: (query) => invoke('data:bars', query),
    download: (request) => invoke('data:download', request),
    /** Fills in whatever a range is missing at either end, then reports the coverage —
     *  what the Backtest tab calls before running against a venue. */
    ensure: (request) => invoke('data:ensure', request),
    /** Removes a dataset. What every "remove it first" refusal points at. */
    delete: (symbol) => invoke('data:delete', symbol),

    /* Importing a CSV, in two steps: the picker reports what the file looks like, the
     * import runs under whatever the dialog corrected. inspectCsv re-reads the same file
     * after a delimiter change, since every other guess follows from it. */
    pickCsv: () => invoke('data:pick-csv'),
    inspectCsv: (request) => invoke('data:inspect-csv', request),
    importCsv: (request) => invoke('data:import-csv', request),

    /* Progress is pushed rather than polled: a download is hundreds of calls
     * long and the renderer wants each one as it lands. Returns its own
     * unsubscribe — the listener outlives the invoke, so nothing else would
     * ever take it off again. */
    onDownloadProgress: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('data:download-progress', listener);
      return () => ipcRenderer.off('data:download-progress', listener);
    },
  },

  replay: {
    /** Stores a finished session as a run, in the same library a backtest lands in. */
    save: (request) => invoke('replay:save', request),

    /* A session that is not finished yet: the account and the clock, without
     * the bars. Saving again replaces the same entry, so putting one down
     * twice does not litter the list. */
    saveSession: (request) => invoke('replay:saveSession', request),
    sessions: () => invoke('replay:sessions'),
    loadSession: (id) => invoke('replay:loadSession', id),
    deleteSession: (id) => invoke('replay:deleteSession', id),
    renameSession: (id, name) => invoke('replay:renameSession', id, name),
    duplicateSession: (id) => invoke('replay:duplicateSession', id),
  },

  /* The feed recorder — every print and quote on a ProjectX contract that is open, written
     down so a day can be replayed at the ladder. */
  recorder: {
    status: () => invoke('recorder:status'),
    setEnabled: (enabled) => invoke('recorder:set-enabled', enabled),
  },

  /* What the recorder kept, read back for a replay. */
  ticks: {
    read: (request) => invoke('ticks:read', request),
    meta: (name) => invoke('ticks:meta', name),
  },

  /* The paper account — one record, not a library. Read when paper trading is
     switched on, written whenever the account moves, cleared when it is started
     over. A FINISHED one goes to `replay.save` instead, onto the run shelf. */
  paper: {
    load: () => invoke('paper:load'),
    save: (account) => invoke('paper:save', account),
    clear: () => invoke('paper:clear'),
  },

  /* A finished backtest. The run itself happens in the renderer, where the detectors
     live; only the result crosses the bridge, onto the same shelf a replay lands on. */
  backtest: {
    save: (request) => invoke('backtest:save', request),
  },

  /* What each strategy is set to. Configuration rather than a result: the Strategies tab
     writes it, the Backtest tab starts from it. */
  strategies: {
    load: () => invoke('strategies:load'),
    save: (id, params) => invoke('strategies:save', id, params),
    reset: (id) => invoke('strategies:reset', id),
  },

  /* A finished parameter sweep — a ranking of settings, not an account. Its own shelf
     beside the runs, read on the same Analysis screen. */
  search: {
    limits: () => invoke('search:limits'),
    prepare: (request) => invoke('search:prepare', request),
    list: () => invoke('search:list'),
    command: (request) => invoke('search:command', request),
    results: (request) => invoke('search:results', request),
    export: (request) => invoke('search:export', request),
    review: (request) => invoke('search:review', request),
  },
  sweep: {
    save: (request) => invoke('sweep:save', request),
    list: () => invoke('sweep:list'),
    load: (id) => invoke('sweep:load', id),
    delete: (id) => invoke('sweep:delete', id),
    annotate: (id, note) => invoke('sweep:annotate', id, note),
  },

  /* Price alerts — one flat list, read at startup and rewritten whenever it changes. */
  alerts: {
    load: () => invoke('alerts:load'),
    save: (alerts) => invoke('alerts:save', alerts),
  },

  /* Trading bots — their definitions, round-tripped whole like the alerts. A bot's live
     state is not stored: it is rebuilt from the market's own history when the bot starts. */
  bots: {
    load: () => invoke('bots:load'),
    save: (bots) => invoke('bots:save', bots),

    /* Each bot's durable account, guard, and live-ownership state, keyed by the bot. */
    account: {
      load: (id) => invoke('botAccount:load', id),
      save: (id, account) => invoke('botAccount:save', id, account),
      clear: (id) => invoke('botAccount:clear', id),
      /** Remove accounts whose bot no longer exists. */
      sweep: (keep) => invoke('botAccount:sweep', keep),
    },
  },

  /* Finished runs — every session that was played to the end, and in time
   * every backtest, on one shelf. Listing hands back summaries; `load` opens
   * the one being looked at, with its trades and equity curve. */
  runs: {
    list: () => invoke('runs:list'),
    load: (id) => invoke('runs:load', id),
    delete: (id) => invoke('runs:delete', id),
    annotate: (id, note) => invoke('runs:annotate', id, note),
    setTags: (id, tags) => invoke('runs:setTags', id, tags),
    addShot: (id, shot) => invoke('runs:addShot', id, shot),
    shot: (id, shotId) => invoke('runs:shot', id, shotId),
    removeShot: (id, shotId) => invoke('runs:removeShot', id, shotId),
  },

  /* The live trading journal — every trade taken on a real account, kept by Midorii
     itself because the venue serves at most a day of history per request and loses it
     entirely with the account. */
  live: {
    trades: () => invoke('live:trades'),
    append: (trade) => invoke('live:append', trade),
    settle: (patch) => invoke('live:settle', patch),
    clear: () => invoke('live:clear'),
  },

  /** Optional, chart-only market data. The main process owns its network session. */
  experimentalFeed: {
    search: (query) => invoke('experimental-feed:search', query),
    symbolInfo: (symbol) => invoke('experimental-feed:symbol-info', symbol),
    bars: (query) => invoke('experimental-feed:bars', query),
    subscribe: (query) => invoke('experimental-feed:subscribe', query),
    unsubscribe: (subscriptionId) => invoke('experimental-feed:unsubscribe', subscriptionId),
    onBar: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('experimental-feed:bar', listener);
      return () => ipcRenderer.off('experimental-feed:bar', listener);
    },
  },

  /** Capital.com forex/CFD data — the session (login, keepalive, the WebSocket)
   *  lives in the main process; see app/renderer/providers/CapitalProvider.ts. */
  capital: {
    configured: () => invoke('capital:configured'),
    /* Credential management. The secret goes IN and never comes back out — there is
       deliberately no channel that returns the key or the password. */
    credentials: {
      status: () => invoke('capital:credentials-status'),
      test: (creds) => invoke('capital:credentials-test', creds),
      save: (creds) => invoke('capital:credentials-save', creds),
      clear: () => invoke('capital:credentials-clear'),
    },
    environment: () => invoke('capital:environment'),
    /* Move to the other account on the credentials already stored. The key stays where it
       is — only which endpoint it is used against changes. */
    setEnvironment: (env) => invoke('capital:set-environment', env),
    markets: (searchTerm) => invoke('capital:markets', searchTerm),
    marketInfo: (epic) => invoke('capital:market-info', epic),
    prices: (query) => invoke('capital:prices', query),
    subscribe: (query) => invoke('capital:subscribe', query),
    unsubscribe: (subscriptionId) => invoke('capital:unsubscribe', subscriptionId),
    /* Pushed per subscription id — the renderer matches it to the `subscribe()`
     * call that started it. Returns its own unsubscribe. */
    onOhlc: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('capital:ohlc', listener);
      return () => ipcRenderer.off('capital:ohlc', listener);
    },
    /* Trading. Each of these resolves with what the venue CONFIRMED, not with the
     * receipt it gave for the instruction — see app/electron/data/capital.js. */
    account: () => invoke('capital:account'),
    preferences: () => invoke('capital:preferences'),
    positions: () => invoke('capital:positions'),
    openPosition: (spec, revision) => invoke('capital:open-position', spec, revision),
    amendPosition: (spec, revision) => invoke('capital:amend-position', spec, revision),
    closePosition: (dealId, revision) => invoke('capital:close-position', dealId, revision),
    workingOrders: () => invoke('capital:working-orders'),
    createOrder: (spec, revision) => invoke('capital:create-order', spec, revision),
    amendOrder: (spec, revision) => invoke('capital:amend-order', spec, revision),
    cancelOrder: (dealId, revision) => invoke('capital:cancel-order', dealId, revision),
    /** The two ledgers a finished trade's real cost is joined from. */
    history: (window) => invoke('capital:history', window),
    subscribeQuotes: (query) => invoke('capital:subscribe-quotes', query),
    unsubscribeQuotes: (subscriptionId) => invoke('capital:unsubscribe-quotes', subscriptionId),
    onQuote: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('capital:quote', listener);
      return () => ipcRenderer.off('capital:quote', listener);
    },
  },

  /** ProjectX futures data — the session, the SignalR socket and the tick-to-bar
   *  aggregation live in the main process; see app/electron/data/projectx.js. */
  projectx: {
    configured: () => invoke('projectx:configured'),
    /* Same rule as every other venue here: the key goes IN and never comes back out. */
    credentials: {
      status: () => invoke('projectx:credentials-status'),
      test: (creds) => invoke('projectx:credentials-test', creds),
      save: (creds) => invoke('projectx:credentials-save', creds),
      clear: () => invoke('projectx:credentials-clear'),
    },
    environment: () => invoke('projectx:environment'),
    accounts: (onlyActive) => invoke('projectx:accounts', onlyActive),
    /* Which account is traded. Every ProjectX order carries an id, and a key routinely
       reaches an evaluation plus the funded accounts from it — so one has to be chosen. */
    account: () => invoke('projectx:account'),
    selectAccount: (id) => invoke('projectx:select-account', id),
    positions: () => invoke('projectx:positions'),
    openOrders: () => invoke('projectx:open-orders'),
    /* Executions — half-turns, with the realised result on the closing one. */
    trades: (range) => invoke('projectx:trades', range),
    /* Trading. A ProjectX stop is a resting ORDER rather than an attribute of the
       position — see app/renderer/trading/ProjectXController.ts for what follows from it. */
    placeOrder: (spec) => invoke('projectx:place-order', spec),
    modifyOrder: (orderId, changes) => invoke('projectx:modify-order', { orderId, ...changes }),
    cancelOrder: (orderId) => invoke('projectx:cancel-order', orderId),
    closePosition: (contractId, size) => invoke('projectx:close-position', { contractId, size }),
    contracts: (searchText) => invoke('projectx:contracts', searchText),
    availableContracts: () => invoke('projectx:available-contracts'),
    bars: (query) => invoke('projectx:bars', query),
    subscribe: (query) => invoke('projectx:subscribe', query),
    unsubscribe: (subscriptionId) => invoke('projectx:unsubscribe', subscriptionId),
    /* Pushed per subscription id, like the Capital.com feeds. The bar is the one being
     * BUILT from the tape, re-sent on every print rather than only when it closes. */
    onBar: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('projectx:bar', listener);
      return () => ipcRenderer.off('projectx:bar', listener);
    },
    /* The tape: prints as they happen, in the batches the hub sends them in. */
    subscribePrints: (query) => invoke('projectx:subscribe-prints', query),
    unsubscribePrints: (subscriptionId) => invoke('projectx:unsubscribe-prints', subscriptionId),
    onPrints: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('projectx:prints', listener);
      return () => ipcRenderer.off('projectx:prints', listener);
    },
    subscribeQuotes: (query) => invoke('projectx:subscribe-quotes', query),
    unsubscribeQuotes: (subscriptionId) => invoke('projectx:unsubscribe-quotes', subscriptionId),
    onQuote: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('projectx:quote', listener);
      return () => ipcRenderer.off('projectx:quote', listener);
    },
    /* The account side: the gateway saying an order, a position, a trade or the balance
       changed. Treated as a doorbell rather than as news — see data/projectx.js. */
    subscribeUser: () => invoke('projectx:subscribe-user'),
    unsubscribeUser: (subscriptionId) => invoke('projectx:unsubscribe-user', subscriptionId),
    onUserEvent: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('projectx:user-event', listener);
      return () => ipcRenderer.off('projectx:user-event', listener);
    },
  },

  /** Binance Spot Demo. The base URL is fixed in the main process, and the secret has no
   *  renderer-facing read method. */
  binanceSpot: {
    environment: () => invoke('binance-spot:environment'),
    credentials: {
      status: () => invoke('binance-spot:credentials-status'),
      test: (creds) => invoke('binance-spot:credentials-test', creds),
      save: (creds) => invoke('binance-spot:credentials-save', creds),
      clear: () => invoke('binance-spot:credentials-clear'),
    },
    symbolInfo: (symbol) => invoke('binance-spot:symbol-info', symbol),
    account: () => invoke('binance-spot:account'),
    openOrders: (symbol) => invoke('binance-spot:open-orders', symbol),
    trades: (symbol) => invoke('binance-spot:trades', symbol),
    placeOrder: (spec) => invoke('binance-spot:place-order', spec),
    cancelOrder: (spec) => invoke('binance-spot:cancel-order', spec),
    cancelAll: (symbol) => invoke('binance-spot:cancel-all', symbol),
    replaceProtection: (spec) => invoke('binance-spot:replace-protection', spec),
    close: (symbol) => invoke('binance-spot:close', symbol),
  },

  /** Bybit V5 — spot pairs and USDT perpetuals, on the demo host or the live one. Which of
   *  the two is stored with the key; no call here can choose it. */
  bybit: {
    environment: () => invoke('bybit:environment'),
    credentials: {
      status: () => invoke('bybit:credentials-status'),
      test: (creds) => invoke('bybit:credentials-test', creds),
      save: (creds) => invoke('bybit:credentials-save', creds),
      clear: () => invoke('bybit:credentials-clear'),
    },
    instrument: (query) => invoke('bybit:instrument', query),
    /** Public candles, oldest first — what the chart provider draws from. */
    klines: (query) => invoke('bybit:klines', query),
    wallet: () => invoke('bybit:wallet'),
    positions: (symbol) => invoke('bybit:positions', symbol),
    openOrders: (query) => invoke('bybit:open-orders', query),
    executions: (query) => invoke('bybit:executions', query),
    placeOrder: (spec) => invoke('bybit:place-order', spec),
    cancelOrder: (spec) => invoke('bybit:cancel-order', spec),
    cancelAll: (query) => invoke('bybit:cancel-all', query),
    setProtection: (spec) => invoke('bybit:set-protection', spec),
    close: (query) => invoke('bybit:close', query),
  },
});

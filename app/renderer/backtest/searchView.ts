import { injectStyles } from '../../../src/ui';
import { DEFAULT_COSTS, NO_COSTS } from '../../../shared/engine/broker.js';
import { searchSpace, type SearchAxis } from '../../../shared/analysis/searchPlan.js';
import { RANK_METRICS } from '../../../shared/analysis/sweep.js';
import type { RankMetricId } from '../../../shared/analysis/sweep';
import { strategyCatalog, resolveStrategyParams, describeParams, getRuleStrategies } from '../strategies';
import type { StrategyParams } from '../strategies';
import { button, settingsGrid, tile, tileGrid, sectionLabel } from '../runs/runViews';
import { formatMoney, formatDay } from '../format';
import type { SearchConfig } from './searchEngine';
import type { SearchJob, SearchRequest, SearchResult, SearchReview } from './searchTypes';
import type { MidoriDatasetMeta } from '../midori';
import { timeframeToMs } from '../../../src';

const CSS = `
.midorii-search[hidden] { display: none !important; }
.midorii-search { display: grid; gap: 18px; padding: 20px; max-width: 1300px; margin: auto; color: var(--vela-fg); font-size: 12px; }
.midorii-search h2 { font-size: 17px; color: var(--vela-fg-bright); margin: 0 0 6px; }
.midorii-search h3 { font-size: 13px; color: var(--vela-fg-bright); margin: 0 0 8px; }
.midorii-search p { color: var(--vela-fg-muted); line-height: 1.6; margin: 4px 0 12px; }
.midorii-search-panel { border: 1px solid var(--vela-border-soft); border-radius: var(--vela-radius-sm); padding: 18px; background: var(--vela-surface); min-width: 0; }
.midorii-search-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(210px,1fr)); gap: 14px; margin: 14px 0; }
.midorii-search label { display: flex; flex-direction: column; gap: 6px; color: var(--vela-fg-muted); }
.midorii-search input:not([type=checkbox]), .midorii-search select, .midorii-search textarea { width: 100%; min-width: 0; box-sizing: border-box; background: var(--vela-bg); color: var(--vela-fg-bright); border: 1px solid var(--vela-border-soft); border-radius: var(--vela-control-radius); padding: 7px 9px; font: inherit; color-scheme: inherit; }
.midorii-search :focus-visible { outline: 2px solid var(--vela-accent, #5a9b85); outline-offset: 2px; }
.midorii-search select[multiple] { min-height: 88px; }
.midorii-search-check { display: flex !important; flex-direction: row !important; align-items: center; gap: 8px; }
.midorii-search-params { display: grid; grid-template-columns: repeat(auto-fit,minmax(270px,1fr)); gap: 8px; margin: 12px 0; }
.midorii-search-param { padding: 10px; border: 1px solid var(--vela-border-faint); border-radius: var(--vela-radius-sm); display: grid; gap: 8px; align-content: start; }
.midorii-search-range { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 6px; }
.midorii-search-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
.midorii-search-status { min-height: 20px; white-space: pre-wrap; }
.midorii-search-status[data-error] { color: var(--vela-danger); }
.midorii-search-jobs { display: grid; gap: 8px; }
.midorii-search-job { text-align: left; width: 100%; background: var(--vela-bg); color: var(--vela-fg); padding: 12px; border: 1px solid var(--vela-border-soft); border-radius: var(--vela-radius-sm); cursor: pointer; font: inherit; }
.midorii-search-job[aria-pressed=true] { border-color: var(--vela-fg-muted); }
.midorii-search-job strong { display: block; color: var(--vela-fg-bright); margin-bottom: 5px; }
.midorii-search progress { width: 100%; height: 7px; accent-color: var(--vela-up); margin-top: 8px; }
.midorii-search-table { overflow: auto; }
.midorii-search table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; white-space: nowrap; }
.midorii-search th { text-align: right; color: var(--vela-fg-muted); font-size: 10px; padding: 9px; }
.midorii-search td { text-align: right; padding: 9px; border-top: 1px solid var(--vela-border-faint); }
.midorii-search td:first-child, .midorii-search th:first-child { text-align: left; }
.midorii-search tr[data-pick] { cursor: pointer; }
.midorii-search tr[data-pick]:hover, .midorii-search tr[aria-selected=true] { background: var(--vela-hover); }
@media (max-width: 600px) { .midorii-search { padding: 10px; } .midorii-search-panel { padding: 12px; } }
`;

export interface SearchSeed { strategy: string; base: Record<string, unknown>; symbol: string; timeframe: string; from: number; to: number; axes: Record<string, SearchAxis>; balance: number; costs: boolean; pointValue: number; sizeStep: number | null; minSize: number | null; intrabar: boolean }

export function mountSearchView(host: HTMLElement, onReview: (review: SearchReview) => void) {
    const doc = host.ownerDocument;
    injectStyles('midorii-search-styles', CSS, doc);
    const root = doc.createElement('section'); root.className = 'midorii-search'; root.hidden = true;
    host.append(root);
    let catalog = strategyCatalog();
    const create = panel('New search job', 'Saved history only. Prepare a fixed data snapshot, review it, then start the search.');
    const history = panel('Queue and history', 'The local worker continues after you close Midorii. Keep your computer awake.');
    const detail = panel('Job details', 'Choose a job to inspect its data, progress, and candidates.');
    root.append(create, history, detail);
    const status = doc.createElement('p'); status.className = 'midorii-search-status'; status.setAttribute('role', 'status');
    create.append(status);
    let seed: SearchSeed | null = null;
    let data: MidoriDatasetMeta[] = [];
    let jobs: SearchJob[] = [];
    let selected = '';
    let datasetIndex = 0;
    let candidate: SearchResult | null = null;
    let rows: SearchResult[] = [];
    let refreshToken = 0;
    let resultToken = 0;
    let busy = false;
    let formSignature = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const list = doc.createElement('div'); list.className = 'midorii-search-jobs'; history.append(list);
    const form = doc.createElement('form'); create.insertBefore(form, status);

    function panel(title: string, hint: string) {
        const el = doc.createElement('div'); el.className = 'midorii-search-panel';
        const h = doc.createElement('h2'); h.textContent = title;
        const p = doc.createElement('p'); p.textContent = hint; el.append(h, p); return el;
    }
    function label(text: string, control: HTMLElement) { const el = doc.createElement('label'); const span = doc.createElement('span'); span.textContent = text; el.append(span, control); return el; }
    function input(value: string, type = 'text') { const el = doc.createElement('input'); el.type = type; el.value = value; return el; }
    function select(options: Array<{ value: string; label: string }>, value: string, multiple = false) {
        const el = doc.createElement('select'); el.multiple = multiple;
        for (const item of options) { const option = doc.createElement('option'); option.value = item.value; option.textContent = item.label; option.selected = item.value === value; el.append(option); }
        return el;
    }
    function grid() { const el = doc.createElement('div'); el.className = 'midorii-search-grid'; return el; }
    function check(text: string, checked: boolean) { const el = input('', 'checkbox'); el.checked = checked; const wrapper = label(text, el); wrapper.className = 'midorii-search-check'; return { el, wrapper }; }
    function say(message: string, error = false) { status.textContent = message; if (error) status.dataset.error = '1'; else delete status.dataset.error; }
    async function action(run: () => Promise<void>) {
        if (busy) return;
        busy = true;
        const controls = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button,textarea'));
        const disabled = controls.map((el) => el.disabled);
        controls.forEach((el) => el.disabled = true);
        try { await run(); } catch (err) { say(err instanceof Error ? err.message : String(err), true); }
        finally { busy = false; controls.forEach((el, i) => el.disabled = disabled[i]!); }
    }
    function renderForm() {
        catalog = strategyCatalog();
        form.replaceChildren();
        const name = input('Historical strategy search');
        const strategy = select(catalog.map((s) => ({ value: s.id, label: s.name })), seed?.strategy ?? catalog[0]!.id);
        const markets = select(data.map((s) => ({ value: s.symbol, label: `${s.symbol} · ${s.count.toLocaleString()} saved bars` })), seed?.symbol ?? data[0]?.symbol ?? '', true);
        const intervalOptions = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
        const initialInterval = intervalOptions.find((v) => timeframeToMs(v) === timeframeToMs(seed?.timeframe ?? '5m')) ?? '5m';
        const intervals = select(intervalOptions.map((v) => ({ value: v, label: v })), initialInterval, true);
        const chosen = data.find((d) => d.symbol === markets.value);
        const from = input(formatDay(Math.ceil(Math.max(seed?.from ?? 0, chosen?.first ?? Date.now()) / 86_400_000) * 86_400_000), 'date');
        const to = input(formatDay(Math.min(seed?.to || Infinity, (chosen?.last ?? Date.now()) + (chosen?.baseMs ?? 60_000))), 'date');
        const datesHint = doc.createElement('p'); datesHint.textContent = 'End date is exclusive. Select multiple markets or intervals with Ctrl / Cmd. Dates must fit every selected market.';
        const basics = grid(); basics.append(label('Job name', name), label('Strategy', strategy), label('Saved markets', markets), label('Bar intervals', intervals), label('From (UTC)', from), label('Until (exclusive, UTC)', to));
        form.append(basics, datesHint);
        markets.onchange = () => {
            const selectedData = data.filter((d) => Array.from(markets.selectedOptions).some((o) => o.value === d.symbol));
            if (!selectedData.length) return;
            from.value = formatDay(Math.ceil(Math.max(...selectedData.map((d) => d.first ?? 0)) / 86_400_000) * 86_400_000);
            to.value = formatDay(Math.min(...selectedData.map((d) => (d.last ?? 0) + (d.baseMs ?? 60_000))));
        };
        const method = select([{ value: 'grid', label: 'Grid — every combination' }, { value: 'random', label: 'Random — seeded, no repeats' }], 'random');
        const attempts = input('100', 'number'); attempts.min = '1'; attempts.max = '10000000';
        const hours = input('168', 'number'); hours.min = '0.01'; hours.max = '2160'; hours.step = '0.01';
        const workers = input('1', 'number'); workers.min = '1'; workers.max = '8';
        void window.midori.search.limits().then((limits) => { if (workers.isConnected && workers.value === '1') workers.value = String(limits.workers); }).catch((err) => say(String(err), true));
        const randomSeed = input('1');
        const metric = select(Object.values(RANK_METRICS).map((m) => ({ value: m.id, label: m.label })), 'expectancy');
        const minTrades = input('10', 'number'); minTrades.min = '1';
        const balance = input(String(seed?.balance ?? 10_000), 'number'); balance.min = '1';
        const pointValue = input(String(seed?.pointValue ?? 1), 'number'); pointValue.min = '0.000001'; pointValue.step = 'any';
        const sizeStep = input(String(seed?.sizeStep ?? ''), 'number'); sizeStep.step = 'any';
        const minSize = input(String(seed?.minSize ?? ''), 'number'); minSize.step = 'any';
        const fee = input(String(DEFAULT_COSTS.feeRate * 100), 'number'); fee.step = 'any'; fee.min = '0';
        const feePerUnit = input(String(DEFAULT_COSTS.feePerUnit), 'number'); feePerUnit.step = 'any'; feePerUnit.min = '0';
        const spread = input(String(DEFAULT_COSTS.spreadPct * 100), 'number'); spread.step = 'any'; spread.min = '0';
        const slippage = input(String(DEFAULT_COSTS.slippagePct * 100), 'number'); slippage.step = 'any'; slippage.min = '0';
        const costs = check('Include fees and slippage', seed?.costs ?? true);
        const intrabar = check('Resolve fills with finer saved bars', seed?.intrabar ?? true);
        const budget = grid(); budget.append(label('Search method', method), label('Combinations per market / interval', attempts), label('Total runtime budget (hours)', hours), label('Parallel workers (1–8)', workers), label('Random seed', randomSeed), label('Rank training results by', metric), label('Minimum training trades', minTrades), label('Starting balance', balance));
        form.append(budget, costs.wrapper, intrabar.wrapper);
        const account = doc.createElement('details'); const summary = doc.createElement('summary'); summary.textContent = 'Execution costs and instrument sizing'; account.append(summary);
        const sizing = grid(); sizing.append(label('Money per point per unit', pointValue), label('Size step (empty = unrestricted)', sizeStep), label('Minimum size (empty = unrestricted)', minSize)); account.append(sizing);
        const costGrid = grid(); costGrid.append(label('Fee per fill (% of notional)', fee), label('Fee per unit per fill', feePerUnit), label('Full bid / ask spread (%)', spread), label('Market / stop slippage (%)', slippage)); account.append(costGrid);
        const sizingHint = doc.createElement('p'); sizingHint.textContent = 'These sizing values apply to every selected market. Use separate jobs for instruments with different contract values.'; account.append(sizingHint); form.append(account);
        const explanation = doc.createElement('p'); explanation.textContent = 'First 60%: search and ranking. Next 20%: candidate checks. Last 20%: reserved final test. Preview with 100 combinations before increasing the budget.'; form.append(explanation);
        const parameterBox = doc.createElement('details'); parameterBox.open = true;
        const parameterSummary = doc.createElement('summary'); parameterSummary.textContent = 'Strategy settings and search ranges'; parameterBox.append(parameterSummary);
        const paramsRoot = doc.createElement('div'); paramsRoot.className = 'midorii-search-params'; parameterBox.append(paramsRoot); form.append(parameterBox);
        const readers = new Map<string, () => { fixed: unknown; axis: SearchAxis | null }>();
        function renderParams() {
            paramsRoot.replaceChildren(); readers.clear();
            const spec = catalog.find((s) => s.id === strategy.value)!;
            const base = resolveStrategyParams(spec.id, seed?.strategy === spec.id ? seed.base : {});
            for (const param of spec.params) {
                const box = doc.createElement('div'); box.className = 'midorii-search-param'; if (param.hint) box.title = param.hint;
                const varied = check(`Vary ${param.label}`, Boolean(seed?.strategy === spec.id && seed.axes[param.key]));
                box.append(varied.wrapper);
                if (param.type === 'number' || param.type === 'time') {
                    const fixed = input(String(base[param.key]), 'number'); fixed.step = 'any';
                    const min = param.type === 'time' ? 0 : param.min; const max = param.type === 'time' ? 1439 : param.max;
                    if (min !== undefined) fixed.min = String(min); if (max !== undefined) fixed.max = String(max);
                    const held = seed?.axes[param.key]; const axis = held && 'from' in held ? held : null;
                    const a = input(String(axis?.from ?? base[param.key]), 'number');
                    const b = input(String(axis?.to ?? Math.min(max ?? Infinity, Number(base[param.key]) + (param.step ?? 1) * 4)), 'number');
                    const step = input(String(axis?.step ?? param.step ?? 1), 'number');
                    for (const el of [a, b, step]) el.step = 'any';
                    const range = doc.createElement('div'); range.className = 'midorii-search-range'; range.append(label('From', a), label('To', b), label('Step', step));
                    box.append(label(`Fixed ${param.label}${param.type === 'time' ? ' (UTC minutes)' : ''}`, fixed), range);
                    readers.set(param.key, () => ({ fixed: Number(fixed.value), axis: varied.el.checked ? { from: Number(a.value), to: Number(b.value), step: Number(step.value) } : null }));
                } else if (param.type === 'bool') {
                    const fixed = check(`Fixed ${param.label}`, Boolean(base[param.key])); box.append(fixed.wrapper);
                    readers.set(param.key, () => ({ fixed: fixed.el.checked, axis: varied.el.checked ? { values: [false, true] } : null }));
                } else if (param.type === 'select') {
                    const options = param.options?.map((o) => ({ value: o.value, label: o.label })) ?? [];
                    const fixed = select(options, String(base[param.key]));
                    const choices = select(options, '', true); for (const option of choices.options) option.selected = true;
                    box.append(label(`Fixed ${param.label}`, fixed), label('Allowed choices', choices));
                    readers.set(param.key, () => ({ fixed: fixed.value, axis: varied.el.checked ? { values: Array.from(choices.selectedOptions).map((o) => o.value) } : null }));
                } else {
                    const fixed = input((base[param.key] as readonly string[]).join(', '));
                    const choices = doc.createElement('textarea'); choices.rows = 3; choices.value = `${fixed.value || '-'}\n-`;
                    box.append(label(`Fixed ${param.label} (comma-separated)`, fixed), label('Allowed lists (one per line; - means empty)', choices));
                    const parse = (v: string) => v.trim() === '-' ? [] : v.split(',').map((s) => s.trim()).filter(Boolean);
                    readers.set(param.key, () => ({ fixed: parse(fixed.value), axis: varied.el.checked ? { values: choices.value.split('\n').filter((s) => s.trim()).map(parse) } : null }));
                }
                paramsRoot.append(box);
            }
        }
        strategy.onchange = renderParams; renderParams();
        const prepare = button('Prepare job', 'primary'); prepare.type = 'submit'; prepare.disabled = data.length === 0;
        form.append(prepare);
        form.onsubmit = (event) => { event.preventDefault(); void action(async () => {
            const base: Record<string, unknown> = {}; const axes: Record<string, SearchAxis> = {};
            for (const [key, read] of readers) { const values = read(); base[key] = values.fixed; if (values.axis) axes[key] = values.axis; }
            const count = searchSpace(axes).total;
            const config: SearchConfig = { definitions: getRuleStrategies(), name: name.value, strategy: strategy.value, base, axes, method: method.value as 'grid' | 'random', seed: randomSeed.value,
                maxAttempts: Number(attempts.value), budgetMs: Number(hours.value) * 3_600_000, workers: Number(workers.value), metric: metric.value as RankMetricId,
                minTrades: Number(minTrades.value), balance: Number(balance.value), costs: costs.el.checked ? { feeRate: Number(fee.value) / 100, feePerUnit: Number(feePerUnit.value), spreadPct: Number(spread.value) / 100, slippagePct: Number(slippage.value) / 100 } : { ...NO_COSTS },
                pointValue: Number(pointValue.value), sizeStep: sizeStep.value ? Number(sizeStep.value) : null, minSize: minSize.value ? Number(minSize.value) : null };
            const request: SearchRequest = { config, symbols: Array.from(markets.selectedOptions).map((o) => o.value), timeframes: Array.from(intervals.selectedOptions).map((o) => o.value), from: Date.parse(from.value), to: Date.parse(to.value), intrabar: intrabar.el.checked };
            say(`Preparing ${Math.min(count, config.maxAttempts).toLocaleString()} combinations per market / interval…`);
            const job = await window.midori.search.prepare(request); selected = job.id; datasetIndex = 0; candidate = null;
            await refreshJobs(); await loadResults();
            say('Job prepared. Review its saved history and test periods below, then click Start.');
        }); };
    }

    function paintJobs() {
        list.replaceChildren();
        if (!jobs.length) { const empty = doc.createElement('p'); empty.textContent = 'No search jobs yet. Prepare one above.'; list.append(empty); }
        for (const job of jobs) {
            const el = doc.createElement('button'); el.className = 'midorii-search-job'; el.type = 'button'; el.setAttribute('aria-pressed', String(selected === job.id));
            const title = doc.createElement('strong'); title.textContent = job.config.name;
            const subtitle = doc.createElement('span'); subtitle.textContent = `${job.state.status} · ${job.state.done.toLocaleString()} / ${job.total.toLocaleString()} attempts · ${job.datasets.length} market / interval pairs`;
            const progress = doc.createElement('progress'); progress.max = job.total; progress.value = job.state.done; progress.setAttribute('aria-label', `${job.config.name} progress`);
            el.append(title, subtitle, progress);
            el.onclick = () => { selected = job.id; datasetIndex = 0; candidate = null; rows = []; paintJobs(); paintDetail(); void loadResults().catch((err) => say(String(err), true)); };
            list.append(el);
        }
    }
    function paintDetail() {
        const job = jobs.find((j) => j.id === selected);
        detail.replaceChildren();
        if (!job) { const p = doc.createElement('p'); p.textContent = 'Choose a prepared job to see its progress and results.'; detail.append(p); return; }
        const h = doc.createElement('h2'); h.textContent = job.config.name;
        const subtitle = doc.createElement('p'); subtitle.textContent = `${job.state.status} · ${job.state.reason ?? 'Fixed data and strategy snapshot'}${job.state.error ? ` · ${job.state.error}` : ''}`;
        if (job.state.error) subtitle.style.color = 'var(--vela-danger)'; detail.append(h, subtitle);
        detail.append(tileGrid([tile('Saved attempts', `${job.state.done.toLocaleString()} / ${job.total.toLocaleString()}`), tile('Active runtime', `${(job.state.elapsedMs / 3_600_000).toFixed(2)} h`), tile('Runtime budget', `${(job.config.budgetMs / 3_600_000).toFixed(2)} h`), tile('Parallel workers', String(job.config.workers))]));
        const actions = doc.createElement('div'); actions.className = 'midorii-search-actions';
        const send = (actionName: 'start' | 'pause' | 'finish' | 'final', index?: number) => void action(async () => { await window.midori.search.command({ id: job.id, action: actionName, index }); say('Request sent to the local worker.'); await refreshJobs(); });
        if (['ready', 'paused', 'failed'].includes(job.state.status) && !job.final) {
            const start = button(job.state.status === 'ready' ? 'Start' : 'Resume', 'primary'); start.onclick = () => send('start'); actions.append(start);
        }
        if (['queued', 'running'].includes(job.state.status)) { const pause = button('Pause'); pause.onclick = () => send('pause'); actions.append(pause); }
        if (job.state.status !== 'completed' && !job.final) { const finish = button('Finish search'); finish.onclick = () => send('finish'); actions.append(finish); }
        for (const format of ['csv', 'jsonl'] as const) { const exportButton = button(`Export ${format.toUpperCase()}`); exportButton.onclick = () => void action(async () => { const exported = await window.midori.search.export({ id: job.id, format }); if (exported) say(`Exported ${exported.bytes.toLocaleString()} bytes to ${exported.file}`); }); actions.append(exportButton); }
        detail.append(actions);
        const storage = doc.createElement('p');
        storage.textContent = `Frozen data: ${(job.datasets.reduce((n, d) => n + (d.bytes ?? 0), 0) / 1_048_576).toFixed(1)} MB. Estimated results at the attempt limit: ${((job.estimatedResultBytes ?? 0) / 1_048_576).toFixed(1)} MB. Actual size varies with the settings.`;
        detail.append(storage);
        const dataset = job.datasets[datasetIndex]; if (!dataset) return;
        const datasetPicker = select(job.datasets.map((d, i) => ({ value: String(i), label: `${d.symbol} · ${d.timeframe}` })), String(datasetIndex));
        datasetPicker.onchange = () => { datasetIndex = Number(datasetPicker.value); candidate = null; rows = []; paintDetail(); void loadResults().catch((err) => say(String(err), true)); };
        detail.append(label('Results for', datasetPicker));
        const coverage = doc.createElement('p'); coverage.textContent = `${dataset.count.toLocaleString()} complete bars · ${dataset.gaps.toLocaleString()} gaps between bars (session breaks may be expected). `
            + Object.entries(dataset.periods).map(([name, range]) => `${name}: ${formatDay(range.from)} – ${formatDay(range.to)}`).join(' · '); detail.append(coverage);
        const explanation = doc.createElement('p'); explanation.textContent = `Top 50 by training ${RANK_METRICS[job.config.metric].label.toLowerCase()}, with at least ${job.config.minTrades} training trades. Validation does not choose the ranking. All saved attempts remain in the export.`; detail.append(explanation);
        const reload = button('Refresh candidates'); reload.onclick = () => void action(loadResults); detail.append(reload);
        const tableRoot = doc.createElement('div'); tableRoot.className = 'midorii-search-table';
        const table = doc.createElement('table'); const head = doc.createElement('thead'); const headRow = doc.createElement('tr');
        for (const text of ['Attempt', 'Train P/L', 'Validation P/L', 'Train trades', 'Validation trades', 'Train drawdown', 'Validation drawdown']) { const th = doc.createElement('th'); th.textContent = text; th.scope = 'col'; headRow.append(th); } head.append(headRow); table.append(head);
        const body = doc.createElement('tbody');
        for (const row of rows) {
            const tr = doc.createElement('tr'); tr.dataset.pick = '1'; tr.tabIndex = 0; tr.setAttribute('aria-selected', String(candidate?.index === row.index));
            const choose = () => { candidate = row; paintDetail(); }; tr.onclick = choose; tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } };
            for (const text of [String(row.index + 1), formatMoney(row.stats.netPnl), formatMoney(row.validation.netPnl), String(row.stats.tradeCount), String(row.validation.tradeCount), `${(row.stats.maxDrawdownPct * 100).toFixed(2)}%`, `${(row.validation.maxDrawdownPct * 100).toFixed(2)}%`]) { const td = doc.createElement('td'); td.textContent = text; tr.append(td); } body.append(tr);
        }
        table.append(body); tableRoot.append(table); detail.append(tableRoot);
        if (!rows.length) { const p = doc.createElement('p'); p.textContent = 'No saved candidates meet the trade filter yet. Refresh after more attempts, or inspect the full export.'; detail.append(p); }
        if (candidate) {
            detail.append(sectionLabel(`Settings for attempt ${candidate.index + 1}`), settingsGrid(describeParams(job.config.strategy, candidate.params)));
            const review = button('Open validation backtest'); review.onclick = () => void action(async () => { const result = await window.midori.search.review({ id: job.id, index: candidate!.index }); onReview(result); }); detail.append(review);
            if (job.state.status === 'completed' && !job.final) {
                const final = doc.createElement('details'); const summary = doc.createElement('summary'); summary.textContent = 'Reserve this candidate for the final test'; final.append(summary);
                const p = doc.createElement('p'); p.textContent = 'This ends candidate selection for this job. Only this attempt can use its reserved final period. Reserve untouched history in a new job for a fresh final check.';
                const confirm = button('Run final test for this candidate'); confirm.onclick = () => send('final', candidate!.index); final.append(p, confirm); detail.append(final);
            }
        }
        if (job.final) {
            const title = doc.createElement('h3'); title.textContent = `Final test · attempt ${job.final.index + 1} · ${job.final.status}`; detail.append(title);
            if (job.final.error || (job.state.error && !job.final.result)) { const error = doc.createElement('p'); error.textContent = job.final.error ?? job.state.error; detail.append(error); const retry = button('Retry the same final candidate'); retry.onclick = () => send('final', job.final!.index); detail.append(retry); }
            if (job.final.result) {
                const s = job.final.result.stats; detail.append(tileGrid([tile('Final P/L', formatMoney(s.netPnl)), tile('Final trades', String(s.tradeCount)), tile('Final drawdown', `${(s.maxDrawdownPct * 100).toFixed(2)}%`)]));
                const review = button('Open final backtest'); review.onclick = () => void action(async () => { onReview(await window.midori.search.review({ id: job.id, index: job.final!.index, period: 'holdout' })); }); detail.append(review);
            }
        }
    }
    async function loadResults() {
        const job = jobs.find((j) => j.id === selected); if (!job) return;
        const token = ++resultToken; const id = selected; const index = datasetIndex;
        const page = await window.midori.search.results({ id, datasetIndex: index, metric: job.config.metric, minTrades: job.config.minTrades });
        if (token !== resultToken || selected !== id || datasetIndex !== index) return;
        rows = page.rows; paintDetail();
    }
    async function refreshJobs() {
        const token = ++refreshToken;
        const next = await window.midori.search.list(); if (token !== refreshToken) return;
        const previous = jobs.find((j) => j.id === selected);
        jobs = next; paintJobs();
        const current = jobs.find((j) => j.id === selected);
        if (!current || !previous || JSON.stringify(current.state) !== JSON.stringify(previous.state) || JSON.stringify(current.final) !== JSON.stringify(previous.final)) paintDetail();
    }
    async function poll() {
        if (root.hidden || !root.isConnected) return;
        try { await refreshJobs(); } catch (err) { say(String(err), true); }
        if (!root.hidden && root.isConnected) timer = setTimeout(() => void poll(), 2000);
    }
    return {
        async show(nextSeed: SearchSeed) {
            seed = nextSeed; root.hidden = false;
            if (timer) clearTimeout(timer);
            try {
                data = await window.midori.data.datasets();
                const signature = JSON.stringify([seed, data.map((d) => [d.symbol, d.first, d.last, d.baseMs])]);
                if (signature !== formSignature) { renderForm(); formSignature = signature; }
                await refreshJobs();
            }
            catch (err) { say(String(err), true); }
            void poll();
        },
        hide() { root.hidden = true; if (timer) clearTimeout(timer); timer = null; },
    };
}

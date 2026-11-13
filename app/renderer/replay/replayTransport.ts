import type { Vela, VelaTheme } from '../../../src';
import type { VelaWorkspace } from '../../../src/workspace';
import { applyThemeTokens, ensureUIHost, injectStyles, KeymapManager, type KeyBindingDescriptor } from '../../../src/ui';
import { formatWhen } from '../format';
import type { ReplayController } from './ReplayController';
import { askSetupStrategy, findNextSetup, loadSetupStrategy, saveSetupStrategy, strategyName } from './setupStrategy';
import { timeframeLabel } from '../../../src/widget/timeframe';

/**
 * The replay's transport: the bar under the chart and the keys that do the same things.
 *
 * One set of commands behind both, so a button and its key cannot disagree about what they do.
 * Every command reports its own failure to the person who asked — the engine's message is the
 * message — and none of them throws into the page.
 */

const STYLE_ID = 'midorii-transport';
const CSS = `
.midorii-transport {
    flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px;
    padding: 6px 12px; box-sizing: border-box;
    background: var(--vela-surface); color: var(--vela-fg);
    border-top: 1px solid var(--vela-border);
    font: 12px/1.4 var(--vela-font, sans-serif);
}
.midorii-transport-group { display: inline-flex; align-items: center; gap: 2px; }
.midorii-transport-group[hidden] { display: none !important; }
.midorii-transport-group[data-sep] { padding-left: 14px; border-left: 1px solid var(--vela-border-soft); }
.midorii-transport button {
    all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    min-width: 30px; height: 28px; padding: 0 8px; border-radius: var(--vela-radius-sm);
    color: var(--vela-fg); cursor: pointer; white-space: nowrap; font-size: 12px; font-weight: 600;
}
.midorii-transport button:hover:not(:disabled) { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-transport button:focus-visible { outline: 2px solid var(--vela-accent-bright, #2962ff); outline-offset: 1px; }
.midorii-transport button:disabled { opacity: .45; cursor: default; }
.midorii-transport button[data-on='1'] { background: var(--vela-active); color: var(--vela-fg-bright); }
.midorii-transport button.play { background: var(--vela-active); color: var(--vela-fg-bright); min-width: 38px; }
.midorii-transport button svg { width: 15px; height: 15px; }
.midorii-transport-speed { min-width: 84px; text-align: center; color: var(--vela-fg-muted); font-variant-numeric: tabular-nums; }
.midorii-transport label { display: inline-flex; align-items: center; gap: 6px; color: var(--vela-fg-muted); }
.midorii-transport input {
    background: var(--vela-surface-overlay); color: var(--vela-fg); border: 1px solid var(--vela-border-soft);
    border-radius: var(--vela-control-radius); padding: 0 6px; height: 26px; font: inherit; outline: none; min-width: 0;
}
.midorii-transport input:focus-visible { border-color: var(--vela-accent-bright, #2962ff); }
.midorii-transport input[type='date'] { width: 128px; }
.midorii-transport input[type='time'] { width: 96px; }
.midorii-transport-clock {
    margin-left: auto; color: var(--vela-fg-bright); font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap;
}
.midorii-transport-clock span { color: var(--vela-fg-muted); font-weight: 400; }
`;

const svg = (body: string, fill = false): string => (
    `<svg viewBox="0 0 16 16" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
);
const ICON = {
    back: svg('<path d="M11 3.5 5.5 8 11 12.5"/><path d="M4 3.5v9"/>'),
    play: svg('<path d="M4.5 3.2v9.6L12.8 8z"/>', true),
    pause: svg('<rect x="4" y="3.2" width="3" height="9.6" rx="0.6"/><rect x="9" y="3.2" width="3" height="9.6" rx="0.6"/>', true),
    forward: svg('<path d="M5 3.5 10.5 8 5 12.5"/><path d="M12 3.5v9"/>'),
    skip: svg('<path d="M2.5 3.5 7 8l-4.5 4.5"/><path d="M8 3.5 12.5 8 8 12.5"/>'),
    setup: svg('<circle cx="6.5" cy="8" r="3.5"/><path d="M6.5 3v1.5M6.5 11.5V13M1.5 8H3M10 8h1.5"/><path d="M12 5.5 14.5 8 12 10.5"/>'),
};

export interface Transport {
    el: HTMLElement;
    dispose(): void;
}

/** The commands the bar and the keys share. */
interface Commands {
    playPause(): void;
    stepForward(): void;
    stepBack(): void;
    skip(): void;
    faster(): void;
    slower(): void;
    toggleMode(): void;
    nextSetup(): void;
    goTo(ms: number): void;
}

function commands(ws: VelaWorkspace, controller: ReplayController): Commands {
    const fail = (e: unknown): void => ws.toast(e instanceof Error ? e.message : String(e), 'error');
    const run = (p: Promise<unknown>): void => { p.catch(fail); };
    const atEnd = (): boolean => controller.mode === 'bars' && controller.atEnd;
    const endNotice = (): void => ws.toast('The loaded candles end here.', 'info');

    const shiftSpeed = (by: 1 | -1): void => {
        const { speeds } = controller;
        const at = speeds.indexOf(controller.speed);
        const next = speeds[Math.min(speeds.length - 1, Math.max(0, at + by))]!;
        controller.setSpeed(next);
    };

    return {
        playPause() {
            if (controller.playing) {
                controller.pause();
                return;
            }
            if (atEnd()) {
                endNotice();
                return;
            }
            controller.play();
        },
        stepForward() {
            if (atEnd()) { endNotice(); return; }
            run(controller.stepForward());
        },
        stepBack() { run(controller.stepBack()); },
        skip() {
            if (atEnd()) { endNotice(); return; }
            run(controller.skipForward(10));
        },
        faster() { shiftSpeed(1); },
        slower() { shiftSpeed(-1); },
        toggleMode() {
            if (!controller.ticks) return;
            const next = controller.mode === 'ticks' ? 'bars' : 'ticks';
            run(controller.setPlayMode(next).then(() => ws.toast(next === 'ticks'
                ? 'Playing the recorded prints and quotes — the Ladder and the Tape follow them.'
                : 'Playing candles, one bar at a time.')));
        },
        nextSetup() {
            run((async () => {
                let id = loadSetupStrategy();
                if (!id) {
                    id = await askSetupStrategy(ws.root, null);
                    if (!id) return;
                    saveSetupStrategy(id);
                }
                // Stepping under a running timer would interleave two playheads' worth of bars.
                controller.pause();
                const index = await findNextSetup(controller, id);
                if (index == null) {
                    ws.toast(`No ${strategyName(id)} setup before the end of the loaded bars.`);
                    return;
                }
                const stepped = await controller.skipToIndex(index);
                ws.toast(`${strategyName(id)} setup — ${stepped} ${stepped === 1 ? 'candle' : 'candles'} on.`, 'success');
            })());
        },
        goTo(ms) {
            run(controller.goTo(ms).then((landed) => {
                if (landed < ms) ws.toast(`The data ends at ${formatWhen(landed)} UTC — that is as far as it goes.`, 'info');
            }));
        },
    };
}

/** An element the key would act on by itself — a button is pressed by the space bar. */
function isPressable(ev: KeyboardEvent): boolean {
    const t = ev.target as Element | null;
    return !!t && typeof t.closest === 'function' && t.closest('button, a, summary, [role="button"]') !== null;
}

/**
 * Mount the bar into `stack`, directly after `after` (the row holding the chart), and bind the
 * keys. The keys are bound twice — on the workspace, so its shortcut list shows them, and on the
 * session's whole area, so they also work with the focus on the ticket or the bar itself. A key
 * the workspace has taken is stopped there, so nothing runs twice.
 */
export function mountTransport(opts: {
    stack: HTMLElement;
    after: HTMLElement;
    ws: VelaWorkspace;
    controller: ReplayController;
    theme: VelaTheme;
    primary: () => Vela;
}): Transport {
    const { stack, after, ws, controller, theme, primary } = opts;
    injectStyles(STYLE_ID, CSS, stack.ownerDocument);
    const cmd = commands(ws, controller);

    const bar = document.createElement('div');
    bar.className = 'midorii-transport';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Replay transport');
    ensureUIHost(bar, theme);
    primary().on('theme:changed', (t) => applyThemeTokens(bar, t));

    const group = (sep = false): HTMLElement => {
        const g = document.createElement('div');
        g.className = 'midorii-transport-group';
        if (sep) g.dataset.sep = '1';
        return g;
    };
    const btn = (html: string, title: string, onClick: () => void, label?: string): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = html + (label ? `<span>${label}</span>` : '');
        b.title = title;
        b.setAttribute('aria-label', title);
        b.onclick = onClick;
        return b;
    };

    const back = btn(ICON.back, 'Back one candle (,) — undoes what was done after it', cmd.stepBack);
    const play = btn(ICON.play, 'Play (Space)', cmd.playPause);
    play.classList.add('play');
    const forward = btn(ICON.forward, 'One candle on (.)', cmd.stepForward);
    const skip = btn(ICON.skip, 'Ten candles on (>)', cmd.skip, '10');
    const main = group();
    main.append(back, play, forward, skip);

    const slower = btn('−', 'Slower ([)', cmd.slower);
    const speed = document.createElement('span');
    speed.className = 'midorii-transport-speed';
    const faster = btn('+', 'Faster (])', cmd.faster);
    const pace = group(true);
    pace.append(slower, speed, faster);

    const mode = btn('', 'Play candles or the recorded ticks (M)', cmd.toggleMode);
    const modeGroup = group(true);
    modeGroup.append(mode);
    modeGroup.hidden = controller.ticks == null;

    const setup = btn(ICON.setup, 'Play on to the next setup (N)', cmd.nextSetup, 'Next setup');
    const setupGroup = group(true);
    setupGroup.append(setup);

    const date = document.createElement('input');
    date.type = 'date';
    date.setAttribute('aria-label', 'Go to date (UTC)');
    const time = document.createElement('input');
    time.type = 'time';
    time.setAttribute('aria-label', 'Go to time (UTC)');
    let edited = false;
    for (const input of [date, time]) input.oninput = () => { edited = true; };
    const go = btn('', 'Go to this moment — on by playing up to it, back by undoing what came after', () => {
        const ms = Date.parse(`${date.value}T${time.value || '00:00'}:00Z`);
        if (!date.value || !Number.isFinite(ms)) {
            ws.toast('Pick a date to go to.', 'error');
            return;
        }
        edited = false;
        cmd.goTo(ms);
    }, 'Go');
    for (const input of [date, time]) {
        input.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
    }
    const label = document.createElement('label');
    label.append('Go to (UTC)');
    const goto = group(true);
    goto.append(label, date, time, go);

    const clock = document.createElement('div');
    clock.className = 'midorii-transport-clock';

    bar.append(main, pace, modeGroup, setupGroup, goto, clock);
    stack.insertBefore(bar, after.nextSibling);

    const retitle = (b: HTMLElement, text: string): void => {
        b.title = text;
        b.setAttribute('aria-label', text);
    };
    const paint = (): void => {
        const ticks = controller.mode === 'ticks';
        const playing = controller.playing;
        play.innerHTML = playing ? ICON.pause : ICON.play;
        retitle(play, playing ? 'Pause (Space)' : 'Play (Space)');
        retitle(forward, ticks ? 'Play to the end of this candle (.)' : 'One candle on (.)');
        retitle(skip, ticks ? 'Play ten candles on (>)' : 'Ten candles on (>)');
        speed.textContent = ticks ? `${controller.speed}× real time` : `${controller.speed} bars/s`;
        const speeds = controller.speeds;
        slower.disabled = controller.speed <= speeds[0]!;
        faster.disabled = controller.speed >= speeds[speeds.length - 1]!;
        if (controller.ticks) {
            mode.textContent = ticks ? 'Ticks' : 'Candles';
            mode.dataset.on = ticks ? '1' : '0';
            retitle(mode, ticks ? 'Playing recorded ticks — switch to candles (M)' : 'Playing candles — switch to the recorded ticks (M)');
        }
        const { clock: now } = controller.session;
        const stamp = new Date(now).toISOString();
        clock.replaceChildren(`${stamp.slice(0, 10)} ${stamp.slice(11, 16)}`);
        const unit = document.createElement('span');
        unit.textContent = ` UTC · ${timeframeLabel(controller.timeframe)}`;
        clock.appendChild(unit);
        // Follows the clock until somebody starts typing a date of their own.
        if (!edited) {
            date.value = stamp.slice(0, 10);
            time.value = stamp.slice(11, 16);
        }
    };
    const stop = controller.onChange(paint);
    paint();

    // ── keys ─────────────────────────────────────────────────────────────

    const hasTicks = (): boolean => controller.ticks != null;
    const specs: Array<{ id: string; keys: string; label: string; run: () => void; when?: () => boolean }> = [
        { id: 'replay.play-pause', keys: 'space', label: 'Replay: play or pause', run: cmd.playPause },
        { id: 'replay.step-forward', keys: '.', label: 'Replay: one candle on', run: cmd.stepForward },
        { id: 'replay.step-back', keys: ',', label: 'Replay: one candle back', run: cmd.stepBack },
        { id: 'replay.skip', keys: '>', label: 'Replay: ten candles on', run: cmd.skip },
        { id: 'replay.faster', keys: ']', label: 'Replay: faster', run: cmd.faster },
        { id: 'replay.slower', keys: '[', label: 'Replay: slower', run: cmd.slower },
        { id: 'replay.next-setup', keys: 'n', label: 'Replay: play on to the next setup', run: cmd.nextSetup },
        { id: 'replay.mode', keys: 'm', label: 'Replay: candles or recorded ticks', run: cmd.toggleMode, when: hasTicks },
        { id: 'replay.go-to', keys: 'g', label: 'Replay: go to a date', run: () => date.focus() },
    ];
    const descriptor = (s: (typeof specs)[number], gate: () => boolean): KeyBindingDescriptor => ({
        id: s.id,
        keys: s.keys,
        label: s.label,
        category: 'Replay',
        // Handled by hand below: a pressed button must keep its own space bar.
        preventDefault: false,
        when: () => gate() && (s.when?.() ?? true),
        run: (ev) => {
            if (s.keys === 'space' && isPressable(ev)) return;
            ev.preventDefault();
            /* Immediate: the workspace routes every bare letter to its symbol search from a second
             * listener on the same element, which stopPropagation alone does not reach. */
            ev.stopImmediatePropagation();
            s.run();
        },
    });

    const area = new KeymapManager();
    area.attach(stack);
    const offs: Array<() => void> = [];
    for (const s of specs) {
        // The workspace mutes its own bindings while a dialog is open; the area's follow it.
        offs.push(ws.keymap.register(descriptor(s, () => true)));
        area.register(descriptor(s, () => ws.keymap.activeScope === 'chart'));
    }

    return {
        el: bar,
        dispose() {
            stop();
            for (const off of offs) off();
            area.destroy();
            bar.remove();
        },
    };
}

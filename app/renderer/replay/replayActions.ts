import { registerIcon, registerWidgetAction } from '../../../src/plugin';
import type { Vela } from '../../../src';
import type { VelaWorkspace } from '../../../src/workspace';
import type { ReplayController } from './ReplayController';
import { armOrderTool } from './replayOrders';
import { lastCrosshairTime } from '../alerts/cursorPrice';
import { askJournalEntry } from '../journal/journalEntryDialog';
import { timeframeLabel } from '../../../src/widget/timeframe';
import { askSetupStrategy, loadSetupStrategy, saveSetupStrategy, strategyName } from './setupStrategy';

/**
 * The replay controls, contributed into Vela's own topbar — no custom chrome.
 *
 * `WidgetActionDescriptor.label`/`icon` are static, so a button whose face
 * changes (play/pause, the speed readout) is re-registered under the same id
 * and the shell asked to refresh — re-registering an id replaces it. Every
 * action is gated on the chart the active session belongs to, so none of them
 * appear on the walking-skeleton chart.
 */

let active: ActiveReplay | null = null;

/**
 * Leave the session: the screen takes it down and says `message` where the person lands.
 *
 * The session's own workspace is about to be destroyed, so the words cannot go through its
 * toast — whoever takes the session down owns saying what happened to it.
 */
export type LeaveHandler = (outcome: { message: string; kind: 'info' | 'success' }) => void;

export interface ActiveReplay {
    controller: ReplayController;
    ws: VelaWorkspace;
    /** The chart the session trades on. The window's other charts only watch its clock. */
    primary: () => Vela;
    /** Take the session down once it has been put down or filed. */
    leave: LeaveHandler;
    /** Open the stop and target a fresh ticket starts with. */
    editBrackets: () => void;
}

const ICONS: Record<string, string> = {
    'replay-brackets': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5h11M2.5 12.5h11"/><path d="M8 5.5v5"/><path d="M6.2 7.3 8 5.5l1.8 1.8M6.2 8.7 8 10.5l1.8-1.8"/></svg>',
    'replay-snapshot': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.5h2.2l1-1.5h3.6l1 1.5H14v7.5H2z"/><circle cx="8" cy="8.8" r="2.1"/></svg>',
    'replay-flatten': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/></svg>',
    'replay-order': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="11" height="4.5" rx="0.8"/><path d="M2.5 11.5h11"/><path d="M8 2v2M8 8.5v3"/></svg>',
    'replay-park': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h8.5L13 4v9.5H3z"/><path d="M5.5 2.5v4h5v-4"/></svg>',
    'replay-discard': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v3.8M9.2 7v3.8"/></svg>',
    'replay-finish': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>',
};

let iconsRegistered = false;
function ensureIcons(): void {
    if (iconsRegistered) return;
    iconsRegistered = true;
    for (const [id, markup] of Object.entries(ICONS)) registerIcon(id, markup);
}

/** The gate: an action is only shown in the window its session drives — on any chart of it, since
 *  the clock belongs to the session and not to one chart. */
function onActiveChart(ctx: { chart: unknown }): boolean {
    return active != null && active.ws.cells().some((cell) => cell.chart === ctx.chart);
}

/** The gate for what is about the market the session trades: only its own chart answers it. */
function onTradingChart(ctx: { chart: unknown }): boolean {
    return active != null && active.primary() === ctx.chart;
}

/**
 * Whether this context is the running replay's — the gate the other way round, for actions
 * that make sense everywhere EXCEPT inside a session.
 *
 * Takes the CONTEXT, not the chart, so `active` is tested first: a shell evaluates every
 * `when()` while it builds its topbar, which is before it has an active cell, and reading
 * `ctx.chart` at that moment throws. Short-circuiting past it is what `onActiveChart`
 * above already does, for the same reason.
 */
export function isReplayContext(ctx: { readonly chart: unknown }): boolean {
    return active != null && active.ws.cells().some((cell) => cell.chart === ctx.chart);
}

/** Put a failed transport call in front of the person who pressed it. */
function report(ctx: { toast(message: string, kind?: 'info' | 'error' | 'success'): void }) {
    return (e: unknown): void => ctx.toast(e instanceof Error ? e.message : String(e), 'error');
}

function registerControls(): void {
    registerWidgetAction({
        id: 'replay.order',
        target: 'topbar',
        align: 'right',
        order: 5,
        iconOnly: true,
        label: 'Draw an order',
        icon: 'replay-order',
        when: onTradingChart,
        run: (ctx) => {
            if (!active) return;
            armOrderTool(active.primary());
            ctx.toast('Click the entry, drag to the target — then right-click the block to order');
        },
    });

    registerWidgetAction({
        id: 'replay.brackets',
        target: 'topbar',
        align: 'right',
        order: 5.5,
        iconOnly: true,
        label: 'Stop and target for a fresh ticket',
        icon: 'replay-brackets',
        when: onTradingChart,
        run: () => active?.editBrackets(),
    });

    registerWidgetAction({
        id: 'replay.snapshot',
        target: 'topbar',
        align: 'right',
        order: 5.8,
        iconOnly: true,
        label: 'Keep a snapshot of the chart for the journal',
        icon: 'replay-snapshot',
        when: onActiveChart,
        run: (ctx) => {
            if (!active) return;
            const { controller, ws } = active;
            try {
                const image = ws.screenshot();
                if (!image) throw new Error('The chart could not be captured.');
                // Numbered, not timed: the image carries the session clock it was taken at.
                controller.addShot(image, `Snapshot ${controller.shotCount + 1}`);
                ctx.toast(`Snapshot ${controller.shotCount} kept — it is filed with the run when you end the session.`, 'success');
            } catch (e: unknown) {
                ctx.toast(e instanceof Error ? e.message : String(e), 'error');
            }
        },
    });

    registerWidgetAction({
        id: 'replay.flatten',
        target: 'topbar',
        align: 'right',
        order: 6,
        iconOnly: true,
        label: 'Close all positions',
        icon: 'replay-flatten',
        when: onActiveChart,
        run: (ctx) => {
            if (!active) return;
            if (active.controller.session.broker.isFlat) {
                ctx.toast('Nothing open to close');
                return;
            }
            active.controller.flatten();
            ctx.toast('Positions closed');
        },
    });

    registerWidgetAction({
        id: 'replay.park',
        target: 'topbar',
        align: 'right',
        order: 7,
        iconOnly: true,
        label: 'Pause session for later',
        icon: 'replay-park',
        when: onActiveChart,
        run: (ctx) => {
            if (!active) return;
            const { controller, leave } = active;
            void controller
                .saveSession()
                .then(() => leave({ message: 'Session put down — pick it up again from the Replay tab.', kind: 'info' }))
                .catch((e: unknown) => ctx.toast(e instanceof Error ? e.message : String(e), 'error'));
        },
    });

    registerWidgetAction({
        id: 'replay.finish',
        target: 'topbar',
        align: 'right',
        order: 8,
        iconOnly: true,
        label: 'End and save as run',
        icon: 'replay-finish',
        when: onActiveChart,
        run: (ctx) => {
            if (!active) return;
            const { controller, leave, ws } = active;
            /* Said before anything is asked: a session with no trades cannot be filed, and a
             * dialog that took a note only to be refused would have wasted it. */
            if (controller.broker.trades.length === 0) {
                ctx.toast('This session took no trades, so there is nothing to file as a run. Discard it, or place a trade first.', 'error');
                return;
            }
            controller.pause();
            void askJournalEntry(ws.root, {
                session: `${controller.symbol} · ${timeframeLabel(controller.timeframe)}`,
                snapshots: controller.shotCount,
            })
                .then(async (entry) => {
                    if (!entry) return; // dismissed — the session carries on
                    const { failed } = await controller.saveAsRun(entry);
                    if (failed.length === 0) {
                        leave({ message: 'Session saved as a run — open it in Analysis → Sessions.', kind: 'success' });
                        return;
                    }
                    // The run exists, so the session is over; what did not come with it is said out loud.
                    leave({
                        message: `Session saved as a run, but ${failed.length} ${failed.length === 1 ? 'snapshot' : 'snapshots'} `
                            + `could not be attached: ${failed[0]}`,
                        kind: 'info',
                    });
                })
                .catch((e: unknown) => ctx.toast(e instanceof Error ? e.message : String(e), 'error'));
        },
    });
}

/** How long a first press on Discard stays armed. */
const DISCARD_ARM_MS = 5000;
let discardArmedAt = 0;

/**
 * Throw the session away without filing anything.
 *
 * The one way out of a session that took no trades — filing one is refused — and the one that
 * cannot be undone, so it takes two presses: the first says what it will do, the second does it.
 */
function registerDiscard(): void {
    registerWidgetAction({
        id: 'replay.discard',
        target: 'topbar',
        align: 'right',
        order: 9,
        iconOnly: true,
        label: 'Discard session',
        icon: 'replay-discard',
        when: onActiveChart,
        run: (ctx) => {
            if (!active) return;
            const now = Date.now();
            if (now - discardArmedAt > DISCARD_ARM_MS) {
                discardArmedAt = now;
                ctx.toast('Press Discard again to throw this session away. Nothing is saved.', 'info');
                return;
            }
            discardArmedAt = 0;
            active.controller.pause();
            active.leave({ message: 'Session discarded.', kind: 'info' });
        },
    });
}

/** `2026-09-14 14:35`, in UTC — the replay's clock is UTC, and so is its setup dialog. */
function candleLabel(ms: number): string {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

/**
 * Right-click a candle, go back to it.
 *
 * On the chart's own context menu rather than in the topbar, because the question it answers
 * is "which candle" and the pointer has already answered it. Only over a candle — over the
 * empty space to the right of the newest one there is nothing to go back to.
 */
function registerJumpHere(): void {
    registerWidgetAction({
        id: 'replay.setupStrategy',
        target: 'context:body',
        label: 'Next setup: choose strategy…',
        when: onTradingChart,
        run: (ctx) => {
            if (!active) return;
            void askSetupStrategy(active.ws.root, loadSetupStrategy()).then((id) => {
                if (!id) return;
                saveSetupStrategy(id);
                ctx.toast(`Next setup now looks for ${strategyName(id)}.`);
            });
        },
    });

    registerWidgetAction({
        id: 'replay.jumpHere',
        target: 'context:body',
        label: 'Jump back here',
        when: (ctx) => onTradingChart(ctx) && lastCrosshairTime() != null,
        run: (ctx) => {
            const time = lastCrosshairTime();
            if (!active || time == null) return;
            const { controller } = active;
            void controller.jumpTo(time)
                .then(() => {
                    ctx.toast(`Back at ${candleLabel(time)} UTC — everything done after it is gone.`, 'success');
                })
                .catch((e: unknown) => ctx.toast(e instanceof Error ? e.message : String(e), 'error'));
        },
    });
}

/** Point the replay controls at a mounted session — or `null` to retire them. */
export function setActiveReplay(next: ActiveReplay | null): void {
    ensureIcons();
    const previous = active;
    active = next;
    registerControls();
    registerDiscard();
    registerJumpHere();
    discardArmedAt = 0;
    next?.ws.refreshActions();
    if (previous && previous !== next) previous.ws.refreshActions();
}

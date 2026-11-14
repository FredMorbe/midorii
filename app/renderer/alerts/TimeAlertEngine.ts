import type { AlertListStore } from './AlertListStore';
import type { TimeAlert } from './timeAlertModel';

/**
 * The longest the engine sleeps before looking at the clock again. A timer set for an hour
 * from now runs late, or not at all, when the machine sleeps or the clock is changed; a
 * short look is what keeps a reminder close to its time through both.
 */
const LOOK_EVERY_MS = 30_000;

/**
 * Fires each enabled time alert once its moment has come. An alert that came due while the
 * app was closed fires at the next start, with how late it is, so a missed reminder is told
 * as missed rather than dropped.
 */
export class TimeAlertEngine {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private unsubStore: (() => void) | null = null;

    constructor(
        private readonly store: AlertListStore<TimeAlert>,
        private readonly onTrigger: (alert: TimeAlert, lateMs: number) => void,
        private readonly now: () => number = () => Date.now(),
    ) {}

    start(): void {
        this.unsubStore = this.store.onChange(() => this.look());
        this.look();
    }

    stop(): void {
        this.unsubStore?.();
        this.unsubStore = null;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private looking = false;

    private look(): void {
        // Updating an alert tells the store's listeners, this one included: the look already
        // under way finishes the job, and a second one running inside it would fire twice.
        if (this.looking) return;
        this.looking = true;
        try {
            if (this.timer) clearTimeout(this.timer);
            this.timer = null;
            const now = this.now();
            for (const alert of this.store.list()) {
                if (!alert.enabled || alert.at > now) continue;
                // Disable before notifying: a notification that throws must not leave the alert armed to fire again.
                this.store.update(alert.id, { enabled: false, lastTriggeredAt: now });
                this.onTrigger(alert, now - alert.at);
            }
            const upcoming = this.store.list().filter((a) => a.enabled).map((a) => a.at);
            if (upcoming.length === 0) return;
            const wait = Math.min(Math.max(Math.min(...upcoming) - this.now(), 0), LOOK_EVERY_MS);
            this.timer = setTimeout(() => this.look(), wait);
        } finally {
            this.looking = false;
        }
    }
}

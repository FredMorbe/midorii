
/**
 * The pause a repeating alert takes after it fires. A market that wobbles around a level
 * crosses it again and again within seconds; without a pause each crossing is a notification.
 * A crossing that happens during the pause is not told later: the alert fires on the next
 * crossing after the pause, or, for a percent alert, once the move is still there.
 */
export const COOLDOWN_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
    { value: '0', label: 'No pause' },
    { value: '60000', label: '1 minute' },
    { value: '300000', label: '5 minutes' },
    { value: '900000', label: '15 minutes' },
    { value: '3600000', label: '1 hour' },
];

/** What a new alert starts with. Alerts made before the pause existed have none and keep firing as they did. */
export const DEFAULT_COOLDOWN_MS = 60_000;

export interface CoolingAlert {
    once: boolean;
    cooldownMs?: number;
    lastTriggeredAt: number | null;
}

/** Whether a repeating alert is still pausing after its last firing. An alert that fires once never pauses: it is off. */
export function coolingDown(alert: CoolingAlert, now: number): boolean {
    if (alert.once || alert.lastTriggeredAt == null) return false;
    const pause = alert.cooldownMs ?? 0;
    return pause > 0 && now - alert.lastTriggeredAt < pause;
}

/** A stored pause that is a number of at least zero, or nothing. */
export function readCooldown(raw: unknown): number | undefined {
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

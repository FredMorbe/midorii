import { buildFieldControl, fieldRow } from '../../../src/ui';
import { COOLDOWN_OPTIONS } from './alertCooldown';

/**
 * The dialog row that sets the pause, shown only while the alert repeats. `setOnce` follows the
 * "Once" switch: an alert that fires once has no use for it.
 */
export function pauseRow(cooldownMs: number | undefined, once: boolean, onChange: (ms: number) => void): { row: HTMLElement; setOnce: (once: boolean) => void } {
    const ms = cooldownMs ?? 0;
    const options = COOLDOWN_OPTIONS.some((o) => o.value === String(ms))
        ? COOLDOWN_OPTIONS
        : [...COOLDOWN_OPTIONS, { value: String(ms), label: `${Math.round(ms / 1000)} seconds` }];
    const row = fieldRow({
        label: 'Pause after firing',
        control: buildFieldControl({
            kind: 'select', options, value: String(ms), fill: true,
            onChange: (v) => onChange(Number(v)),
        }).el,
        controlWidth: 240,
    });
    const setOnce = (value: boolean): void => {
        // Inline, because the row's own styling sets a display that the `hidden` attribute would not beat.
        row.style.display = value ? 'none' : '';
    };
    setOnce(once);
    return { row, setOnce };
}

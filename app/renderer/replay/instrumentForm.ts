import { NumberInput, Switch } from '../../../src/ui';
import { COSTS_HINT, MIN_SIZE_HINT, POINT_VALUE_HINT, SIZE_STEP_HINT } from '../instrumentHints';
import { SPOT_ACCOUNT, type ReplayAccountSettings } from './instrument';

/** How the screen lays one labelled control out — the form does not own a look of its own. */
export type RowFactory = (label: string, control: HTMLElement, hint?: string) => HTMLElement;

export interface InstrumentForm {
    /** The rows, in the order they are read. */
    rows: HTMLElement[];
    /** What the controls hold right now. */
    read(): ReplayAccountSettings;
    /** Put every control onto `next` — a different market has different answers. */
    set(next: ReplayAccountSettings): void;
}

const HEDGING_HINT = 'On: an order the other way opens a position of its own, so a long and a short can be '
    + 'held at once. Off: it reduces or closes the position that is open. Fixed for the session — '
    + 'start a new one to change it.';

/**
 * The questions an account has to be asked before a market can be traded on it.
 *
 * Built from the same words the Backtest tab uses (see instrumentHints.ts). `onChange` fires on
 * every edit so a screen can keep a summary line honest.
 */
export function instrumentForm(
    row: RowFactory,
    initial: ReplayAccountSettings = SPOT_ACCOUNT,
    onChange: () => void = () => {},
): InstrumentForm {
    const costs = new Switch({ checked: initial.costsOn, onChange });
    const pointValue = new NumberInput({
        value: initial.pointValue, min: 0.0001, step: 1, onChange,
    });
    const sizeStep = new NumberInput({
        value: initial.sizeStep ?? 0, min: 0, step: 1, placeholder: 'none', emptyValue: 0, onChange,
    });
    const minSize = new NumberInput({
        value: initial.minSize ?? 0, min: 0, step: 1, placeholder: 'none', emptyValue: 0, onChange,
    });
    const hedging = new Switch({ checked: initial.hedging, onChange });

    return {
        rows: [
            row('Trading costs', costs.el, COSTS_HINT),
            row('Point value', pointValue.el, POINT_VALUE_HINT),
            row('Size step', sizeStep.el, SIZE_STEP_HINT),
            row('Minimum size', minSize.el, MIN_SIZE_HINT),
            row('Hedging', hedging.el, HEDGING_HINT),
        ],
        read: () => ({
            costsOn: costs.checked,
            pointValue: pointValue.value,
            sizeStep: sizeStep.value > 0 ? sizeStep.value : null,
            minSize: minSize.value > 0 ? minSize.value : null,
            hedging: hedging.checked,
        }),
        set(next) {
            costs.setChecked(next.costsOn);
            pointValue.setValue(next.pointValue);
            sizeStep.setValue(next.sizeStep ?? 0);
            minSize.setValue(next.minSize ?? 0);
            hedging.setChecked(next.hedging);
            onChange();
        },
    };
}

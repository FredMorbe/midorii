import type { SeriesTransform, SeriesTransformFactory } from '../core/price-styles/SeriesTransform';
import { brickTransform, type BrickMachine } from '../core/price-styles/bricks/driver';
import { KagiMachine, LineBreakMachine, PointFigureMachine, RangeMachine, RenkoMachine } from '../core/price-styles/bricks/machines';
import { readSizeSettings, resolveSize, type SizeSettings } from '../core/price-styles/bricks/sizing';
import type { ChartTypeSettingsSection, SettingsRowDescriptor } from './registry';

/**
 * The factories and settings of the price-driven chart types whose bars are ordinary bars:
 * range bars, Renko and line break. Each is registered as a chart type with a
 * {@link SeriesTransformFactory}, so the chart gets a transform made from the values the user
 * has chosen, and a new one whenever they change.
 */

/**
 * A transform whose machine is sized from the raw series: the size is worked out each time the
 * whole series is derived, and kept for the live ticks that follow, so a chart does not redraw
 * every brick whenever the market's range drifts.
 */
function sized(settings: SizeSettings, make: (size: number) => BrickMachine): SeriesTransform {
    let inner: SeriesTransform | null = null;
    let size = 0;
    const build = (raw: Parameters<SeriesTransform['full']>[0]): SeriesTransform => {
        size = resolveSize(settings, raw);
        const resolved = size;
        inner = brickTransform({ make: () => make(resolved) });
        return inner;
    };
    return {
        full: (raw) => build(raw).full(raw),
        update: (raw, view) => (inner ?? build(raw)).update(raw, view),
        info: () => ({ size }),
    };
}

export const rangeBarsFactory: SeriesTransformFactory = (values) =>
    sized(readSizeSettings(values, { atrFactor: 0.5 }), (size) => new RangeMachine(size));

export const renkoFactory: SeriesTransformFactory = (values) =>
    sized(readSizeSettings(values, { atrFactor: 1 }), (size) => new RenkoMachine(size));

export const lineBreakFactory: SeriesTransformFactory = (values) => {
    const raw = typeof values.lines === 'number' && Number.isFinite(values.lines) ? values.lines : 3;
    const count = Math.min(10, Math.max(1, Math.round(raw)));
    return brickTransform({ make: () => new LineBreakMachine(count), closesOnly: true });
};

export const kagiFactory: SeriesTransformFactory = (values) =>
    sized(readSizeSettings(values, { atrFactor: 1 }), (size) => new KagiMachine(size));

export const pointFigureFactory: SeriesTransformFactory = (values) => {
    const raw = typeof values.reversal === 'number' && Number.isFinite(values.reversal) ? values.reversal : 3;
    const reversal = Math.min(10, Math.max(1, Math.round(raw)));
    return sized(readSizeSettings(values, { atrFactor: 0.5 }), (size) => new PointFigureMachine(size, reversal));
};

/** The rows that choose a brick, box or reversal size: an ATR multiple, or a fixed price distance. */
export function sizeRows(atrFactor: number, label = 'Size'): SettingsRowDescriptor[] {
    return [
        { kind: 'select', key: 'sizeMode', label, options: ['ATR', 'Fixed'], defval: 'ATR' },
        { kind: 'number', key: 'atrLength', label: 'ATR length', defval: 14, min: 1, max: 500, step: 1, when: { key: 'sizeMode', equals: 'ATR' } },
        { kind: 'number', key: 'atrFactor', label: 'ATR multiple', defval: atrFactor, min: 0.01, max: 100, step: 0.05, when: { key: 'sizeMode', equals: 'ATR' } },
        { kind: 'number', key: 'size', label: 'Fixed amount (price)', defval: 0, min: 0, step: 0.01, when: { key: 'sizeMode', equals: 'Fixed' } },
    ];
}

export const rangeBarsSettings: ChartTypeSettingsSection = { title: 'Range bars', rows: sizeRows(0.5) };
export const renkoSettings: ChartTypeSettingsSection = { title: 'Renko', rows: sizeRows(1) };
export const lineBreakSettings: ChartTypeSettingsSection = {
    title: 'Line break',
    rows: [{ kind: 'number', key: 'lines', label: 'Number of lines', defval: 3, min: 1, max: 10, step: 1 }],
};

export const kagiSettings: ChartTypeSettingsSection = { title: 'Kagi', rows: sizeRows(1, 'Reversal') };
export const pointFigureSettings: ChartTypeSettingsSection = {
    title: 'Point and figure',
    rows: [
        ...sizeRows(0.5, 'Box size'),
        { kind: 'number', key: 'reversal', label: 'Boxes to reverse', defval: 3, min: 1, max: 10, step: 1 },
    ],
};

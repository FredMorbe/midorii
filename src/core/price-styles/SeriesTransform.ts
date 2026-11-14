import type { OHLCV } from '../model/ohlcv';

/**
 * What changed at the end of a chart's view series: the view keeps its first `from` bars and
 * continues with `bars`. A delta that changes nothing has `from` at the view's length and no bars.
 */
export interface ViewDelta {
    from: number;
    bars: OHLCV[];
}

/**
 * A price style that turns the raw bar stream into a view of ANOTHER LENGTH and time axis:
 * Renko bricks, range bars, line breaks, Kagi lines, Point and Figure columns. Where a
 * {@link import('./BarTransform').BarTransform} is 1:1 and time-preserving (Heikin Ashi), this
 * one may produce any number of view bars from a raw bar, and a live tick may add several,
 * change the last, or take back what an earlier tick of the same forming bar had produced.
 *
 * A transform is STATEFUL, made once per chart by the type's factory (so it holds that chart's
 * settings), and rebuilt whenever its settings change. The raw series stays the source of truth:
 * a view bar is never stored back as data, and the `'bar'` event stays on the raw plane.
 *
 * View bars must be strictly ascending in `time`, as every other series is. A transform that
 * makes several bars from one raw bar spaces their times a millisecond apart from that bar's own
 * time, so the time axis, drawings and indicators keep working on them.
 */
export interface SeriesTransform {
    /** Derive the whole view from the whole raw series. Discards whatever the transform knew. */
    full(raw: readonly OHLCV[]): OHLCV[];
    /**
     * The raw series changed at its end: the forming bar was revised, or a new one opened.
     * `view` is the view as the chart holds it now; answer what replaces its tail. Anything
     * the transform has already finished with must not change, so the work stays proportional
     * to the change and not to the length of the series.
     */
    update(raw: readonly OHLCV[], view: readonly OHLCV[]): ViewDelta;
    /**
     * What a renderer layer drawing this type needs to know about the view and cannot read off
     * its bars, such as the size of the box a column is made of. Pushed to the layer named like
     * the type each time the whole view is derived. Absent for a type drawn as ordinary bars.
     */
    info?(): unknown;
}

/** Makes one chart's transform from the settings the user has chosen for the type. */
export type SeriesTransformFactory = (settings: Record<string, unknown>) => SeriesTransform;

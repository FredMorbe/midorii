// Built-in chart types registered through the SAME public registry a plugin would use —
// Heikin Ashi is the reference bar-transform type, and range bars, Renko and line break are the
// reference series-transform types (a view of another length). (Volume/VPVR go through the
// native indicator registry instead: they are layers over any style, not styles themselves.)
import { registerChartType } from './registry';
import { heikinAshiFull, heikinAshiNext } from '../core/price-styles/heikin-ashi';
import type { BarTransform } from '../core/price-styles/BarTransform';
import { svg16 } from '../core/icons';
import {
    kagiFactory, kagiSettings, lineBreakFactory, lineBreakSettings, pointFigureFactory, pointFigureSettings,
    rangeBarsFactory, rangeBarsSettings, renkoFactory, renkoSettings,
} from './priceDriven';

/** Singleton so the orchestrator can compare transforms by identity across style flips. */
const HEIKIN_ASHI: BarTransform = { full: heikinAshiFull, next: heikinAshiNext };

const FILL = 'fill="currentColor" fill-opacity="0.25"';

/** Register the built-in chart types (idempotent — called by the Vela constructor). */
export function registerBuiltinChartTypes(): void {
    registerChartType({ id: 'heikinashi', label: 'Heikin Ashi', barTransform: HEIKIN_ASHI });
    registerChartType({
        id: 'rangebars',
        label: 'Range bars',
        icon: svg16(`<rect x="2.5" y="7.5" width="3" height="5.5" ${FILL}/><rect x="6.5" y="5" width="3" height="5.5" ${FILL}/><rect x="10.5" y="2.5" width="3" height="5.5" fill="currentColor"/>`),
        seriesTransform: rangeBarsFactory,
        settings: rangeBarsSettings,
    });
    registerChartType({
        id: 'renko',
        label: 'Renko',
        icon: svg16(`<rect x="2.5" y="9" width="3.5" height="3.5" ${FILL}/><rect x="6.2" y="5.8" width="3.5" height="3.5" ${FILL}/><rect x="9.9" y="2.6" width="3.5" height="3.5" fill="currentColor"/>`),
        seriesTransform: renkoFactory,
        settings: renkoSettings,
    });
    registerChartType({
        id: 'linebreak',
        label: 'Line break',
        icon: svg16(`<rect x="2.5" y="8.5" width="3" height="5" ${FILL}/><rect x="6.5" y="5" width="3" height="6.5" ${FILL}/><rect x="10.5" y="2.5" width="3" height="6" fill="currentColor"/>`),
        seriesTransform: lineBreakFactory,
        settings: lineBreakSettings,
    });
    // Kagi and Point and Figure are not drawn as bars: a renderer layer of the same id draws
    // them from the view, and the candles stay off under it.
    registerChartType({
        id: 'kagi',
        label: 'Kagi',
        icon: svg16('<path d="M3 13V8.5h4V3.5h3.5V9H14V13"/>'),
        seriesTransform: kagiFactory,
        settings: kagiSettings,
        basePainting: 'none',
    });
    registerChartType({
        id: 'pointfigure',
        label: 'Point and figure',
        icon: svg16('<path d="m3 3 3 3M6 3 3 6M3 9.5l3 3M6 9.5l-3 3"/><circle cx="11.5" cy="4.5" r="1.7"/><circle cx="11.5" cy="9.5" r="1.7"/>'),
        seriesTransform: pointFigureFactory,
        settings: pointFigureSettings,
        basePainting: 'none',
    });
}

import { registerRendererLayer, type RendererLayerArgs, type RendererLayerInstance } from './layers';
import { boxSizeOf, figureColumn, kagiLines, type KagiLine } from './priceDrivenGeometry';

/**
 * The renderer layers of the price-driven chart types that are not drawn as bars: Kagi and Point
 * and Figure. Each is registered under the id of its chart type, so the chart's own bars (what
 * the type made of the market) arrive as `args.bars` and the layer draws only while the type is
 * the active price style. The candles are off under them (`basePainting: 'none'` on the type).
 */

const THIN = 1.2;

/** The part of the canvas the pane owns, in the CSS pixels the coordinate system speaks. */
function begin(canvas: HTMLCanvasElement, args: RendererLayerArgs): CanvasRenderingContext2D | null {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const dpr = args.coords.dpr;
    ctx.scale(dpr, dpr);
    ctx.beginPath();
    ctx.rect(0, args.bounds.top, args.coords.width, args.bounds.height);
    ctx.clip();
    return ctx;
}

/** The bars on screen, with one more at each end so a line leaving the edge is drawn to it. */
function visible(args: RendererLayerArgs): { from: number; to: number } {
    const range = args.coords.visibleLogicalRange();
    return { from: Math.max(0, Math.floor(range.from) - 1), to: Math.min(args.bars.length - 1, Math.ceil(range.to) + 1) };
}

class KagiLayer implements RendererLayerInstance {
    private canvas: HTMLCanvasElement | null = null;
    private cache: { bars: unknown; length: number; last: string; lines: KagiLine[] } | null = null;

    mount(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
    }

    /** Thickness depends on the lines before, so it is worked out for the whole series and kept until the series changes. */
    private linesOf(args: RendererLayerArgs): KagiLine[] {
        const bars = args.bars;
        const lastBar = bars[bars.length - 1];
        const last = lastBar ? `${lastBar.open}:${lastBar.close}` : '';
        if (!this.cache || this.cache.bars !== bars || this.cache.length !== bars.length || this.cache.last !== last) {
            this.cache = { bars, length: bars.length, last, lines: kagiLines(bars) };
        }
        return this.cache.lines;
    }

    render(args: RendererLayerArgs): void {
        const ctx = this.canvas ? begin(this.canvas, args) : null;
        if (!ctx || args.priceStyle !== 'kagi' || args.bars.length === 0) return;
        const { coords, scale, bounds, theme } = args;
        const y = (price: number): number => coords.priceToY(price, scale, bounds);
        const lines = this.linesOf(args);
        const thickWidth = Math.min(4, Math.max(2, coords.bodySpacing() * 0.35));
        const range = visible(args);

        const stroke = (x1: number, y1: number, x2: number, y2: number, thick: boolean): void => {
            ctx.beginPath();
            ctx.lineWidth = thick ? thickWidth : THIN;
            ctx.strokeStyle = thick ? theme.upColor : theme.downColor;
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        };

        for (let i = range.from; i <= range.to; i++) {
            const bar = args.bars[i]!;
            const line = lines[i]!;
            const x = coords.logicalToX(i);
            // The vertical line, in two pieces where it changes thickness.
            if (line.switchAt == null) {
                stroke(x, y(bar.open), x, y(bar.close), line.thickAtEnd);
            } else {
                stroke(x, y(bar.open), x, y(line.switchAt), line.thickAtStart);
                stroke(x, y(line.switchAt), x, y(bar.close), line.thickAtEnd);
            }
            // The short horizontal where it turns, drawn to the next line.
            if (i < args.bars.length - 1) stroke(x, y(bar.close), coords.logicalToX(i + 1), y(bar.close), line.thickAtEnd);
        }
    }

    destroy(): void {
        this.canvas = null;
        this.cache = null;
    }
}

class PointFigureLayer implements RendererLayerInstance {
    private canvas: HTMLCanvasElement | null = null;

    mount(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
    }

    render(args: RendererLayerArgs): void {
        const ctx = this.canvas ? begin(this.canvas, args) : null;
        if (!ctx || args.priceStyle !== 'pointfigure' || args.bars.length === 0) return;
        const { coords, scale, bounds, theme } = args;
        const size = boxSizeOf(args.data, args.bars);
        const boxHeight = Math.abs(coords.priceToY(0, scale, bounds) - coords.priceToY(size, scale, bounds));
        const glyph = Math.min(coords.bodySpacing(), boxHeight) * 0.8;
        const range = visible(args);
        ctx.lineWidth = glyph < 6 ? 1 : 1.4;

        for (let i = range.from; i <= range.to; i++) {
            const column = figureColumn(args.bars[i]!, size);
            const x = coords.logicalToX(i);
            const color = column.up ? theme.upColor : theme.downColor;
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            for (const price of column.boxes) {
                const cy = coords.priceToY(price, scale, bounds);
                if (cy < bounds.top - boxHeight || cy > bounds.top + bounds.height + boxHeight) continue;
                const half = glyph / 2;
                if (glyph < 3) {
                    // Too small to tell an X from an O: a filled mark keeps the column readable.
                    ctx.fillRect(x - half, cy - half, glyph, glyph);
                } else if (column.up) {
                    ctx.beginPath();
                    ctx.moveTo(x - half, cy - half);
                    ctx.lineTo(x + half, cy + half);
                    ctx.moveTo(x + half, cy - half);
                    ctx.lineTo(x - half, cy + half);
                    ctx.stroke();
                } else {
                    ctx.beginPath();
                    ctx.arc(x, cy, half, 0, Math.PI * 2);
                    ctx.stroke();
                }
            }
        }
    }

    destroy(): void {
        this.canvas = null;
    }
}

registerRendererLayer({ id: 'kagi', placement: 'above-data', create: () => new KagiLayer() });
registerRendererLayer({ id: 'pointfigure', placement: 'above-data', create: () => new PointFigureLayer() });

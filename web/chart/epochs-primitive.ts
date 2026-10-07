import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, PrimitivePaneViewZOrder, SeriesAttachedParameter, Time } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { epochsIn } from "../../src/epochs.ts";

/**
 * Marks where each Qubic epoch begins (Wednesday 12:00 UTC, src/epochs.ts) with a faint dashed line down the price pane and "Epoch 233" at its
 * top, behind the candles. A primitive on the price series, so it moves with the chart and is in its pictures.
 */
export class EpochsPrimitive implements ISeriesPrimitive<Time> {
  /** Set by the chart: how a time (seconds) becomes a pixel across, or null where it cannot be placed. */
  mapper: ((t: number) => number | null) | null = null;
  /** The colours of the page. */
  ink = { line: "rgba(160,165,190,0.35)", text: "#9a9fc0" };
  /** How many times bigger everything is drawn than on screen (a picture in 4K or 8K). */
  k = 1;
  private redraw: (() => void) | null = null;

  attached(p: SeriesAttachedParameter<Time>): void {
    this.redraw = p.requestUpdate;
  }
  detached(): void {
    this.redraw = null;
  }

  private view: IPrimitivePaneView = {
    zOrder: (): PrimitivePaneViewZOrder => "bottom",
    renderer: (): IPrimitivePaneRenderer | null => ({
      draw: (target: CanvasRenderingTarget2D) => {
        const x = this.mapper;
        if (!x) return;
        target.useMediaCoordinateSpace(({ context, mediaSize }) => {
          const k = this.k;
          const w = mediaSize.width;
          const h = mediaSize.height;
          // Every epoch from the one before the archive began to a couple of months ahead, each placed by the chart (a time outside the candles is
          // placed too) and drawn only if it lands inside the pane. Epochs are weekly, so that is a few dozen at most.
          const now = Date.now();
          const all = epochsIn(Date.UTC(2026, 2, 1), now + 8 * 7 * 24 * 3_600_000);
          context.save();
          context.beginPath();
          context.rect(0, 0, w, h);
          context.clip();
          context.lineWidth = Math.max(1, Math.round(k));
          context.strokeStyle = this.ink.line;
          context.setLineDash([4 * k, 4 * k]);
          context.font = `${11 * k}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif`;
          context.textBaseline = "bottom";
          let lastLabel = -Infinity;
          for (const e of all) {
            const px = x(e.startMs / 1000);
            if (px === null || !(px >= 0 && px <= w)) continue;
            context.beginPath();
            context.moveTo(Math.round(px) + 0.5, 0);
            context.lineTo(Math.round(px) + 0.5, h);
            context.stroke();
            // A label only if there is room before the next line could have one.
            if (px - lastLabel >= 78 * k) {
              context.setLineDash([]);
              context.fillStyle = this.ink.text;
              context.fillText(`Epoch ${e.epoch}`, px + 5 * k, h - 5 * k);
              context.setLineDash([4 * k, 4 * k]);
              lastLabel = px;
            }
          }
          context.restore();
        });
      },
    }),
  };

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }
}

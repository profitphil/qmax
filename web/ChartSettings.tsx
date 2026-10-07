import { CHART_THEMES } from "../src/charttheme.ts";
import type { ChartThemeId } from "../src/charttheme.ts";
import { DEFAULT_STYLE, FONTS, hexOf } from "../src/chartstyle.ts";
import type { ChartStyle, FontId, GradientDir, GridLine, ResolvedStyle } from "../src/chartstyle.ts";

interface Props {
  style: ChartStyle;
  /** What the chart is drawn with now: the colours shown in the pickers when nothing was chosen. */
  resolved: ResolvedStyle;
  onChange: (patch: Partial<ChartStyle>) => void;
  onReset: () => void;
  /** The chart is a line chart: the settings that only candles use are left out. */
  line?: boolean;
}

type ColourKey = "bg" | "bg2" | "up" | "down" | "wickUp" | "wickDown" | "line" | "grid" | "text" | "crosshair";

/** One setting: its name, and its control on the right. */
function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="cs-row" title={hint}>
      <span>{label}</span>
      <span className="cs-ctl">{children}</span>
    </label>
  );
}

function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="cs-row cs-check" title={hint}>
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/**
 * The chart's look, setting by setting: the scheme to start from and then the background (flat or a gradient), candle and wick colours, hollow
 * candles, lines, grid, type and the strength of the volume bars. A colour that was not chosen shows the scheme's own, with an "Auto" button
 * on the ones that were changed to go back. Everything is kept in this browser.
 */
export function ChartSettings({ style, resolved, onChange, onReset, line }: Props) {
  const c = resolved.colors;
  /** The colour a picker shows when nothing was chosen for it. */
  const shown: Record<ColourKey, string> = {
    bg: c.surface,
    bg2: resolved.gradient?.to ?? c.surface,
    up: c.up,
    down: c.down,
    wickUp: resolved.wickUp,
    wickDown: resolved.wickDown,
    line: c.accent,
    grid: c.grid,
    text: c.fg,
    crosshair: c.crosshair,
  };
  const colour = (key: ColourKey, label: string, hint?: string) => (
    <Row label={label} hint={hint}>
      <input type="color" value={hexOf(style[key] ?? shown[key])} onChange={(e) => onChange({ [key]: e.target.value } as Partial<ChartStyle>)} aria-label={label} />
      {style[key] !== null && (
        <button type="button" className="cs-auto" onClick={() => onChange({ [key]: null } as Partial<ChartStyle>)} title="Go back to the scheme's colour">Auto</button>
      )}
    </Row>
  );
  const range = (label: string, key: "lineWidth" | "fontSize" | "volumeOpacity", min: number, max: number, unit: string) => (
    <Row label={label}>
      <input type="range" className="cs-range" min={min} max={max} step={1} value={style[key]} onChange={(e) => onChange({ [key]: Number(e.target.value) } as Partial<ChartStyle>)} aria-label={label} />
      <output className="num cs-out">{style[key]}{unit}</output>
    </Row>
  );

  return (
    <div className="cs" role="group" aria-label="Chart settings">
      <div className="cs-head">
        <b>Chart settings</b>
        <button type="button" className="link" onClick={onReset} title="Back to the plain look, in the page's colours">Reset all</button>
      </div>

      <Row label="Colour scheme" hint="Where to start: the page's own colours or a fixed scheme. Your own choices below are kept on top of it.">
        <select value={style.preset} onChange={(e) => onChange({ preset: e.target.value as ChartThemeId })} aria-label="Colour scheme">
          {CHART_THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </Row>

      <div className="cs-title">Background</div>
      {colour("bg", "Colour")}
      <Check label="Gradient" checked={style.bgGradient} onChange={(v) => onChange({ bgGradient: v })} hint="Fade from the background colour to a second colour" />
      {style.bgGradient && (
        <>
          {colour("bg2", "Second colour")}
          <Row label="Direction">
            <select value={style.gradientDir} onChange={(e) => onChange({ gradientDir: e.target.value as GradientDir })} aria-label="Gradient direction">
              <option value="vertical">Top to bottom</option>
              <option value="horizontal">Left to right</option>
              <option value="diagonal">Diagonal</option>
            </select>
          </Row>
        </>
      )}

      {!line && (
        <>
          <div className="cs-title">Candles and bars</div>
          {colour("up", "Rising")}
          {colour("down", "Falling")}
          <Check label="Wicks match the candle" checked={style.wicksMatch} onChange={(v) => onChange({ wicksMatch: v })} />
          {!style.wicksMatch && (
            <>
              {colour("wickUp", "Rising wick")}
              {colour("wickDown", "Falling wick")}
            </>
          )}
          <Check label="Hollow rising candles" checked={style.hollowUp} onChange={(v) => onChange({ hollowUp: v })} hint="Draw rising candles as an outline only" />
          {range("Volume bars", "volumeOpacity", 10, 90, "%")}
        </>
      )}

      <div className="cs-title">Lines</div>
      {colour("line", "Line colour", "The line of a line chart, the edge of an area chart, and highlights")}
      {range("Thickness", "lineWidth", 1, 4, " px")}
      <Check label="Fill under an area chart" checked={style.areaFill} onChange={(v) => onChange({ areaFill: v })} />

      <div className="cs-title">Grid</div>
      <Check label="Vertical lines" checked={style.gridVert} onChange={(v) => onChange({ gridVert: v })} />
      <Check label="Horizontal lines" checked={style.gridHorz} onChange={(v) => onChange({ gridHorz: v })} />
      {colour("grid", "Colour")}
      <Row label="Line style">
        <select value={style.gridLine} onChange={(e) => onChange({ gridLine: e.target.value as GridLine })} aria-label="Grid line style">
          <option value="default">Default</option>
          <option value="solid">Solid</option>
          <option value="dotted">Dotted</option>
          <option value="dashed">Dashed</option>
        </select>
      </Row>

      <div className="cs-title">Text</div>
      <Row label="Typeface" hint="Fonts already on your device: nothing is downloaded">
        <select value={style.font} onChange={(e) => onChange({ font: e.target.value as FontId })} aria-label="Typeface">
          {FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </Row>
      {range("Size", "fontSize", 10, 16, " px")}
      {colour("text", "Text colour")}
      {colour("crosshair", "Crosshair")}
      <Check label="Name behind the chart" checked={style.watermark} onChange={(v) => onChange({ watermark: v })} />

      <p className="cs-note">Saved in this browser. {JSON.stringify(style) === JSON.stringify(DEFAULT_STYLE) ? "Showing the page's own look." : "Pictures you save use these settings too."}</p>
    </div>
  );
}

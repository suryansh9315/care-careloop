/**
 * Clinical chart primitives.
 *
 * Dependency-free SVG/CSS to match the rest of the dashboard. Every mark reads
 * its colour from the validated status palette via `toneMark`/`toneVars`, so a
 * band is never coloured by eye, and status is never carried by colour alone —
 * each chart pairs its marks with numbers and words.
 */
import { useState } from 'react';
import { bandForScore, clamp, toneMark, toneVars, type BandTone, type ScaleSpec } from './scale';

export interface TrendPoint { date: string; total: number }

/**
 * "Where does this score sit on the instrument?" — the full range segmented
 * into clinical bands with a marker at the current score. Answers "is 17 good
 * or bad?" for a reader who does not know the instrument.
 */
export function BandMeter({
  scale,
  total,
  showTicks = false,
}: {
  scale: ScaleSpec;
  total: number;
  showTicks?: boolean;
}): JSX.Element {
  const span = scale.max - scale.min || 1;
  const pct = (v: number) => (clamp(v, scale.min, scale.max) - scale.min) / span;
  const band = bandForScore(scale, total);

  return (
    <div className="bandmeter" role="img" aria-label={`${scale.instrument} ${total} of ${scale.max} — ${band.label}`}>
      <div className="bandmeter-track">
        {scale.bands.map((b) => (
          <div
            key={b.id}
            className="bandmeter-seg"
            style={{ width: `${((b.max - b.min + 1) / (span + 1)) * 100}%`, background: toneVars(b.tone).bg }}
          />
        ))}
        <div className="bandmeter-marker" style={{ left: `${pct(total) * 100}%` }} />
      </div>
      {showTicks && (
        <div className="bandmeter-ticks">
          {scale.bands.slice(1).map((b) => (
            <span key={b.id} className="bandmeter-tick" style={{ left: `${pct(b.min) * 100}%` }}>{b.min}</span>
          ))}
        </div>
      )}
      <div className="bandmeter-foot">
        <span className="mono">{scale.min}</span>
        <span className="bandmeter-current">
          <strong>{total}</strong>
          <span style={{ color: toneVars(band.tone).ink }}>{band.label}</span>
        </span>
        <span className="mono">{scale.max}</span>
      </div>
    </div>
  );
}

/** Signed change from first → latest, flagged when it clears the instrument's MCID. */
export function DeltaBadge({ points, scale }: { points: TrendPoint[]; scale: ScaleSpec }): JSX.Element | null {
  if (points.length < 2) return null;
  const delta = points[points.length - 1]!.total - points[0]!.total;
  if (delta === 0) {
    return <span className="delta tone-gray" title="No change since first check-in"><span aria-hidden>→</span> No change</span>;
  }
  const improving = scale.higherIsBetter ? delta > 0 : delta < 0;
  const meaningful = Math.abs(delta) >= scale.mcid;
  const signed = delta > 0 ? `+${delta}` : `${delta}`;
  return (
    <span
      className={`delta tone-${improving ? 'green' : 'red'}${meaningful ? ' meaningful' : ''}`}
      title={
        meaningful
          ? `${signed} ${scale.instrument} since first check-in — clinically meaningful (MCID ${scale.mcid})`
          : `${signed} ${scale.instrument} since first check-in`
      }
    >
      <span aria-hidden>{delta > 0 ? '↑' : '↓'}</span>
      <span>{signed}</span>
      {meaningful && <span className="delta-flag">clinically meaningful</span>}
    </span>
  );
}

export interface Segment { key: string; label: string; count: number; tone: BandTone }

/** Ordered stacked bar + legend, segments separated by a surface gap. */
export function SeverityBar({ segments }: { segments: Segment[] }): JSX.Element {
  const sum = segments.reduce((s, seg) => s + seg.count, 0) || 1;
  return (
    <div className="sevbar">
      <div className="sevbar-track" role="img" aria-label={segments.map((s) => `${s.label} ${s.count}`).join(', ')}>
        {segments.map((seg) =>
          seg.count > 0 ? (
            <div
              key={seg.key}
              className="sevbar-seg"
              style={{ width: `${(seg.count / sum) * 100}%`, background: toneMark(seg.tone) }}
              title={`${seg.label}: ${seg.count}`}
            />
          ) : null,
        )}
      </div>
      <div className="sevbar-legend">
        {segments.filter((s) => s.count > 0).map((seg) => (
          <span key={seg.key} className="sevbar-legend-item">
            <i style={{ background: toneMark(seg.tone) }} />
            {seg.label}
            <span className="muted"> {seg.count} · {Math.round((seg.count / sum) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Full score trend with clinical band shading behind the series, so the reader
 * sees not just the shape but which zone the patient is in.
 */
export function ScoreTrendChart({
  points,
  scale,
  height = 210,
}: {
  points: TrendPoint[];
  scale: ScaleSpec;
  height?: number;
}): JSX.Element {
  const [hover, setHover] = useState<number>();
  if (points.length === 0) {
    return <p className="small muted">No prior scores recorded. The trend fills in from the second check-in.</p>;
  }

  const W = 640;
  const H = height;
  const padL = 34, padR = 16, padT = 16, padB = 28;
  const span = scale.max - scale.min || 1;
  const x = (i: number) => (points.length === 1 ? padL : padL + (i / (points.length - 1)) * (W - padL - padR));
  const y = (v: number) => H - padB - ((clamp(v, scale.min, scale.max) - scale.min) / span) * (H - padT - padB);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.total)}`).join(' ');
  const area = points.length > 1 ? `${line} L${x(points.length - 1)},${H - padB} L${x(0)},${H - padB} Z` : '';
  const latest = points[points.length - 1]!;
  const band = bandForScore(scale, latest.total);

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${scale.instrumentLong} trend. ${points.map((p) => `${p.date.slice(0, 10)}: ${p.total}`).join('. ')}`}
        onMouseLeave={() => setHover(undefined)}
      >
        {/* Band zones sit behind the series — context, never the subject. */}
        {scale.bands.map((b) => (
          <g key={b.id}>
            <rect
              x={padL}
              y={y(b.max)}
              width={W - padL - padR}
              height={Math.max(0, y(b.min) - y(b.max))}
              fill={toneVars(b.tone).bg}
            />
            <text x={padL + 6} y={y(b.max) + 13} fontSize="10.5" fill={toneVars(b.tone).ink} opacity={0.9}>
              {b.label}
            </text>
          </g>
        ))}

        {[scale.min, ...scale.bands.slice(1).map((b) => b.min), scale.max].map((tick) => (
          <text key={tick} x={padL - 8} y={y(tick) + 4} fontSize="11" fill="var(--muted)" textAnchor="end">{tick}</text>
        ))}

        {points.length > 1 && <path d={area} fill="var(--series-1)" opacity={0.1} />}
        {points.length > 1 && (
          <path d={line} fill="none" stroke="var(--series-1)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
        )}

        {points.map((p, i) => (
          <g key={`${p.date}-${i}`}>
            <rect x={x(i) - 16} y={padT - 10} width={32} height={H - padT - padB + 16} fill="transparent" onMouseEnter={() => setHover(i)} />
            <circle cx={x(i)} cy={y(p.total)} r={hover === i ? 6 : 4.5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth="2" />
          </g>
        ))}
        <text x={x(points.length - 1)} y={y(latest.total) - 12} fontSize="12.5" fontWeight="700" fill="var(--ink)" textAnchor="end">
          {latest.total}
        </text>
        <text x={padL} y={H - 8} fontSize="10.5" fill="var(--muted)">{points[0]!.date.slice(0, 10)}</text>
        <text x={W - padR} y={H - 8} fontSize="10.5" fill="var(--muted)" textAnchor="end">today</text>
      </svg>

      {hover !== undefined && points[hover] && (
        <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(points[hover]!.total) / H) * 100}%` }}>
          <span className="v">{points[hover]!.total}</span>{' '}
          <span className="muted">on {points[hover]!.date.slice(0, 10)}</span>
        </div>
      )}

      <p className="small muted" style={{ marginTop: 10 }}>
        {scale.higherIsBetter ? 'Higher is better control.' : 'Higher means more severe symptoms.'}{' '}
        Latest {latest.total} — <span style={{ color: toneVars(band.tone).ink, fontWeight: 600 }}>{band.label}</span>.
      </p>
    </div>
  );
}

/** Per-item breakdown: which questions are driving the total. */
export function ItemBreakdown({
  items,
}: {
  items: Array<{ linkId: string; label: string; prompt?: string; value: number; min: number; max: number }>;
}): JSX.Element {
  return (
    <div className="items">
      {items.map((item) => {
        const frac = (item.value - item.min) / Math.max(1, item.max - item.min);
        const concern = frac <= 0.25 ? 'high' : frac <= 0.5 ? 'medium' : 'low';
        const tone: BandTone = concern === 'high' ? 'red' : concern === 'medium' ? 'amber' : 'green';
        return (
          <div key={item.linkId} className={`item ${concern}`}>
            <div className="item-head">
              <span className="item-label">{item.label}</span>
              <span className="muted small" style={{ textTransform: 'capitalize' }}>{concern}</span>
              <span className="item-score" style={{ background: toneVars(tone).bg, color: toneVars(tone).ink }}>
                {item.value} / {item.max}
              </span>
            </div>
            <div className="item-track">
              <div className="item-fill" style={{ width: `${Math.max(3, frac * 100)}%`, background: toneMark(tone) }} />
            </div>
            {item.prompt && <p className="small muted item-prompt">{item.prompt}</p>}
          </div>
        );
      })}
    </div>
  );
}

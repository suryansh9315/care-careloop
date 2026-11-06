import { useState } from 'react';

export interface TrendPoint {
  date: string;
  total: number;
}

export interface TrendBand {
  id: string;
  label: string;
  min: number;
  max: number;
}

/**
 * Score trend over time.
 *
 * A single series, so no legend box — the card title names it. Labels are
 * selective rather than one-per-point: the first, the last, and the extremes
 * carry a number, and everything else is available on hover. Labelling every
 * point turns the line into a wall of digits at exactly the density where the
 * shape is the thing you want to read.
 *
 * "Higher is better" differs by instrument (ACT vs PHQ-9), so the direction is
 * stated in words rather than left to the reader's assumption.
 */
export function Trend({
  points,
  min,
  max,
  higherIsBetter,
  bands,
}: {
  points: TrendPoint[];
  min: number;
  max: number;
  higherIsBetter: boolean;
  bands?: TrendBand[];
}): JSX.Element {
  const [hover, setHover] = useState<number>();

  if (points.length === 0) {
    return (
      <p className="small muted">
        No prior scores recorded. The trend fills in from the second check-in.
      </p>
    );
  }

  const W = 640;
  const H = 190;
  const padL = 34;
  const padR = 16;
  const padT = 22;
  const padB = 30;
  const span = Math.max(max - min, 1);

  const x = (i: number) =>
    points.length === 1 ? padL : padL + (i / (points.length - 1)) * (W - padL - padR);
  const y = (v: number) => H - padB - ((v - min) / span) * (H - padT - padB);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.total)}`).join(' ');
  const area =
    points.length > 1
      ? `${line} L${x(points.length - 1)},${H - padB} L${x(0)},${H - padB} Z`
      : '';

  const values = points.map((p) => p.total);
  const lowest = Math.min(...values);
  const highest = Math.max(...values);

  // Selective labels: endpoints and extremes only.
  const labelled = new Set<number>([0, points.length - 1]);
  labelled.add(values.indexOf(lowest));
  labelled.add(values.indexOf(highest));

  const ticks = [min, Math.round((min + max) / 2), max];
  const latest = points[points.length - 1];
  const previous = points[points.length - 2];
  const delta = latest && previous ? latest.total - previous.total : undefined;

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Score trend. ${points
          .map((p) => `${p.date.slice(0, 10)}: ${p.total}`)
          .join('. ')}`}
        onMouseLeave={() => setHover(undefined)}
      >
        {/* Band shading is recessive — context, never the subject. */}
        {bands?.map((band) => (
          <rect
            key={band.id}
            x={padL}
            y={y(Math.min(band.max, max))}
            width={W - padL - padR}
            height={Math.max(0, y(Math.max(band.min, min)) - y(Math.min(band.max, max)))}
            fill="var(--surface-2)"
            opacity={0.7}
          />
        ))}

        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={padL} x2={W - padR} y1={y(tick)} y2={y(tick)}
              stroke="var(--grid)" strokeWidth="1"
            />
            <text x={padL - 8} y={y(tick) + 4} fontSize="11" fill="var(--muted)" textAnchor="end">
              {tick}
            </text>
          </g>
        ))}

        {points.length > 1 && <path d={area} fill="var(--series-1)" opacity={0.08} />}
        {points.length > 1 && (
          <path d={line} fill="none" stroke="var(--series-1)" strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" />
        )}

        {points.map((p, i) => (
          <g key={`${p.date}-${i}`}>
            {/* Hit target deliberately larger than the mark. */}
            <rect
              x={x(i) - 18} y={padT - 14} width={36} height={H - padT - padB + 20}
              fill="transparent" onMouseEnter={() => setHover(i)}
            />
            <circle
              cx={x(i)} cy={y(p.total)} r={hover === i ? 6 : 4.5}
              fill="var(--series-1)" stroke="var(--surface)" strokeWidth="2"
            />
            {labelled.has(i) && hover === undefined && (
              // Endpoint labels anchor inward so they never overhang into the
              // axis gutter — a centred first label collides with the top tick.
              <text
                x={i === 0 ? x(i) + 7 : i === points.length - 1 ? x(i) - 7 : x(i)}
                y={y(p.total) - 12}
                fontSize="12"
                fontWeight="650"
                fill="var(--ink)"
                textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
              >
                {p.total}
              </text>
            )}
            {i === 0 || i === points.length - 1 ? (
              <text
                x={x(i)} y={H - 9} fontSize="10.5" fill="var(--muted)"
                textAnchor={i === 0 ? 'start' : 'end'}
              >
                {p.date.slice(0, 10)}
              </text>
            ) : null}
          </g>
        ))}
      </svg>

      {hover !== undefined && points[hover] && (
        <div
          className="chart-tip"
          style={{
            left: `${(x(hover) / W) * 100}%`,
            top: `${(y(points[hover]!.total) / H) * 100}%`,
          }}
        >
          <span className="v">{points[hover]!.total}</span>{' '}
          <span className="muted">on {points[hover]!.date.slice(0, 10)}</span>
        </div>
      )}

      <p className="small muted" style={{ marginTop: 10 }}>
        {higherIsBetter ? 'Higher is better control.' : 'Higher means more severe symptoms.'}
        {delta !== undefined && delta !== 0 && (
          <>
            {' '}Latest is {Math.abs(delta)} point{Math.abs(delta) === 1 ? '' : 's'}{' '}
            {delta > 0 ? 'up' : 'down'} on the previous check-in
            {higherIsBetter === delta > 0 ? ' — improving.' : ' — worsening.'}
          </>
        )}
      </p>
    </div>
  );
}

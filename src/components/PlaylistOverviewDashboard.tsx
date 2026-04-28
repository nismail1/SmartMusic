import { formatDuration, formatDurationHuman } from "../lib/format";
import { countsToChartSegments, type ChartSegment, type PlaylistAnalytics } from "../services/playlistAnalytics";

const DONUT_COLORS = ["#e08592", "#8b76b5", "#3d5a5f", "#6fa9a8", "#c9a46d"];

function buildConicGradient(segments: ChartSegment[]): string {
  let accPct = 0;
  const total = segments.reduce((s, seg) => s + seg.percent, 0) || 1;
  return segments
    .map((seg) => {
      const start = (accPct / total) * 100;
      accPct += seg.percent;
      const end = (accPct / total) * 100;
      return `${seg.color} ${start}% ${end}%`;
    })
    .join(", ");
}

function DonutChart({ segments, title }: { segments: ChartSegment[]; title: string }) {
  if (!segments.length) {
    return (
      <div className="playlist-overview-chart">
        <h4 className="playlist-overview-chart__title">{title}</h4>
        <p className="playlist-overview-chart__empty">No data yet</p>
      </div>
    );
  }

  return (
    <div className="playlist-overview-chart">
      <h4 className="playlist-overview-chart__title">{title}</h4>
      <div className="playlist-overview-chart__body">
        <div
          className="playlist-overview-donut"
          style={{
            background: `conic-gradient(${buildConicGradient(segments)})`
          }}
          role="img"
          aria-label={segments.map((s) => `${s.label} ${s.percent} percent`).join(", ")}
        />
        <ul className="playlist-overview-legend">
          {segments.map((s) => (
            <li key={`${title}-${s.label}`}>
              <span className="playlist-overview-legend__swatch" style={{ background: s.color }} />
              <span className="playlist-overview-legend__label">{s.label}</span>
              <span className="playlist-overview-legend__pct">{s.percent}%</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function PlaylistOverviewDashboard({
  analytics,
  trackCount
}: {
  analytics: PlaylistAnalytics;
  trackCount: number;
}) {
  const avgMs = trackCount > 0 ? Math.round(analytics.totalDurationMs / trackCount) : 0;

  const genreSegments = countsToChartSegments(analytics.genreComposition, 5, DONUT_COLORS);
  const decadeSegments = countsToChartSegments(analytics.decadeBreakdown, 5, DONUT_COLORS);

  const topFive = analytics.topArtists.slice(0, 5);

  return (
    <div className="playlist-overview-dash">
      <div className="playlist-overview-dash__metrics">
        <div className="playlist-stat-card">
          <span className="playlist-stat-card__label">Total duration</span>
          <span className="playlist-stat-card__value">{formatDurationHuman(analytics.totalDurationMs)}</span>
        </div>
        <div className="playlist-stat-card">
          <span className="playlist-stat-card__label">Total tracks</span>
          <span className="playlist-stat-card__value">{String(trackCount)}</span>
        </div>
        <div className="playlist-stat-card">
          <span className="playlist-stat-card__label">Avg track length</span>
          <span className="playlist-stat-card__value">{trackCount > 0 ? formatDuration(avgMs) : "—"}</span>
        </div>
      </div>

      <div className="playlist-overview-dash__charts">
        <DonutChart segments={genreSegments} title="Genre composition" />
        <DonutChart segments={decadeSegments} title="Decade breakdown" />

        <div className="playlist-overview-chart playlist-overview-chart--list">
          <h4 className="playlist-overview-chart__title">Top artists</h4>
          {topFive.length === 0 ? (
            <p className="playlist-overview-chart__empty">No artists yet</p>
          ) : (
            <ol className="playlist-top-artists">
              {topFive.map((row, idx) => (
                <li key={row.name}>
                  <span className="playlist-top-artists__rank">{idx + 1}</span>
                  <span className="playlist-top-artists__name">{row.name}</span>
                  <span className="playlist-top-artists__count">{row.count}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

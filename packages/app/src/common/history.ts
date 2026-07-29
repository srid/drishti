/**
 * App-side re-export of the pure metric-history domain.
 *
 * The ring maths live in `drishti-common/history` so the agent daemon can
 * import them without pulling the app. This module keeps the historical
 * import path for the parent + browser (`../common/history`).
 *
 * The durable ring itself lives in the agent daemon
 * (`~/.local/state/drishti/history.ring.json`) and survives parent deploys
 * and reconnects; the parent re-serves it to browsers.
 */

export {
  type HistoryWindowKey,
  type MetricKey,
  captureSample,
  CHART_MAX_POINTS,
  DEFAULT_HISTORY_WINDOW,
  downsample,
  HISTORY_RETENTION_MS,
  HISTORY_WINDOWS,
  isHistoryWindowKey,
  polylinePoints,
  pushSample,
  SPARKLINE_MAX_POINTS,
  WIDEST_HISTORY_WINDOW,
  windowMsFor,
  windowSlice,
} from "drishti-common/history";

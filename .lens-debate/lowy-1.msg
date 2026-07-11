fix(lens): single-source the metric vocabulary and system→% projection

Add MetricKey + metricPercents to drishti-common/metrics as the one home for
"which metrics exist" and "how a system snapshot projects to per-metric
percentages"; alerts.ts now aliases AlertId=MetricKey and MetricsFrame=
Record<MetricKey,number> and drops the duplicated metricsFrameOf (agent and
captureSample both call metricPercents), collapsing the parallel union and
projection into one.

Agreed by the lowy ⇄ hickey lens debate (finding lowy-1, raised by lowy). Not pushed or merged.

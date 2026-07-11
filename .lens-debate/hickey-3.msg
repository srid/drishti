fix(lens): collapse the one-field AlertItem to a bare AlertId[]

With label and pct gone, AlertItem was {id} — a record wrapping a single field.
The concept is a set of raised ids, so make the shape say so: Alerts becomes
{items: AlertId[]}, AlertsSchema an array of the id enum, applyHysteresis folds
over a Set<AlertId> (add/delete, rebuild via METRIC_IDS.filter), alertsEqual is
set-equality over the id arrays, and watchByEntry's selector collapses to
identity. Tests updated to the ["cpu"] shape.

Agreed by the lowy ⇄ hickey lens debate (finding hickey-3, raised by hickey). Not pushed or merged.

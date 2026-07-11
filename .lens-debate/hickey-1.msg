fix(lens): drop the unread pct field from the alert wire

pct was computed by the fold, validated by the schema, and shipped on every
frame, but no consumer reads it — alertsEqual itself ignores it. Remove pct from
AlertItem, AlertsSchema, and the fold's raised.set, and delete the pct-specific
test plus the pct fields from the remaining expectations. If a UI ever wants
"pct at raise," add it back when there is a reader.

Agreed by the lowy ⇄ hickey lens debate (finding hickey-1, raised by hickey). Not pushed or merged.

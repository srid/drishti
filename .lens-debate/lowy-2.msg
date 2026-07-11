fix(lens): move the alert label off the wire into the client

Presentation vocabulary was single-sourced in the agent's fold and shipped on
every AlertItem. Drop `label` from AlertItem, AlertsSchema, and the fold;
relocate the Title-Case LABELS map to the client (App.tsx) where rename/localize
belongs, rewrite the notification title as LABELS[id], and delete labelOf and
its impossible `?? id` fallback. The wire now carries only {id, pct}; AlertId
stays exported from drishti-common as a legitimate wire id.

Agreed by the lowy ⇄ hickey lens debate (finding lowy-2, raised by lowy). Not pushed or merged.

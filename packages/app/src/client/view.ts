/**
 * What the main pane shows: the aggregate fleet overview, or one host's
 * full htop body. Modelled as a sum so "which host" only exists in the
 * branch where a host is selected — there's no nullable host floating
 * alongside a separate "is fleet" flag to keep consistent.
 *
 * Lives in its own module (not `App.tsx`) so both the root `App`, which
 * owns the selected-view state, and the leaf `TabStrip`, which highlights
 * the active tab, depend *downward* on this shared type rather than the
 * leaf importing from the root.
 */
export type View = { kind: "fleet" } | { kind: "host"; host: string };

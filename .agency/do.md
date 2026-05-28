# /do config

## Check command
bun run typecheck

## Format command
just fmt

## Test command
bun test

## CI command
nix run github:juspay/justci -- run --host x86_64-linux=localhost

<!-- `--host x86_64-linux=localhost`: the configured `srid-justci` SSH alias
routes through a Tailscale proxy that returns "not owner of srid-justci",
so the linux lane runs against this machine until the proxy is restored.
Drop the override once `~/.config/justci/hosts.json` points linux somewhere
reachable. -->


## Documentation
Keep `README.md` in sync with user-facing changes.

<!-- Optional (add manually for the evidence step):
## PR evidence
-->

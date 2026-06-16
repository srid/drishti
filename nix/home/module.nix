{ config, lib, pkgs, ... }:
let
  cfg = config.services.drishti;

  # drishti's CLI surface (packages/app/src/server/main.ts): `--port` and
  # `--bind` flags plus positional `[host...]` args. The server binds
  # 127.0.0.1 (loopback) unless `--bind` overrides it; there is no `--tls`,
  # no `--verbose`. `--bind` is omitted when `cfg.bind` is null so drishti's
  # own loopback default applies.
  args = [
    (lib.getExe cfg.package)
    "--port"
    (toString cfg.port)
  ]
  ++ lib.optionals (cfg.bind != null) [ "--bind" cfg.bind ]
  ++ cfg.hosts;

  # Shared by both supervisors. systemd wants `[ "KEY=val" ]`; launchd wants
  # the attrset as a plist dict — converted at each call site. drishti's
  # monitor wrapper already bakes DRISHTI_DIST_DIR / DRISHTI_AGENT_DRVS_JSON
  # and prefixes openssh+nix onto PATH, so the only env we set here is the
  # optional hosts-file override and the optional WebSocket origin allowlist.
  envAttrs =
    lib.optionalAttrs (cfg.hostsFile != null)
      {
        DRISHTI_HOSTS_FILE = cfg.hostsFile;
      }
    // lib.optionalAttrs (cfg.allowedOrigins != [ ]) {
      DRISHTI_ALLOWED_ORIGINS = lib.concatStringsSep "," cfg.allowedOrigins;
    };
in
{
  options.services.drishti = {
    enable = lib.mkEnableOption "drishti remote host monitor";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The drishti package to use.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 7720;
      description = "Port the HTTP+WebSocket server listens on.";
    };

    bind = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "0.0.0.0";
      description = ''
        Interface the HTTP+WebSocket server binds to (the `--bind` flag).
        `null` uses drishti's default, `127.0.0.1` (loopback-only). The RPC
        surface is UNAUTHENTICATED, so set `0.0.0.0` (all interfaces) only
        behind a firewall or a trusted reverse proxy. For a proxied setup
        where the browser origin differs from the forwarded `Host` header,
        also set `allowedOrigins`.
      '';
    };

    allowedOrigins = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = lib.literalExpression ''[ "https://box.tailnet.ts.net" ]'';
      description = ''
        Extra browser origins allowed to open the WebSocket RPC surface (the
        `DRISHTI_ALLOWED_ORIGINS` env var — a Cross-Site WebSocket Hijacking
        defense). Same-origin requests are always allowed; list additional
        origins here when a reverse proxy (e.g. `tailscale serve`) serves the
        UI from a different origin than the `Host` drishti receives. Empty
        leaves only the same-origin rule.
      '';
    };

    hosts = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = lib.literalExpression ''[ "user@host-a" "host-b" ]'';
      description = ''
        Hosts to monitor, passed as positional arguments to the monitor.
        When empty, drishti seeds from its persisted hosts file (or
        `["localhost"]` on first run) and lets the admin surface manage the
        set at runtime.
      '';
    };

    hostsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = lib.literalExpression ''/home/alice/.local/state/drishti/hosts.json'';
      description = ''
        Override the file drishti reads/writes its host set to (the
        `DRISHTI_HOSTS_FILE` env var). `null` uses the default
        `$XDG_STATE_HOME/drishti/hosts.json`. The `path` type enforces an
        absolute path; systemd `%h` specifiers are not expanded here and
        would not work on launchd anyway.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.user.services = lib.mkIf pkgs.stdenv.hostPlatform.isLinux {
      drishti = {
        Unit = {
          Description = "drishti remote host monitor";
          After = [ "network.target" ];
        };
        Service = {
          ExecStart = toString args;
          Restart = "on-failure";
        } // lib.optionalAttrs (envAttrs != { }) {
          Environment = lib.mapAttrsToList (k: v: "${k}=${v}") envAttrs;
        };
        Install = {
          WantedBy = [ "default.target" ];
        };
      };
    };

    launchd.agents = lib.mkIf pkgs.stdenv.hostPlatform.isDarwin {
      drishti = {
        enable = true;
        config = {
          ProgramArguments = args;
          RunAtLoad = true;
          # Match systemd's `Restart = "on-failure"`: restart on non-zero exit
          # AND on crash signals (SIGSEGV, SIGILL, …). `SuccessfulExit` alone
          # only covers clean exits with non-zero status.
          KeepAlive = {
            SuccessfulExit = false;
            Crashed = true;
          };
          # launchd drops stdout/stderr by default; keep service crashes visible.
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/drishti.out.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/drishti.err.log";
        } // lib.optionalAttrs (envAttrs != { }) {
          EnvironmentVariables = envAttrs;
        };
      };
    };
  };
}

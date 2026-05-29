# Example configuration using drishti's home-manager module.
# Built in CI to ensure the module evaluates correctly.
# Linux: NixOS VM test that boots the config and verifies the systemd
# service actually starts and binds its port. Darwin: standalone
# home-manager eval-build that verifies the launchd path produces a valid
# plist (no runtime test — CI builders don't have a launchd session).
#
# Standalone evaluation note: the committed flake.lock pins `drishti` to the
# master tip, which only exports `homeManagerModules` once this PR lands
# upstream. Until then, evaluate/build this example against a local checkout
# that has the module, e.g.
#   nix flake check ./nix/home/example --override-input drishti .
# (CI does exactly this — see the inputs comment below.) After the PR merges,
# `nix flake update` in this directory makes standalone evaluation work.
{
  inputs = {
    # In CI, justci builds this with --override-input drishti pointing to the repo root.
    drishti.url = "github:srid/drishti";
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { nixpkgs, home-manager, drishti, ... }:
    let
      linuxSystem = "x86_64-linux";
      darwinSystem = "aarch64-darwin";
      linuxPkgs = nixpkgs.legacyPackages.${linuxSystem};
      darwinPkgs = nixpkgs.legacyPackages.${darwinSystem};

      # Pure home-manager module — used both inside the NixOS VM (Linux
      # systemd path) and standalone on Darwin (launchd path).
      drishtiHmModule = { pkgs, ... }: {
        imports = [ drishti.homeManagerModules.default ];
        services.drishti = {
          enable = true;
          package = drishti.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };
        home.stateVersion = "24.11";
        # The example pins its own nixpkgs-unstable + home-manager (drishti
        # exposes no nixpkgs flake input to follow), so their release tags can
        # drift apart. Silence the cosmetic mismatch warning.
        home.enableNixpkgsReleaseCheck = false;
      };

      darwinHome = home-manager.lib.homeManagerConfiguration {
        pkgs = darwinPkgs;
        modules = [
          drishtiHmModule
          {
            home.username = "alice";
            home.homeDirectory = "/Users/alice";
          }
        ];
      };

      # NixOS module: minimal system + home-manager with drishti enabled.
      nixosModule = {
        boot.loader.grub.devices = [ "nodev" ];
        fileSystems."/" = { device = "none"; fsType = "tmpfs"; };
        system.stateVersion = "24.11";

        users.users.alice = {
          isNormalUser = true;
          # Auto-login so the user session (and its systemd units) starts in the VM
          initialPassword = "pass";
        };

        home-manager.users.alice = drishtiHmModule;
      };
    in
    {
      # Linux: VM test boots the config and verifies drishti listens on its port.
      checks.${linuxSystem}.vm-test = linuxPkgs.testers.nixosTest {
        name = "drishti-service";

        nodes.machine = { ... }: {
          imports = [
            home-manager.nixosModules.home-manager
            nixosModule
          ];

          # Auto-login alice so her user session starts
          services.getty.autologinUser = "alice";
        };

        testScript = ''
          machine.wait_for_unit("multi-user.target")
          # Poll for alice's user session. wait_for_unit fails fast if the
          # unit is still inactive with no pending job — a race with
          # auto-login queueing user@1000. wait_until_succeeds retries.
          machine.wait_until_succeeds(
              "systemctl is-active user@1000.service",
              timeout=60,
          )

          # Use machinectl shell to get a proper user session with
          # DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR set.
          # Plain `su` doesn't set these, so systemctl --user fails.
          machine.succeed(
              "machinectl -q shell alice@.host /run/current-system/sw/bin/systemctl --user is-active drishti.service"
          )

          # Poll until drishti's HTTP listener binds — systemd reports
          # "active" before the port is open. 120s headroom for hosts
          # without KVM acceleration (qemu TCG fallback inflates the
          # bun/node startup substantially).
          machine.wait_until_succeeds(
              "curl --fail --silent http://127.0.0.1:7720/ > /dev/null",
              timeout=120,
          )
        '';
      };

      # Darwin: standalone home-manager activation package. Building this
      # exercises the launchd.agents.drishti path end-to-end (plist
      # generation, wait4path wrapping, etc.) without a live launchd session.
      checks.${darwinSystem} = {
        home-activation = darwinHome.activationPackage;

        launchd-config =
          let
            agentConfig = darwinHome.config.launchd.agents.drishti.config;
          in
          assert agentConfig.StandardOutPath == "/Users/alice/Library/Logs/drishti.out.log";
          assert agentConfig.StandardErrorPath == "/Users/alice/Library/Logs/drishti.err.log";
          # Restart on non-zero exit AND on crash signals — matches systemd's
          # `Restart = "on-failure"`. `SuccessfulExit` alone misses SIGSEGV etc.
          assert agentConfig.KeepAlive.SuccessfulExit == false;
          assert agentConfig.KeepAlive.Crashed == true;
          darwinPkgs.runCommand "drishti-launchd-config" { } ''
            touch $out
          '';
      };
    };
}

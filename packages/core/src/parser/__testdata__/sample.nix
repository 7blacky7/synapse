{ pkgs ? import <nixpkgs> {}
, lib ? pkgs.lib
, stdenv ? pkgs.stdenv
}:

let
  version = "1.0.0";
  maxRetries = 3;
  defaultModel = "claude-opus-4-6";

  agentConfig = {
    model = defaultModel;
    maxTokens = 4096;
    temperature = 0.7;
  };

  mkAgent = { name, config ? agentConfig, tools ? [ "search" "read" "write" ] }:
    stdenv.mkDerivation {
      pname = "synapse-agent-${name}";
      inherit version;

      src = ./.;

      buildInputs = with pkgs; [
        nodejs_20
        pnpm
      ];

      buildPhase = ''
        pnpm install --frozen-lockfile
        pnpm build
      '';

      installPhase = ''
        mkdir -p $out/bin
        cp -r dist/* $out/bin/
      '';

      meta = with lib; {
        description = "Synapse AI agent: ${name}";
        license = licenses.mit;
        platforms = platforms.linux;
      };
    };

  mkService = name: port: {
    systemd.services."synapse-${name}" = {
      description = "Synapse ${name} service";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" "postgresql.service" ];
      serviceConfig = {
        ExecStart = "${mkAgent { inherit name; }}/bin/server";
        Restart = "always";
        Environment = [
          "PORT=${toString port}"
          "NODE_ENV=production"
        ];
      };
    };
  };

in {
  inherit mkAgent mkService agentConfig;

  packages = {
    api = mkAgent { name = "api"; };
    worker = mkAgent { name = "worker"; };
  };

  devShell = pkgs.mkShell {
    buildInputs = with pkgs; [ nodejs_20 pnpm postgresql_16 ];
    shellHook = ''
      echo "Synapse dev environment"
      export DATABASE_URL="postgresql://localhost/synapse"
    '';
  };

  # TODO: add NixOS module
  # FIXME: pin nixpkgs version
}

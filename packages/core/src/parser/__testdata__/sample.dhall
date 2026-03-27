-- Synapse Configuration Schema

let Prelude = https://prelude.dhall-lang.org/v23.0.0/package.dhall
let Map = https://prelude.dhall-lang.org/v23.0.0/Map/Type.dhall

let Environment : Type =
      { name : Text
      , debug : Bool
      , logLevel : Text
      }

let DatabaseConfig : Type =
      { host : Text
      , port : Natural
      , name : Text
      , maxConnections : Natural
      }

let QdrantConfig : Type =
      { url : Text
      , collection : Text
      , dimensions : Natural
      }

let ServerConfig : Type =
      { port : Natural
      , host : Text
      , cors : List Text
      }

let AppConfig : Type =
      { server : ServerConfig
      , database : DatabaseConfig
      , qdrant : QdrantConfig
      , environment : Environment
      }

let defaultServer
    : ServerConfig
    = { port = 3000
      , host = "0.0.0.0"
      , cors = ["http://localhost:5173"]
      }

let defaultDatabase =
      { host = "localhost"
      , port = 5432
      , name = "synapse"
      , maxConnections = 10
      }

let defaultQdrant =
      { url = "http://localhost:6333"
      , collection = "synapse_code"
      , dimensions = 3072
      }

let mkConfig =
      \(env : Environment) ->
        { server = defaultServer
        , database = defaultDatabase
        , qdrant = defaultQdrant
        , environment = env
        }

let validate =
      \(config : AppConfig) ->
        assert : Natural/isZero config.server.port === False

let devConfig =
      mkConfig
        { name = "development"
        , debug = True
        , logLevel = "debug"
        }

let prodConfig =
      mkConfig
        { name = "production"
        , debug = False
        , logLevel = "warn"
        }

let localOverrides = ./local.dhall
let sharedUtils = ../shared/utils.dhall

let envPort = env:SYNAPSE_PORT
let envHost = env:SYNAPSE_HOST
let envDebug = env:DEBUG

-- TODO: add TLS configuration
-- FIXME: database password should use env var

in  devConfig

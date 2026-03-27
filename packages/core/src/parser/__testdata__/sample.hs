module Synapse.Agent
  ( Agent(..)
  , AgentConfig(..)
  , Status(..)
  , createAgent
  , process
  , getTools
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import Control.Monad.IO.Class (MonadIO, liftIO)

data Status = Active | Idle | Stopped | Error Text
  deriving (Show, Eq)

data AgentConfig = AgentConfig
  { configModel       :: Text
  , configMaxTokens   :: Int
  , configTemperature :: Double
  } deriving (Show, Eq)

data Agent = Agent
  { agentName   :: Text
  , agentConfig :: AgentConfig
  , agentStatus :: Status
  , agentTools  :: [Text]
  } deriving (Show)

class HasName a where
  getName :: a -> Text

instance HasName Agent where
  getName = agentName

type AgentMap = Map Text Agent

newtype AgentM a = AgentM { runAgentM :: IO a }

defaultConfig :: AgentConfig
defaultConfig = AgentConfig
  { configModel       = "claude-opus-4-6"
  , configMaxTokens   = 4096
  , configTemperature = 0.7
  }

maxRetries :: Int
maxRetries = 3

createAgent :: Text -> Maybe AgentConfig -> Agent
createAgent name mConfig = Agent
  { agentName   = name
  , agentConfig = maybe defaultConfig id mConfig
  , agentStatus = Idle
  , agentTools  = ["search", "read", "write"]
  }

process :: MonadIO m => Agent -> Text -> m (Either Text Text)
process agent message
  | T.null message = pure $ Left "Empty message"
  | otherwise = do
      let result = callModel message (agentConfig agent)
      pure $ Right result

getTools :: Agent -> [Text]
getTools = agentTools

callModel :: Text -> AgentConfig -> Text
callModel message _ = "Response to: " <> message

-- | Validate input message
validate :: Text -> Bool
validate = not . T.null . T.strip

-- TODO: implement async processing
-- FIXME: status not updated during processing

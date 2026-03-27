library(tidyverse)
library(httr2)
source("utils.R")

MAX_RETRIES <- 3
DEFAULT_MODEL <- "claude-opus-4-6"

#' Agent Configuration
#' @export
AgentConfig <- R6::R6Class("AgentConfig",
  public = list(
    model = NULL,
    max_tokens = NULL,
    temperature = NULL,

    initialize = function(model = DEFAULT_MODEL, max_tokens = 4096L, temperature = 0.7) {
      self$model <- model
      self$max_tokens <- max_tokens
      self$temperature <- temperature
    }
  )
)

#' Base Agent Class
#' @export
BaseAgent <- R6::R6Class("BaseAgent",
  public = list(
    name = NULL,
    config = NULL,

    initialize = function(name, config = NULL) {
      self$name <- name
      self$config <- config %||% AgentConfig$new()
      private$.status <- "idle"
    },

    process = function(message) {
      stop("Not implemented")
    },

    get_tools = function() {
      character(0)
    },

    get_status = function() {
      private$.status
    }
  ),

  private = list(
    .status = "idle",

    validate = function(input) {
      stopifnot(is.character(input), nchar(input) > 0)
      TRUE
    }
  )
)

#' Synapse Agent
#' @export
SynapseAgent <- R6::R6Class("SynapseAgent",
  inherit = BaseAgent,
  public = list(
    process = function(message) {
      private$validate(message)
      private$.status <- "active"
      result <- private$call_model(message)
      private$.status <- "idle"
      result
    },

    get_tools = function() {
      c("search", "read", "write")
    }
  ),

  private = list(
    call_model = function(message) {
      # TODO: implement actual API call
      paste("Response to:", message)
    }
  )
)

#' Create an agent
#' @param name Agent name
#' @param config Optional configuration
#' @return SynapseAgent instance
#' @export
create_agent <- function(name, config = NULL) {
  SynapseAgent$new(name, config)
}

load_agents <- function(directory) {
  files <- list.files(directory, pattern = "\\.json$", full.names = TRUE)
  lapply(files, function(f) {
    data <- jsonlite::fromJSON(f)
    create_agent(data$name)
  })
}

# FIXME: add error handling for API calls

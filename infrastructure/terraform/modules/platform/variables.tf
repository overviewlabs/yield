variable "name" { type = string }
variable "environment" {
  type = string
  validation {
    condition     = contains(["paper", "live"], var.environment)
    error_message = "environment must be paper or live."
  }
}
variable "vpc_cidr" { type = string }
variable "availability_zones" {
  type = list(string)
  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "At least two availability zones are required."
  }
}
variable "api_image" { type = string }
variable "worker_image" { type = string }
variable "certificate_arn" { type = string }
variable "public_api_url" {
  type = string
  validation {
    condition     = startswith(var.public_api_url, "https://")
    error_message = "public_api_url must use HTTPS."
  }
}
variable "connect_web_url" {
  type = string
  validation {
    condition     = startswith(var.connect_web_url, "https://")
    error_message = "connect_web_url must use HTTPS."
  }
}
variable "admin_web_url" {
  type = string
  validation {
    condition     = startswith(var.admin_web_url, "https://")
    error_message = "admin_web_url must use HTTPS."
  }
}
variable "cors_allowed_origins" {
  type = list(string)
  validation {
    condition     = length(var.cors_allowed_origins) > 0 && alltrue([for origin in var.cors_allowed_origins : startswith(origin, "https://")])
    error_message = "cors_allowed_origins must contain one or more HTTPS origins."
  }
}
variable "redis_auth_token" {
  type      = string
  sensitive = true
  validation {
    condition     = length(var.redis_auth_token) >= 32
    error_message = "Redis auth token must contain at least 32 characters."
  }
}
variable "alert_topic_arn" { type = string }
variable "apple_client_id" {
  type = string
  validation {
    condition     = length(trimspace(var.apple_client_id)) > 0
    error_message = "apple_client_id must be the approved Sign in with Apple service or bundle identifier."
  }
}
variable "apple_bundle_id" {
  type = string
  validation {
    condition     = length(trimspace(var.apple_bundle_id)) > 0
    error_message = "apple_bundle_id must be the registered App Store bundle identifier."
  }
}
variable "apple_app_id" {
  type = number
  validation {
    condition     = var.apple_app_id > 0 && floor(var.apple_app_id) == var.apple_app_id
    error_message = "apple_app_id must be a positive integer."
  }
}
variable "storekit_environments" {
  type = string
  validation {
    condition     = contains(["sandbox", "production", "sandbox,production", "production,sandbox"], var.storekit_environments)
    error_message = "storekit_environments must enable sandbox, production, or both without whitespace."
  }
}
variable "api_desired_count" {
  type    = number
  default = 2
}
variable "execution_desired_count" {
  type    = number
  default = 0
}
variable "agent_orchestrator_desired_count" {
  type    = number
  default = 1
}
variable "market_data_desired_count" {
  type    = number
  default = 0
}
variable "broker_sync_desired_count" {
  type        = number
  default     = 0
  description = "Locked at zero for the standard artifact, which deliberately contains no approved broker connector."
  validation {
    condition     = var.broker_sync_desired_count == 0
    error_message = "broker_sync_desired_count must remain zero until a reviewed connector composition root replaces the standard fail-closed artifact."
  }
}
variable "notification_desired_count" {
  type    = number
  default = 0
}
variable "apns_team_id" {
  type    = string
  default = ""
}
variable "apns_key_id" {
  type    = string
  default = ""
}
variable "apns_topic" {
  type    = string
  default = ""
}
variable "apns_environments" {
  type    = string
  default = ""
}
variable "market_data_provider_url" {
  type    = string
  default = ""
}
variable "market_data_provider_id" {
  type    = string
  default = ""
}
variable "approved_market_data_providers" {
  type    = string
  default = ""
}
variable "hermes_base_url" {
  type    = string
  default = "https://treasury-bot.whox.ai/v1"
  validation {
    condition     = var.hermes_base_url == "https://treasury-bot.whox.ai/v1"
    error_message = "hermes_base_url must equal the reviewed Metis Hermes API origin."
  }
}
variable "hermes_model" {
  type    = string
  default = "treasury-bot"
  validation {
    condition     = var.hermes_model == "treasury-bot"
    error_message = "hermes_model must equal the reviewed treasury-bot profile."
  }
}
variable "hermes_research_profile_tools_disabled" {
  description = "Operator attestation that the dedicated Hermes profile is stateless and has terminal, file, web, memory, skill, plugin, MCP, cron, and delegation tools disabled at the provider."
  type        = bool
  default     = false
}
variable "agent_scheduler_poll_ms" {
  type    = number
  default = 15000
  validation {
    condition     = var.agent_scheduler_poll_ms >= 1000 && var.agent_scheduler_poll_ms <= 300000 && floor(var.agent_scheduler_poll_ms) == var.agent_scheduler_poll_ms
    error_message = "agent_scheduler_poll_ms must be an integer from 1000 through 300000."
  }
}
variable "agent_scheduler_batch_size" {
  type    = number
  default = 250
  validation {
    condition     = var.agent_scheduler_batch_size >= 1 && var.agent_scheduler_batch_size <= 1000 && floor(var.agent_scheduler_batch_size) == var.agent_scheduler_batch_size
    error_message = "agent_scheduler_batch_size must be an integer from 1 through 1000."
  }
}
variable "agent_scheduler_max_outstanding_jobs" {
  type    = number
  default = 1000
  validation {
    condition     = var.agent_scheduler_max_outstanding_jobs >= 1 && var.agent_scheduler_max_outstanding_jobs <= 10000 && floor(var.agent_scheduler_max_outstanding_jobs) == var.agent_scheduler_max_outstanding_jobs
    error_message = "agent_scheduler_max_outstanding_jobs must be an integer from 1 through 10000."
  }
}
variable "agent_scheduler_lag_alert_seconds" {
  type    = number
  default = 300
  validation {
    condition     = var.agent_scheduler_lag_alert_seconds >= 30 && var.agent_scheduler_lag_alert_seconds <= 86400 && floor(var.agent_scheduler_lag_alert_seconds) == var.agent_scheduler_lag_alert_seconds
    error_message = "agent_scheduler_lag_alert_seconds must be an integer from 30 through 86400."
  }
}
variable "broker_snapshot_max_age_seconds" {
  type    = number
  default = 60
  validation {
    condition     = var.broker_snapshot_max_age_seconds >= 15 && var.broker_snapshot_max_age_seconds <= 300 && floor(var.broker_snapshot_max_age_seconds) == var.broker_snapshot_max_age_seconds
    error_message = "broker_snapshot_max_age_seconds must be an integer from 15 through 300."
  }
}
variable "broker_sync_interval_seconds" {
  type    = number
  default = 45
  validation {
    condition     = var.broker_sync_interval_seconds >= 10 && var.broker_sync_interval_seconds <= 295 && floor(var.broker_sync_interval_seconds) == var.broker_sync_interval_seconds
    error_message = "broker_sync_interval_seconds must be an integer from 10 through 295."
  }
}
variable "runtime_secrets_bootstrapped" {
  description = "Explicit operator attestation that distinct app/worker DB roles and all required secret versions have been provisioned and verified."
  type        = bool
  default     = false
}
variable "deletion_protection" {
  type    = bool
  default = true
}
variable "tags" {
  type    = map(string)
  default = {}
}

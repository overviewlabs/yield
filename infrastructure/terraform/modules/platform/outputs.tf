output "api_endpoint" { value = var.public_api_url }
output "database_endpoint" { value = aws_db_instance.postgres.address }
output "database_bootstrap_secret_arn" {
  description = "Administrative RDS secret for controlled role/bootstrap operations only; it is never injected into an ECS task."
  value       = aws_db_instance.postgres.master_user_secret[0].secret_arn
  sensitive   = true
}
output "redis_endpoint" { value = aws_elasticache_replication_group.redis.primary_endpoint_address }
output "durable_queue_backend" {
  description = "Durable worker jobs are leased from the environment-isolated PostgreSQL queue_jobs table."
  value       = "postgresql"
}
output "broker_token_secret_arn" { value = aws_secretsmanager_secret.broker_tokens.arn }
output "runtime_secret_arns" {
  description = "Secret containers that must receive verified values before runtime_secrets_bootstrapped is set true."
  value       = merge({ for name, secret in aws_secretsmanager_secret.runtime : name => secret.arn }, { "redis-url" = aws_secretsmanager_secret.redis_url.arn })
}
output "task_role_arns" { value = { for name, role in aws_iam_role.task : name => role.arn } }
output "task_execution_role_arns" { value = { for name, role in aws_iam_role.task_execution : name => role.arn } }

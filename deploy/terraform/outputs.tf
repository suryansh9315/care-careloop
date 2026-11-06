output "public_ip" {
  description = "Elastic IP — point the public_host DNS A record here."
  value       = aws_eip.bridge.public_ip
}

output "instance_id" {
  description = "Use with: aws ssm start-session --target <id>"
  value       = aws_instance.bridge.id
}

output "env_parameter_name" {
  description = "Populate this SecureString before the service will start."
  value       = aws_ssm_parameter.bridge_env.name
}

output "voice_webhook_url" {
  description = "Twilio voice webhook once DNS and TLS are live."
  value       = "https://${var.domain}/voice"
}

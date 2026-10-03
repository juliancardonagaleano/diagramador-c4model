# Datos: PostgreSQL, Redis, colas y almacenamiento de logs.

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db"
  subnet_ids = [aws_subnet.data_a.id, aws_subnet.data_b.id]
}

resource "aws_db_instance" "orders" {
  identifier             = "${local.name}-orders"
  engine                 = "postgres"
  engine_version         = "15.4"
  instance_class         = "db.r6g.large"
  allocated_storage      = 100
  multi_az               = true
  db_name                = "orders"
  username               = "orders"
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  kms_key_id             = aws_kms_key.main.arn
  storage_encrypted      = true
  publicly_accessible    = false
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name}-cache"
  subnet_ids = [aws_subnet.data_a.id, aws_subnet.data_b.id]
}

resource "aws_elasticache_replication_group" "sessions" {
  replication_group_id = "${local.name}-sessions"
  description          = "Sesiones de usuario"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "cache.t4g.small"
  subnet_group_name    = aws_elasticache_subnet_group.main.name
}

resource "aws_sqs_queue" "orders_dlq" {
  name                      = "${local.name}-orders-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "orders" {
  name              = "${local.name}-orders"
  kms_master_key_id = aws_kms_key.main.id

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.orders_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_s3_bucket" "logs" {
  bucket = "${local.name}-logs"
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}


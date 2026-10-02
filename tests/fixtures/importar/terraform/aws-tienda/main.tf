# Stack de producción de la tienda en línea: VPC con subredes públicas, de aplicaciones y de datos,
# clúster EKS, base de datos PostgreSQL en RDS, Redis, colas SQS y balanceador de aplicaciones.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
  }

  backend "s3" {
    bucket = "tienda-tfstate"
    key    = "produccion/terraform.tfstate"
    region = "eu-west-1"
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Environment = var.environment
      Project     = "tienda"
      Owner       = "plataforma"
    }
  }
}

variable "environment" {
  type        = string
  description = "Nombre del entorno"
  default     = "production"
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "db_password" {
  type      = string
  sensitive = true
}

locals {
  name = "tienda-${var.environment}"
  azs  = ["${var.region}a", "${var.region}b"]

  common_tags = {
    Stack = "tienda"
  }
}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

# ───────────── Red ─────────────

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true

  tags = merge(local.common_tags, { Name = "${local.name}-vpc" })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.20.0.0/24"
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = true

  tags = {
    Name                     = "${local.name}-public-a"
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.20.1.0/24"
  availability_zone       = local.azs[1]
  map_public_ip_on_launch = true

  tags = {
    Name                     = "${local.name}-public-b"
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.10.0/24"
  availability_zone = local.azs[0]

  tags = { Name = "${local.name}-apps-a" }
}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.11.0/24"
  availability_zone = local.azs[1]

  tags = { Name = "${local.name}-apps-b" }
}

resource "aws_subnet" "data_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.20.0/24"
  availability_zone = local.azs[0]

  tags = { Name = "${local.name}-data-a" }
}

resource "aws_subnet" "data_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.21.0/24"
  availability_zone = local.azs[1]

  tags = { Name = "${local.name}-data-b" }
}

# Subred de tránsito: ni etiquetas ni rutas dicen si es pública.
resource "aws_subnet" "transit" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.20.30.0/28"
}

resource "aws_eip" "nat" {
  domain = "vpc"
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public_a.id

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private_a" {
  subnet_id      = aws_subnet.private_a.id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "private_b" {
  subnet_id      = aws_subnet.private_b.id
  route_table_id = aws_route_table.private.id
}

# ───────────── Seguridad ─────────────

resource "aws_kms_key" "main" {
  description         = "Cifrado de los datos de la tienda"
  enable_key_rotation = true
}

resource "aws_security_group" "alb" {
  name   = "${local.name}-alb"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# El clúster acepta tráfico del balanceador (puertos de NodePort).
resource "aws_security_group_rule" "nodes_from_alb" {
  type                     = "ingress"
  from_port                = 30000
  to_port                  = 32767
  protocol                 = "tcp"
  security_group_id        = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
  source_security_group_id = aws_security_group.alb.id
}

resource "aws_security_group" "db" {
  name   = "${local.name}-db"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_eks_cluster.main.vpc_config[0].cluster_security_group_id]
  }
}

resource "aws_iam_role" "eks_cluster" {
  name = "${local.name}-eks-cluster"

  assume_role_policy = <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "eks.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
POLICY
}

resource "aws_iam_role_policy_attachment" "eks_cluster" {
  role       = aws_iam_role.eks_cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

# ───────────── Cómputo ─────────────

resource "aws_eks_cluster" "main" {
  name     = "${local.name}-eks"
  role_arn = aws_iam_role.eks_cluster.arn
  version  = "1.29"

  vpc_config {
    subnet_ids              = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    endpoint_private_access = true
    endpoint_public_access  = false
  }

  encryption_config {
    resources = ["secrets"]

    provider {
      key_arn = aws_kms_key.main.arn
    }
  }

  depends_on = [aws_iam_role_policy_attachment.eks_cluster]
}

resource "aws_eks_node_group" "apps" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "apps"
  node_role_arn   = aws_iam_role.eks_cluster.arn
  subnet_ids      = [aws_subnet.private_a.id, aws_subnet.private_b.id]
  instance_types  = ["m6i.large"]

  scaling_config {
    desired_size = 3
    min_size     = 2
    max_size     = 6
  }
}

resource "aws_cloudwatch_log_group" "eks" {
  name              = "/aws/eks/${local.name}/cluster"
  retention_in_days = 30
}

resource "aws_ecr_repository" "web" {
  name = "tienda/web"
}

# ───────────── Datos ─────────────

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

# ───────────── Entrada ─────────────

resource "aws_acm_certificate" "main" {
  domain_name       = "tienda.example.com"
  validation_method = "DNS"
}

resource "aws_lb" "public" {
  name               = "${local.name}-alb"
  load_balancer_type = "application"
  internal           = false
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]
  security_groups    = [aws_security_group.alb.id]

  access_logs {
    bucket  = aws_s3_bucket.logs.id
    enabled = true
  }
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name}-web"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = aws_acm_certificate.main.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_route53_zone" "main" {
  name = "tienda.example.com"
}

resource "aws_route53_record" "www" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "www"
  type    = "A"

  alias {
    name                   = aws_lb.public.dns_name
    zone_id                = aws_lb.public.zone_id
    evaluate_target_health = true
  }
}

# ───────────── Otros ─────────────

resource "aws_xray_group" "tienda" {
  group_name        = "tienda"
  filter_expression = "responsetime > 5"
}

module "observabilidad" {
  source = "./modules/observabilidad"

  cluster_name = aws_eks_cluster.main.name
}

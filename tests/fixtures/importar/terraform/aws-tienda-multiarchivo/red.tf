# Red: fuentes de datos, VPC, subredes y rutas.

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


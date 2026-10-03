# Cómputo: clúster EKS, registro de imágenes y logs.

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


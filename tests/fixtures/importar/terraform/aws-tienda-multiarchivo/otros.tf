# Otros: monitorización y un módulo local.

resource "aws_xray_group" "tienda" {
  group_name        = "tienda"
  filter_expression = "responsetime > 5"
}

module "observabilidad" {
  source = "./modules/observabilidad"

  cluster_name = aws_eks_cluster.main.name
}

#!/usr/bin/env bash
# Launch ONE EC2 host (Ubuntu 24.04, t3.large, ap-southeast-1) with Docker, and print its public IP.
# Run only after explicit approval. Idempotent on the key pair and security group names.
# Usage: AWS_PROFILE=proofdesk infra/ec2-up.sh
set -euo pipefail
REGION=${AWS_REGION:-ap-southeast-1}
TYPE=${INSTANCE_TYPE:-t3.large}
NAME=proofdesk-demo
KEY=proofdesk-key
SG=proofdesk-sg
mkdir -p ~/.ssh
if ! aws ec2 describe-key-pairs --key-names $KEY --region $REGION >/dev/null 2>&1; then
  aws ec2 create-key-pair --key-name $KEY --region $REGION --query KeyMaterial --output text > ~/.ssh/$KEY.pem
  chmod 600 ~/.ssh/$KEY.pem
fi
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --region $REGION --query 'Vpcs[0].VpcId' --output text)
SGID=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG Name=vpc-id,Values=$VPC --region $REGION --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -z "$SGID" ] || [ "$SGID" = "None" ]; then
  SGID=$(aws ec2 create-security-group --group-name $SG --description "ProofDesk demo" --vpc-id $VPC --region $REGION --query GroupId --output text)
  for p in 22 80 443; do aws ec2 authorize-security-group-ingress --group-id $SGID --protocol tcp --port $p --cidr 0.0.0.0/0 --region $REGION >/dev/null; done
fi
# Resolve the newest Canonical Ubuntu 24.04 image through EC2. The deployer role
# intentionally only needs EC2 permissions, so do not depend on ssm:GetParameter.
AMI=$(aws ec2 describe-images --region "$REGION" --owners 099720109477 \
  --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' \
            'Name=architecture,Values=x86_64' 'Name=state,Values=available' \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)
if [ -z "$AMI" ] || [ "$AMI" = "None" ]; then
  echo "Could not resolve a Canonical Ubuntu 24.04 AMI in $REGION" >&2
  exit 1
fi
cat > /tmp/proofdesk-userdata.sh <<'EOF'
#!/bin/bash
set -e
apt-get update && apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
usermod -aG docker ubuntu
EOF
ID=$(aws ec2 run-instances --image-id $AMI --instance-type $TYPE --key-name $KEY --security-group-ids $SGID --region $REGION \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":40,"VolumeType":"gp3"}}]' \
  --user-data file:///tmp/proofdesk-userdata.sh \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=project,Value=proofdesk}]" \
  --query 'Instances[0].InstanceId' --output text)
aws ec2 wait instance-running --instance-ids $ID --region $REGION
IP=$(aws ec2 describe-instances --instance-ids $ID --region $REGION --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "INSTANCE_ID=$ID"
echo "PUBLIC_IP=$IP"
echo "DOMAIN=$(echo $IP | tr . -).sslip.io"
echo "ssh -i ~/.ssh/$KEY.pem ubuntu@$IP"

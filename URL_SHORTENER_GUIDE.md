# URL Shortener Service on AWS - Complete Setup Guide

This guide provides step-by-step instructions to build a production-ready URL shortener service using AWS infrastructure, including VPC, DynamoDB, DAX caching, EC2, Application Load Balancer, API Gateway, and Route 53 DNS.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Step 1: VPC and Networking Setup](#step-1-vpc-and-networking-setup)
4. [Step 2: DynamoDB Table Setup](#step-2-dynamodb-table-setup)
5. [Step 3: DAX Cluster Configuration](#step-3-dax-cluster-configuration)
6. [Step 4: IAM Roles and Security Groups](#step-4-iam-roles-and-security-groups)
7. [Step 5: EC2 Instance Setup](#step-5-ec2-instance-setup)
8. [Step 6: Application Load Balancer Setup](#step-6-application-load-balancer-setup)
9. [Step 7: API Gateway Configuration](#step-7-api-gateway-configuration)
10. [Step 8: Route 53 DNS and SSL Certificate](#step-8-route-53-dns-and-ssl-certificate)
11. [Step 9: Testing the Service](#step-9-testing-the-service)
12. [Step 10: Monitoring and Auto-scaling](#step-10-monitoring-and-auto-scaling)
13. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

The URL shortener service consists of:

- **VPC**: Isolated network with public and private subnets across multiple availability zones
- **DynamoDB**: NoSQL database storing URL mappings with automatic TTL (365 days)
- **DAX**: In-memory cache for DynamoDB providing microsecond-level latency
- **EC2 Auto Scaling Group**: Node.js/Express backend servers
- **Application Load Balancer (ALB)**: Distributes traffic to EC2 instances
- **API Gateway**: REST API frontend with custom domain
- **Route 53**: DNS management with HTTPS support
- **ACM**: SSL/TLS certificates for HTTPS

**Data Flow:**
1. User sends request to `https://<YOUR_DOMAIN>/url` (custom domain via Route 53)
2. Route 53 routes to API Gateway
3. API Gateway routes to ALB
4. ALB distributes to EC2 instances
5. Node.js server reads from DAX cache (or DynamoDB on cache miss)
6. Response returned with short URL

---

## Prerequisites

- AWS Account with appropriate permissions
- AWS CLI v2 configured with a named profile: `<YOUR_PROFILE>`
- Region: `<YOUR_REGION>` (e.g., us-east-1)
- Domain registered in Route 53
- Node.js 16+ installed locally (for testing)
- git and basic bash knowledge

### Configure AWS CLI

```bash
aws configure --profile <YOUR_PROFILE>
# Enter your AWS Access Key ID
# Enter your AWS Secret Access Key
# Default region: <YOUR_REGION>
# Default output format: json
```

### Set Environment Variables

```bash
export AWS_PROFILE=<YOUR_PROFILE>
export AWS_REGION=<YOUR_REGION>
export DOMAIN_NAME="<YOUR_DOMAIN>"
export APP_NAME="url-shortener"
```

---

## Step 1: VPC and Networking Setup

Create an isolated network with public and private subnets across two availability zones.

```bash
#!/bin/bash
# Create VPC
VPC_ID=$(aws ec2 create-vpc \
    --cidr-block 10.0.0.0/16 \
    --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=${APP_NAME}-vpc}]" \
    --query 'Vpc.VpcId' \
    --output text)

echo "VPC Created: $VPC_ID"

# Enable DNS hostnames
aws ec2 modify-vpc-attribute \
    --vpc-id $VPC_ID \
    --enable-dns-hostnames

# Create Internet Gateway
IGW_ID=$(aws ec2 create-internet-gateway \
    --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Name,Value=${APP_NAME}-igw}]" \
    --query 'InternetGateway.InternetGatewayId' \
    --output text)

echo "Internet Gateway Created: $IGW_ID"

# Attach Internet Gateway to VPC
aws ec2 attach-internet-gateway \
    --vpc-id $VPC_ID \
    --internet-gateway-id $IGW_ID

# Create Public Subnets (for ALB)
PUBLIC_SUBNET_1=$(aws ec2 create-subnet \
    --vpc-id $VPC_ID \
    --cidr-block 10.0.1.0/24 \
    --availability-zone ${AWS_REGION}a \
    --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${APP_NAME}-public-subnet-1a}]" \
    --query 'Subnet.SubnetId' \
    --output text)

PUBLIC_SUBNET_2=$(aws ec2 create-subnet \
    --vpc-id $VPC_ID \
    --cidr-block 10.0.2.0/24 \
    --availability-zone ${AWS_REGION}b \
    --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${APP_NAME}-public-subnet-1b}]" \
    --query 'Subnet.SubnetId' \
    --output text)

echo "Public Subnets Created: $PUBLIC_SUBNET_1, $PUBLIC_SUBNET_2"

# Create Private Subnets (for EC2)
PRIVATE_SUBNET_1=$(aws ec2 create-subnet \
    --vpc-id $VPC_ID \
    --cidr-block 10.0.10.0/24 \
    --availability-zone ${AWS_REGION}a \
    --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${APP_NAME}-private-subnet-1a}]" \
    --query 'Subnet.SubnetId' \
    --output text)

PRIVATE_SUBNET_2=$(aws ec2 create-subnet \
    --vpc-id $VPC_ID \
    --cidr-block 10.0.11.0/24 \
    --availability-zone ${AWS_REGION}b \
    --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${APP_NAME}-private-subnet-1b}]" \
    --query 'Subnet.SubnetId' \
    --output text)

echo "Private Subnets Created: $PRIVATE_SUBNET_1, $PRIVATE_SUBNET_2"

# Create Route Table for Public Subnets
PUBLIC_RT=$(aws ec2 create-route-table \
    --vpc-id $VPC_ID \
    --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=${APP_NAME}-public-rt}]" \
    --query 'RouteTable.RouteTableId' \
    --output text)

# Add route to Internet Gateway
aws ec2 create-route \
    --route-table-id $PUBLIC_RT \
    --destination-cidr-block 0.0.0.0/0 \
    --gateway-id $IGW_ID

# Associate public subnets with public route table
aws ec2 associate-route-table \
    --subnet-id $PUBLIC_SUBNET_1 \
    --route-table-id $PUBLIC_RT

aws ec2 associate-route-table \
    --subnet-id $PUBLIC_SUBNET_2 \
    --route-table-id $PUBLIC_RT

# Create Route Table for Private Subnets (no internet route needed yet)
PRIVATE_RT=$(aws ec2 create-route-table \
    --vpc-id $VPC_ID \
    --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=${APP_NAME}-private-rt}]" \
    --query 'RouteTable.RouteTableId' \
    --output text)

# Associate private subnets with private route table
aws ec2 associate-route-table \
    --subnet-id $PRIVATE_SUBNET_1 \
    --route-table-id $PRIVATE_RT

aws ec2 associate-route-table \
    --subnet-id $PRIVATE_SUBNET_2 \
    --route-table-id $PRIVATE_RT

# Save IDs to file for later use
cat > vpc_ids.txt << EOF
VPC_ID=$VPC_ID
PUBLIC_SUBNET_1=$PUBLIC_SUBNET_1
PUBLIC_SUBNET_2=$PUBLIC_SUBNET_2
PRIVATE_SUBNET_1=$PRIVATE_SUBNET_1
PRIVATE_SUBNET_2=$PRIVATE_SUBNET_2
PUBLIC_RT=$PUBLIC_RT
PRIVATE_RT=$PRIVATE_RT
IGW_ID=$IGW_ID
EOF

echo "VPC Setup Complete. IDs saved to vpc_ids.txt"
```

Source the IDs for later use:
```bash
source vpc_ids.txt
```

---

## Step 2: DynamoDB Table Setup

Create a DynamoDB table with TTL for automatic URL expiration after 365 days.

```bash
#!/bin/bash
# Create DynamoDB Table
aws dynamodb create-table \
    --table-name URLShortenerMappings \
    --attribute-definitions \
        AttributeName=short_url,AttributeType=S \
        AttributeName=long_url,AttributeType=S \
    --key-schema \
        AttributeName=short_url,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --global-secondary-indexes \
        "IndexName=LongURLIndex,Keys=[{AttributeName=long_url,KeyType=HASH}],Projection={ProjectionType=ALL}" \
    --ttl-specification Enabled=true,AttributeName=ttl

echo "DynamoDB Table Created: URLShortenerMappings"
echo "Note: Wait 1-2 minutes for the table to become active"

# Monitor table creation
aws dynamodb wait table-exists --table-name URLShortenerMappings
echo "Table is now active"
```

---

## Step 3: DAX Cluster Configuration

Set up a DAX cluster for in-memory caching of DynamoDB data.

```bash
#!/bin/bash
source vpc_ids.txt

# Create Security Group for DAX
DAX_SG=$(aws ec2 create-security-group \
    --group-name ${APP_NAME}-dax-sg \
    --description "Security group for DAX cluster" \
    --vpc-id $VPC_ID \
    --query 'GroupId' \
    --output text)

echo "DAX Security Group Created: $DAX_SG"

# Allow traffic on DAX port (8111) from VPC
aws ec2 authorize-security-group-ingress \
    --group-id $DAX_SG \
    --protocol tcp \
    --port 8111 \
    --cidr 10.0.0.0/16

# Create DAX cluster (in private subnets)
DAX_CLUSTER=$(aws dax create-cluster \
    --cluster-name ${APP_NAME}-cache \
    --iam-role-arn arn:aws:iam::<YOUR_AWS_ACCOUNT_ID>:role/DAXServiceRole \
    --node-type cache.t3.small \
    --replication-factor 3 \
    --security-group-ids $DAX_SG \
    --subnet-group-name ${APP_NAME}-dax-subnet-group \
    --query 'Cluster.ClusterArn' \
    --output text)

echo "DAX Cluster Creation Started: $DAX_CLUSTER"
echo "Note: DAX cluster creation takes 5-10 minutes"

# Wait for cluster to be available
aws dax wait cluster-available --cluster-name ${APP_NAME}-cache 2>/dev/null || \
  echo "Waiting for DAX cluster... Check AWS console for progress"
```

### Create DAX Subnet Group

Before creating the cluster, create a subnet group:

```bash
#!/bin/bash
source vpc_ids.txt

aws dax create-subnet-group \
    --subnet-group-name ${APP_NAME}-dax-subnet-group \
    --description "Subnet group for DAX cluster" \
    --subnet-ids $PRIVATE_SUBNET_1 $PRIVATE_SUBNET_2
```

### Get DAX Endpoint

Once the cluster is active:

```bash
DAX_ENDPOINT=$(aws dax describe-clusters \
    --cluster-name ${APP_NAME}-cache \
    --query 'Clusters[0].ClusterDiscoveryEndpoint.Address' \
    --output text)

DAX_PORT=$(aws dax describe-clusters \
    --cluster-name ${APP_NAME}-cache \
    --query 'Clusters[0].ClusterDiscoveryEndpoint.Port' \
    --output text)

echo "DAX Endpoint: ${DAX_ENDPOINT}:${DAX_PORT}"
```

---

## Step 4: IAM Roles and Security Groups

Create IAM roles and security groups for EC2 instances and other services.

### Create EC2 IAM Role

```bash
#!/bin/bash

# Create trust policy
cat > ec2-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ec2.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Create IAM role
EC2_ROLE=$(aws iam create-role \
    --role-name ${APP_NAME}-ec2-role \
    --assume-role-policy-document file://ec2-trust-policy.json \
    --query 'Role.Arn' \
    --output text)

echo "EC2 IAM Role Created: $EC2_ROLE"

# Create inline policy for DynamoDB and DAX access
cat > ec2-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query",
        "dynamodb:Scan"
      ],
      "Resource": "arn:aws:dynamodb:<YOUR_REGION>:<YOUR_AWS_ACCOUNT_ID>:table/URLShortenerMappings*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "dax:*"
      ],
      "Resource": "*"
    }
  ]
}
EOF

aws iam put-role-policy \
    --role-name ${APP_NAME}-ec2-role \
    --policy-name ${APP_NAME}-dynamodb-policy \
    --policy-document file://ec2-policy.json

# Create instance profile
aws iam create-instance-profile \
    --instance-profile-name ${APP_NAME}-ec2-profile

aws iam add-role-to-instance-profile \
    --instance-profile-name ${APP_NAME}-ec2-profile \
    --role-name ${APP_NAME}-ec2-role

echo "EC2 IAM Policy and Instance Profile Created"
```

### Create Security Groups

```bash
#!/bin/bash
source vpc_ids.txt

# Create Security Group for ALB
ALB_SG=$(aws ec2 create-security-group \
    --group-name ${APP_NAME}-alb-sg \
    --description "Security group for ALB" \
    --vpc-id $VPC_ID \
    --query 'GroupId' \
    --output text)

echo "ALB Security Group Created: $ALB_SG"

# Allow HTTP and HTTPS traffic
aws ec2 authorize-security-group-ingress \
    --group-id $ALB_SG \
    --protocol tcp \
    --port 80 \
    --cidr 0.0.0.0/0

aws ec2 authorize-security-group-ingress \
    --group-id $ALB_SG \
    --protocol tcp \
    --port 443 \
    --cidr 0.0.0.0/0

# Create Security Group for EC2
EC2_SG=$(aws ec2 create-security-group \
    --group-name ${APP_NAME}-ec2-sg \
    --description "Security group for EC2 instances" \
    --vpc-id $VPC_ID \
    --query 'GroupId' \
    --output text)

echo "EC2 Security Group Created: $EC2_SG"

# Allow traffic from ALB to EC2 on port 3000
aws ec2 authorize-security-group-ingress \
    --group-id $EC2_SG \
    --protocol tcp \
    --port 3000 \
    --source-security-group-id $ALB_SG

# Allow traffic from EC2 to DAX
aws ec2 authorize-security-group-ingress \
    --group-id $DAX_SG \
    --protocol tcp \
    --port 8111 \
    --source-security-group-id $EC2_SG

# Save IDs
cat >> vpc_ids.txt << EOF
ALB_SG=$ALB_SG
EC2_SG=$EC2_SG
EOF
```

---

## Step 5: EC2 Instance Setup

Create EC2 instances with the application code.

### Create Launch Template

```bash
#!/bin/bash
source vpc_ids.txt

# Create user data script for EC2
cat > user-data.sh << 'USERDATA'
#!/bin/bash
# Update system
yum update -y

# Install Node.js
curl -sL https://rpm.nodesource.com/setup_16.x | bash -
yum install -y nodejs git

# Create application directory
mkdir -p /opt/url-shortener
cd /opt/url-shortener

# Clone your application repository
git clone https://github.com/<YOUR_GITHUB_USER>/url-shortener.git
cd url-shortener

# Install and build React frontend
cd ui
npm install
npm run build
npm install -g serve
serve -s build &
cd ..

# Install server dependencies
cd server
npm install

# Start the application with DAX endpoint
export DAX_ENDPOINT="<DAX_ENDPOINT>:<DAX_PORT>"
DAX_ENDPOINT=$DAX_ENDPOINT node server.js &

cd ..
USERDATA

# Base64 encode user data
USERDATA_B64=$(base64 < user-data.sh)

# Create launch template
LAUNCH_TEMPLATE=$(aws ec2 create-launch-template \
    --launch-template-name ${APP_NAME}-template \
    --version-description "Initial version" \
    --launch-template-data "{
        \"ImageId\": \"ami-0c02fb55b74b6a2dd\",
        \"InstanceType\": \"t3.micro\",
        \"IamInstanceProfile\": {
            \"Name\": \"${APP_NAME}-ec2-profile\"
        },
        \"SecurityGroupIds\": [\"$EC2_SG\"],
        \"UserData\": \"$USERDATA_B64\",
        \"TagSpecifications\": [
            {
                \"ResourceType\": \"instance\",
                \"Tags\": [
                    {
                        \"Key\": \"Name\",
                        \"Value\": \"${APP_NAME}-instance\"
                    }
                ]
            }
        ]
    }" \
    --query 'LaunchTemplate.LaunchTemplateId' \
    --output text)

echo "Launch Template Created: $LAUNCH_TEMPLATE"
```

### Create Auto Scaling Group

```bash
#!/bin/bash
source vpc_ids.txt

# Create Auto Scaling Group
aws autoscaling create-auto-scaling-group \
    --auto-scaling-group-name ${APP_NAME}-asg \
    --launch-template LaunchTemplateId=${LAUNCH_TEMPLATE},Version=\$Latest \
    --min-size 2 \
    --desired-capacity 2 \
    --max-size 4 \
    --vpc-zone-identifier "$PRIVATE_SUBNET_1,$PRIVATE_SUBNET_2"

echo "Auto Scaling Group Created: ${APP_NAME}-asg"
```

---

## Step 6: Application Load Balancer Setup

Create and configure the ALB.

```bash
#!/bin/bash
source vpc_ids.txt

# Create ALB
ALB=$(aws elbv2 create-load-balancer \
    --name ${APP_NAME}-alb \
    --subnets $PUBLIC_SUBNET_1 $PUBLIC_SUBNET_2 \
    --security-groups $ALB_SG \
    --scheme internet-facing \
    --type application \
    --ip-address-type ipv4 \
    --query 'LoadBalancers[0].LoadBalancerArn' \
    --output text)

ALB_DNS=$(aws elbv2 describe-load-balancers \
    --load-balancer-arns $ALB \
    --query 'LoadBalancers[0].DNSName' \
    --output text)

echo "ALB Created: $ALB"
echo "ALB DNS: $ALB_DNS"

# Create Target Groups
CREATE_TG=$(aws elbv2 create-target-group \
    --name ${APP_NAME}-create-tg \
    --protocol HTTP \
    --port 3000 \
    --vpc-id $VPC_ID \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text)

RETRIEVE_TG=$(aws elbv2 create-target-group \
    --name ${APP_NAME}-retrieve-tg \
    --protocol HTTP \
    --port 3000 \
    --vpc-id $VPC_ID \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text)

echo "Target Groups Created: $CREATE_TG, $RETRIEVE_TG"

# Attach ASG to target groups
aws autoscaling attach-load-balancer-target-groups \
    --auto-scaling-group-name ${APP_NAME}-asg \
    --target-group-arns $CREATE_TG $RETRIEVE_TG

# Create Listener
aws elbv2 create-listener \
    --load-balancer-arn $ALB \
    --protocol HTTP \
    --port 80 \
    --default-actions Type=forward,TargetGroupArn=$CREATE_TG

# Create listener rules for routing
# Rule 1: POST /url -> CREATE_TG
aws elbv2 create-rule \
    --listener-arn $(aws elbv2 describe-listeners \
        --load-balancer-arn $ALB \
        --query 'Listeners[0].ListenerArn' \
        --output text) \
    --priority 1 \
    --conditions Field=path-pattern,Values="/url" Field=http-request-method,HttpRequestMethodConfig={Values=[POST]} \
    --actions Type=forward,TargetGroupArn=$CREATE_TG

# Rule 2: GET /url/* -> RETRIEVE_TG
aws elbv2 create-rule \
    --listener-arn $(aws elbv2 describe-listeners \
        --load-balancer-arn $ALB \
        --query 'Listeners[0].ListenerArn' \
        --output text) \
    --priority 2 \
    --conditions Field=path-pattern,Values="/url/*" Field=http-request-method,HttpRequestMethodConfig={Values=[GET]} \
    --actions Type=forward,TargetGroupArn=$RETRIEVE_TG

# Save ALB info
cat >> vpc_ids.txt << EOF
ALB=$ALB
ALB_DNS=$ALB_DNS
CREATE_TG=$CREATE_TG
RETRIEVE_TG=$RETRIEVE_TG
EOF

echo "ALB Setup Complete"
```

---

## Step 7: API Gateway Configuration

Set up API Gateway to route traffic to the ALB.

```bash
#!/bin/bash
source vpc_ids.txt

# Create REST API
API_ID=$(aws apigateway create-rest-api \
    --name "${APP_NAME}API" \
    --description "API for URL Shortener Service" \
    --endpoint-configuration types=REGIONAL \
    --query 'id' \
    --output text)

echo "API Gateway Created: $API_ID"

# Get root resource
ROOT_ID=$(aws apigateway get-resources \
    --rest-api-id $API_ID \
    --query 'items[0].id' \
    --output text)

# Create /url resource
URL_RESOURCE=$(aws apigateway create-resource \
    --rest-api-id $API_ID \
    --parent-id $ROOT_ID \
    --path-part url \
    --query 'id' \
    --output text)

echo "URL Resource Created: $URL_RESOURCE"

# Create /{proxy+} resource under /url for path parameters
PROXY_RESOURCE=$(aws apigateway create-resource \
    --rest-api-id $API_ID \
    --parent-id $URL_RESOURCE \
    --path-part '{proxy+}' \
    --query 'id' \
    --output text)

echo "Proxy Resource Created: $PROXY_RESOURCE"

# Create POST method on /url resource (for JSON body)
aws apigateway put-method \
    --rest-api-id $API_ID \
    --resource-id $URL_RESOURCE \
    --http-method POST \
    --authorization-type NONE

# Create HTTP_PROXY integration for POST /url
aws apigateway put-integration \
    --rest-api-id $API_ID \
    --resource-id $URL_RESOURCE \
    --http-method POST \
    --type HTTP_PROXY \
    --integration-http-method POST \
    --uri "http://${ALB_DNS}/url"

# Create proxy method on /{proxy+}
aws apigateway put-method \
    --rest-api-id $API_ID \
    --resource-id $PROXY_RESOURCE \
    --http-method ANY \
    --authorization-type NONE \
    --request-parameters "method.request.path.proxy=true"

# Create HTTP_PROXY integration for /{proxy+}
aws apigateway put-integration \
    --rest-api-id $API_ID \
    --resource-id $PROXY_RESOURCE \
    --http-method ANY \
    --type HTTP_PROXY \
    --integration-http-method ANY \
    --uri "http://${ALB_DNS}/{proxy}" \
    --request-parameters "integration.request.path.proxy=method.request.path.proxy"

# Create deployment
DEPLOYMENT=$(aws apigateway create-deployment \
    --rest-api-id $API_ID \
    --stage-name prod \
    --stage-description "Production stage" \
    --query 'id' \
    --output text)

echo "API Deployed: $DEPLOYMENT"

# Get API endpoint
API_ENDPOINT="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/prod"
echo "API Gateway Endpoint: $API_ENDPOINT"

# Save API info
cat >> vpc_ids.txt << EOF
API_ID=$API_ID
API_ENDPOINT=$API_ENDPOINT
EOF
```

---

## Step 8: Route 53 DNS and SSL Certificate

Set up custom domain with HTTPS.

### Request SSL Certificate

```bash
#!/bin/bash

# Request ACM certificate for your domain
CERT_ARN=$(aws acm request-certificate \
    --domain-name $DOMAIN_NAME \
    --validation-method DNS \
    --query 'CertificateArn' \
    --output text)

echo "Certificate Requested: $CERT_ARN"
echo "Certificate Status: Pending validation"
echo ""
echo "You must validate the certificate via DNS before proceeding."
echo "Check your AWS Certificate Manager console for validation instructions."
```

### Validate Certificate (Manual Step)

1. Go to AWS Certificate Manager console
2. Find your certificate for `<YOUR_DOMAIN>`
3. Click on the certificate
4. Look for DNS validation records
5. Add the CNAME records to your Route 53 hosted zone
6. Wait for validation to complete (typically 5-15 minutes)

### Create Route 53 Record

```bash
#!/bin/bash
source vpc_ids.txt

# Get hosted zone ID
ZONE_ID=$(aws route53 list-hosted-zones \
    --query "HostedZones[?Name=='${DOMAIN_NAME}.'].Id" \
    --output text | cut -d'/' -f3)

echo "Hosted Zone ID: $ZONE_ID"

# Create CNAME record pointing to ALB
cat > route53-record.json << EOF
{
  "Changes": [
    {
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "${DOMAIN_NAME}",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z35SXDOTRQ7X7K",
          "DNSName": "${ALB_DNS}",
          "EvaluateTargetHealth": true
        }
      }
    }
  ]
}
EOF

aws route53 change-resource-record-sets \
    --hosted-zone-id $ZONE_ID \
    --change-batch file://route53-record.json

echo "Route 53 Record Created"
echo "DNS may take a few minutes to propagate"

# Save info
cat >> vpc_ids.txt << EOF
ZONE_ID=$ZONE_ID
CERT_ARN=$CERT_ARN
EOF
```

### Add HTTPS Listener to ALB

Once the certificate is validated:

```bash
#!/bin/bash
source vpc_ids.txt

# Get certificate ARN from ACM
CERT_ARN=$(aws acm list-certificates \
    --query "CertificateSummaryList[?DomainName=='${DOMAIN_NAME}'].CertificateArn" \
    --output text)

echo "Using Certificate: $CERT_ARN"

# Create HTTPS listener
aws elbv2 create-listener \
    --load-balancer-arn $ALB \
    --protocol HTTPS \
    --port 443 \
    --certificates CertificateArn=$CERT_ARN \
    --default-actions Type=forward,TargetGroupArn=$CREATE_TG

# Redirect HTTP to HTTPS
aws elbv2 modify-listener \
    --listener-arn $(aws elbv2 describe-listeners \
        --load-balancer-arn $ALB \
        --query "Listeners[?Port==\`80\`].ListenerArn" \
        --output text) \
    --default-actions Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}

echo "HTTPS Listener Created and HTTP redirect configured"
```

---

## Step 9: Testing the Service

### Test URL Creation (JSON Body)

```bash
curl -X POST https://<YOUR_DOMAIN>/url \
  -H "Content-Type: application/json" \
  -d '{"longUrl":"https://example.com/very/long/url"}' | jq .
```

Expected response:
```json
{
  "shortUrl": "d4c9d9027326271a",
  "longUrl": "https://example.com/very/long/url",
  "ttl": 1794175450
}
```

### Test URL Creation (URL Parameter - Legacy)

```bash
curl -X POST https://<YOUR_DOMAIN>/url/https://example.com/very/long/url
```

### Test URL Retrieval

```bash
curl -L https://<YOUR_DOMAIN>/d4c9d9027326271a
```

This should redirect to the original long URL.

### Test ALB Directly (if needed for debugging)

```bash
ALB_DNS=$(aws elbv2 describe-load-balancers \
    --query "LoadBalancers[?LoadBalancerName=='${APP_NAME}-alb'].DNSName" \
    --output text)

curl -X POST http://${ALB_DNS}/url \
  -H "Content-Type: application/json" \
  -d '{"longUrl":"https://example.com"}'
```

---

## Step 10: Monitoring and Auto-scaling

### Set up CloudWatch Alarms

```bash
#!/bin/bash
source vpc_ids.txt

# Create alarm for high CPU
aws cloudwatch put-metric-alarm \
    --alarm-name ${APP_NAME}-high-cpu \
    --alarm-description "Alert when CPU exceeds 70%" \
    --metric-name CPUUtilization \
    --namespace AWS/EC2 \
    --statistic Average \
    --period 300 \
    --threshold 70 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 2

# Create alarm for DynamoDB throttling
aws cloudwatch put-metric-alarm \
    --alarm-name ${APP_NAME}-dynamodb-throttle \
    --alarm-description "Alert on DynamoDB throttling" \
    --metric-name ConsumedWriteCapacityUnits \
    --namespace AWS/DynamoDB \
    --statistic Sum \
    --period 60 \
    --threshold 100 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 1

echo "CloudWatch Alarms Created"
```

### Set up Auto-scaling Policies

```bash
#!/bin/bash

# Target tracking scaling policy (CPU)
aws autoscaling put-scaling-policy \
    --auto-scaling-group-name ${APP_NAME}-asg \
    --policy-name ${APP_NAME}-cpu-scaling \
    --policy-type TargetTrackingScaling \
    --target-tracking-configuration "{
        \"TargetValue\": 70.0,
        \"PredefinedMetricSpecification\": {
            \"PredefinedMetricType\": \"ASGAverageCPUUtilization\"
        },
        \"ScaleOutCooldown\": 300,
        \"ScaleInCooldown\": 300
    }"

echo "Auto-scaling Policy Created"
```

---

## Troubleshooting

### Issue: "Missing Authentication Token" from API Gateway

**Cause:** The endpoint doesn't have proper method integration configured.

**Solution:** Ensure the API Gateway method (POST /url for JSON body) has both:
1. A PUT METHOD configured
2. An HTTP_PROXY integration pointing to ALB

```bash
# Verify method exists
aws apigateway get-method \
    --rest-api-id $API_ID \
    --resource-id $URL_RESOURCE \
    --http-method POST

# Verify integration exists
aws apigateway get-integration \
    --rest-api-id $API_ID \
    --resource-id $URL_RESOURCE \
    --http-method POST

# If missing, create them (see Step 7)
```

### Issue: Getting HTML instead of JSON from static files

**Cause:** Request is hitting the Express catch-all route (`app.get('*')`) which serves `index.html`.

**Solution:** Ensure requests are hitting the ALB directly, not through API Gateway for static assets. The current setup routes everything through API Gateway to ALB, so the Express server handles routing. Make sure the React build is in the correct location and the server is configured to serve static files.

### Issue: DAX cluster never becomes available

**Cause:** Insufficient permissions, VPC configuration, or network issues.

**Solution:**
```bash
# Check DAX cluster status
aws dax describe-clusters --cluster-name ${APP_NAME}-cache

# Check security group rules
aws ec2 describe-security-groups --group-ids $DAX_SG
```

### Issue: EC2 instances not launching

**Cause:** IAM role not properly attached, incorrect AMI ID, or user data script errors.

**Solution:**
```bash
# Check Auto Scaling Group
aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names ${APP_NAME}-asg

# Check instance details if instances exist
aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=${APP_NAME}-instance"
```

### Issue: Can't connect to DAX from EC2

**Cause:** Security group rules or network issues.

**Solution:**
```bash
# SSH into an EC2 instance and test connectivity
ssh -i <your-key>.pem ec2-user@<instance-ip>

# Test DAX connectivity
telnet <DAX_ENDPOINT> <DAX_PORT>

# Check DAX logs
# Or use: ncat -zv <DAX_ENDPOINT> <DAX_PORT>
```

---

## Cost Optimization Tips

1. **Use Reserved Instances** for predictable workloads
2. **Enable DynamoDB auto-scaling** or use provisioned capacity for consistent traffic
3. **Monitor DAX costs** - may not be needed for low-traffic services
4. **Use lifecycle policies** for old data in DynamoDB
5. **Set appropriate CloudWatch log retention** (default is unlimited)
6. **Use VPC endpoints** for DynamoDB to avoid NAT gateway costs

---

## Production Checklist

- [ ] SSL certificate deployed and HTTPS working
- [ ] Route 53 DNS pointing to ALB
- [ ] Auto Scaling policies configured
- [ ] CloudWatch alarms set up
- [ ] DynamoDB backup enabled
- [ ] VPC Flow Logs enabled for troubleshooting
- [ ] IAM roles follow least privilege principle
- [ ] Security groups restrict traffic appropriately
- [ ] Load testing completed
- [ ] Disaster recovery plan documented
- [ ] Monitoring dashboard created in CloudWatch
- [ ] Log aggregation set up (CloudWatch Logs)

---

## Summary

This guide covers the complete setup of a production-ready URL shortener on AWS with:

- **High Availability:** ALB with ASG across multiple AZs
- **Performance:** DAX caching for microsecond latency
- **Scalability:** Auto-scaling based on demand
- **Durability:** DynamoDB with automatic backups
- **Security:** SSL/TLS, security groups, IAM roles
- **Monitoring:** CloudWatch alarms and metrics

The architecture can handle millions of URL shortened and retrieved per day with minimal operational overhead.

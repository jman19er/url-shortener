For simplicity, the frontend, and both the read and write path are hosted on the same ec2 instances.

For a production setup, we would:
Separate read service (GET /url/:shortUrl) — can scale for high read traffic
Separate write service (POST /url) — can scale for write operations
Serve the frontend on CDN — deploy static files to S3 + CloudFront


# AWS URL Shortener Service - Complete Infrastructure Setup Guide

Based on your system design with the following specifications:
- SHA-256 hashing for short URL generation (first 30 characters)
- TTL of 365 days for short URLs
- DynamoDB with DAX caching for performance
- Separate services for URL creation and retrieval
- Load balancer for high availability

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [VPC and Networking Setup](#vpc-and-networking-setup)
3. [DynamoDB Table Setup](#dynamodb-table-setup)
4. [DAX Cluster Configuration](#dax-cluster-configuration)
5. [EC2 Instance Setup](#ec2-instance-setup)
6. [Application Load Balancer Setup](#application-load-balancer-setup)
7. [API Gateway Configuration](#api-gateway-configuration)
8. [Route 53 DNS Configuration](#route-53-dns-configuration)
9. [Application Code Templates](#application-code-templates)
10. [Monitoring and Auto-scaling](#monitoring-and-auto-scaling)

## Prerequisites

```bash
# Install AWS CLI if not already installed
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install

# Configure AWS CLI
aws configure
# Enter your AWS Access Key ID, Secret Access Key, Region (e.g., us-east-1), and output format
```

## 1. VPC and Networking Setup

```bash
# Create VPC for the URL shortener service
VPC_ID=$(aws ec2 create-vpc \
    --cidr-block 10.0.0.0/16 \
    --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=url-shortener-vpc}]' \
    --query 'Vpc.VpcId' \
    --output text)

echo "VPC Created: $VPC_ID"

# Enable DNS hostnames
aws ec2 modify-vpc-attribute \
    --vpc-id $VPC_ID \
    --enable-dns-hostnames

# Create Internet Gateway
IGW_ID=$(aws ec2 create-internet-gateway \
    --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=url-shortener-igw}]' \
    --query 'InternetGateway.InternetGatewayId' \
    --output text)

# Attach Internet Gateway to VPC
aws ec2 attach-internet-gateway \
    --internet-gateway-id $IGW_ID \
    --vpc-id $VPC_ID

# Create Public Subnets (for ALB and NAT Gateways)
PUBLIC_SUBNET_1=$(aws ec2 create-subnet \
    --vpc-id $VPC_ID \
    --cidr-block 10.0.1.0/24 \
    --availability-zone us-east-1a \
    --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=url-shortener-public-1a}]' \
    --query 'Subnet.SubnetId' \
    --output text)

PUBLIC_SUBNET_2=$(aws ec2 create-subnet \
    --vpc-id $VPC_ID \
    --cidr-block 10.0.2.0/24 \
    --availability-zone us-east-1b \
    --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=url-shortener-public-1b}]' \
    --query 'Subnet.SubnetId' \
    --output text)

# Create Private Subnets (for EC2 instances)
PRIVATE_SUBNET_1=$(aws ec2 create-subnet \
    --vpc-id $VPC_ID \
    --cidr-block 10.0.11.0/24 \
    --availability-zone us-east-1a \
    --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=url-shortener-private-1a}]' \
    --query 'Subnet.SubnetId' \
    --output text)

PRIVATE_SUBNET_2=$(aws ec2 create-subnet \
    --vpc-id $VPC_ID \
    --cidr-block 10.0.12.0/24 \
    --availability-zone us-east-1b \
    --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=url-shortener-private-1b}]' \
    --query 'Subnet.SubnetId' \
    --output text)

# Create Route Table for Public Subnets
PUBLIC_RT_ID=$(aws ec2 create-route-table \
    --vpc-id $VPC_ID \
    --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=url-shortener-public-rt}]' \
    --query 'RouteTable.RouteTableId' \
    --output text)

# Add route to Internet Gateway
aws ec2 create-route \
    --route-table-id $PUBLIC_RT_ID \
    --destination-cidr-block 0.0.0.0/0 \
    --gateway-id $IGW_ID

# Associate public subnets with route table
aws ec2 associate-route-table \
    --subnet-id $PUBLIC_SUBNET_1 \
    --route-table-id $PUBLIC_RT_ID

aws ec2 associate-route-table \
    --subnet-id $PUBLIC_SUBNET_2 \
    --route-table-id $PUBLIC_RT_ID
```

## 2. DynamoDB Table Setup

```bash
# Create DynamoDB table according to your specifications
aws dynamodb create-table \
    --table-name URLShortenerMappings \
    --attribute-definitions \
        AttributeName=short_url,AttributeType=S \
        AttributeName=long_url,AttributeType=S \
        AttributeName=ttl,AttributeType=N \
    --key-schema \
        AttributeName=short_url,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --stream-specification \
        StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES \
    --tags \
        Key=Application,Value=URLShortener \
        Key=Environment,Value=Production \
    --region us-east-1

# Wait for table to be active
aws dynamodb wait table-exists --table-name URLShortenerMappings

# Enable TTL on the table
aws dynamodb update-time-to-live \
    --table-name URLShortenerMappings \
    --time-to-live-specification \
        Enabled=true,AttributeName=ttl

# Create Global Secondary Index for long_url lookups (to check if URL already exists)
aws dynamodb update-table \
    --table-name URLShortenerMappings \
    --attribute-definitions \
        AttributeName=long_url,AttributeType=S \
    --global-secondary-index-updates \
        "[{
            \"Create\": {
                \"IndexName\": \"LongURLIndex\",
                \"Keys\": [{\"AttributeName\": \"long_url\", \"KeyType\": \"HASH\"}],
                \"Projection\": {\"ProjectionType\": \"ALL\"},
                \"ProvisionedThroughput\": {\"ReadCapacityUnits\": 5, \"WriteCapacityUnits\": 5}
            }
        }]"
```

## 3. DAX Cluster Configuration

```bash
# Create IAM role for DAX
cat > dax-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "dax.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

DAX_ROLE_ARN=$(aws iam create-role \
    --role-name DAXServiceRole \
    --assume-role-policy-document file://dax-trust-policy.json \
    --query 'Role.Arn' \
    --output text)

# Attach policy to DAX role
aws iam attach-role-policy \
    --role-name DAXServiceRole \
    --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess

# Create subnet group for DAX
aws dax create-subnet-group \
    --subnet-group-name url-shortener-dax-subnet-group \
    --subnet-ids $PRIVATE_SUBNET_1 $PRIVATE_SUBNET_2

# Create DAX parameter group
aws dax create-parameter-group \
    --parameter-group-name url-shortener-params \
    --description "Parameter group for URL shortener DAX cluster"

# Create DAX cluster
aws dax create-cluster \
    --cluster-name url-shortener-cache \
    --node-type dax.r3.large \
    --replication-factor 2 \
    --iam-role-arn $DAX_ROLE_ARN \
    --subnet-group-name url-shortener-dax-subnet-group \
    --parameter-group-name url-shortener-params \
    --sse-specification Enabled=true \
    --tags Key=Application,Value=URLShortener

# Get DAX cluster endpoint
DAX_ENDPOINT=$(aws dax describe-clusters \
    --cluster-names url-shortener-cache \
    --query 'Clusters[0].ClusterDiscoveryEndpoint.Address' \
    --output text)

echo "DAX Endpoint: $DAX_ENDPOINT"
```

## 4. EC2 Instance Setup

### Create IAM Role for EC2 Instances

```bash
# Create IAM role for EC2 instances
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

aws iam create-role \
    --role-name URLShortenerEC2Role \
    --assume-role-policy-document file://ec2-trust-policy.json

# Create IAM policy for DynamoDB and DAX access
cat > ec2-dynamodb-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem",
        "dynamodb:GetItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:DescribeTable"
      ],
      "Resource": "arn:aws:dynamodb:*:*:table/URLShortenerMappings*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "dax:*"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "*"
    }
  ]
}
EOF

aws iam put-role-policy \
    --role-name URLShortenerEC2Role \
    --policy-name URLShortenerPolicy \
    --policy-document file://ec2-dynamodb-policy.json

# Create instance profile
aws iam create-instance-profile \
    --instance-profile-name URLShortenerEC2Profile

aws iam add-role-to-instance-profile \
    --instance-profile-name URLShortenerEC2Profile \
    --role-name URLShortenerEC2Role
```

### Create Security Groups

```bash
# Security group for ALB
ALB_SG_ID=$(aws ec2 create-security-group \
    --group-name url-shortener-alb-sg \
    --description "Security group for URL shortener ALB" \
    --vpc-id $VPC_ID \
    --query 'GroupId' \
    --output text)

# Allow HTTP and HTTPS from anywhere
aws ec2 authorize-security-group-ingress \
    --group-id $ALB_SG_ID \
    --protocol tcp \
    --port 80 \
    --cidr 0.0.0.0/0

aws ec2 authorize-security-group-ingress \
    --group-id $ALB_SG_ID \
    --protocol tcp \
    --port 443 \
    --cidr 0.0.0.0/0

# Security group for EC2 instances
EC2_SG_ID=$(aws ec2 create-security-group \
    --group-name url-shortener-ec2-sg \
    --description "Security group for URL shortener EC2 instances" \
    --vpc-id $VPC_ID \
    --query 'GroupId' \
    --output text)

# Allow traffic from ALB only
aws ec2 authorize-security-group-ingress \
    --group-id $EC2_SG_ID \
    --protocol tcp \
    --port 3000 \
    --source-group $ALB_SG_ID

# Security group for DAX
DAX_SG_ID=$(aws ec2 create-security-group \
    --group-name url-shortener-dax-sg \
    --description "Security group for DAX cluster" \
    --vpc-id $VPC_ID \
    --query 'GroupId' \
    --output text)

# Allow traffic from EC2 instances to DAX
aws ec2 authorize-security-group-ingress \
    --group-id $DAX_SG_ID \
    --protocol tcp \
    --port 8111 \
    --source-group $EC2_SG_ID
```

### Create Launch Template and Auto Scaling Group

```bash
# Create user data script for EC2 instances
cat > user-data.sh << 'EOF'
#!/bin/bash
# Update system
yum update -y

# Install Node.js
curl -sL https://rpm.nodesource.com/setup_16.x | sudo bash -
yum install -y nodejs

# Install git
yum install -y git

# Create application directory
mkdir -p /opt/url-shortener
cd /opt/url-shortener

# Create the application (you'll need to replace with your actual code repository)
# For now, creating a basic structure
cat > package.json << 'EOAPP'
{
  "name": "url-shortener",
  "version": "1.0.0",
  "main": "server.js",
  "dependencies": {
    "express": "^4.18.2",
    "aws-sdk": "^2.1400.0",
    "amazon-dax-client": "^1.2.0",
    "crypto": "^1.0.1"
  }
}
EOAPP

# Install dependencies
npm install

# Start the application
node server.js &
EOF

# Base64 encode the user data
USER_DATA=$(base64 -w 0 user-data.sh)

# Create launch template
aws ec2 create-launch-template \
    --launch-template-name URLShortenerTemplate \
    --launch-template-data "{
        \"ImageId\": \"ami-0c02fb55731490381\",
        \"InstanceType\": \"t3.medium\",
        \"IamInstanceProfile\": {
            \"Name\": \"URLShortenerEC2Profile\"
        },
        \"SecurityGroupIds\": [\"$EC2_SG_ID\"],
        \"UserData\": \"$USER_DATA\",
        \"TagSpecifications\": [{
            \"ResourceType\": \"instance\",
            \"Tags\": [
                {\"Key\": \"Name\", \"Value\": \"url-shortener-instance\"},
                {\"Key\": \"Application\", \"Value\": \"URLShortener\"}
            ]
        }]
    }"

# Create Auto Scaling Group
aws autoscaling create-auto-scaling-group \
    --auto-scaling-group-name url-shortener-asg \
    --launch-template LaunchTemplateName=URLShortenerTemplate,Version='$Latest' \
    --min-size 2 \
    --max-size 6 \
    --desired-capacity 2 \
    --vpc-zone-identifier "$PRIVATE_SUBNET_1,$PRIVATE_SUBNET_2" \
    --health-check-type ELB \
    --health-check-grace-period 300 \
    --tags "Key=Name,Value=url-shortener-asg,PropagateAtLaunch=true"
```

## 5. Application Load Balancer Setup

```bash
# Create Application Load Balancer
ALB_ARN=$(aws elbv2 create-load-balancer \
    --name url-shortener-alb \
    --subnets $PUBLIC_SUBNET_1 $PUBLIC_SUBNET_2 \
    --security-groups $ALB_SG_ID \
    --scheme internet-facing \
    --type application \
    --ip-address-type ipv4 \
    --tags Key=Name,Value=url-shortener-alb \
    --query 'LoadBalancers[0].LoadBalancerArn' \
    --output text)

# Get ALB DNS name
ALB_DNS=$(aws elbv2 describe-load-balancers \
    --load-balancer-arns $ALB_ARN \
    --query 'LoadBalancers[0].DNSName' \
    --output text)

echo "ALB DNS: $ALB_DNS"

# Create Target Group for URL Creation Service
CREATE_TG_ARN=$(aws elbv2 create-target-group \
    --name url-shortener-create-tg \
    --protocol HTTP \
    --port 3000 \
    --vpc-id $VPC_ID \
    --health-check-enabled \
    --health-check-path /health \
    --health-check-interval-seconds 30 \
    --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 \
    --unhealthy-threshold-count 3 \
    --matcher HttpCode=200 \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text)

# Create Target Group for URL Retrieval Service
RETRIEVE_TG_ARN=$(aws elbv2 create-target-group \
    --name url-shortener-retrieve-tg \
    --protocol HTTP \
    --port 3000 \
    --vpc-id $VPC_ID \
    --health-check-enabled \
    --health-check-path /health \
    --health-check-interval-seconds 30 \
    --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 \
    --unhealthy-threshold-count 3 \
    --matcher HttpCode=200 \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text)

# Create ALB Listener
LISTENER_ARN=$(aws elbv2 create-listener \
    --load-balancer-arn $ALB_ARN \
    --protocol HTTP \
    --port 80 \
    --default-actions Type=fixed-response,FixedResponseConfig={StatusCode=404} \
    --query 'Listeners[0].ListenerArn' \
    --output text)

# Add listener rules for routing
# Rule for URL creation (POST /url/longURL)
aws elbv2 create-rule \
    --listener-arn $LISTENER_ARN \
    --priority 1 \
    --conditions Field=path-pattern,Values="/url/*" Field=http-request-method,HttpRequestMethodConfig={Values=[POST]} \
    --actions Type=forward,TargetGroupArn=$CREATE_TG_ARN

# Rule for URL retrieval (GET /url/shortURL)
aws elbv2 create-rule \
    --listener-arn $LISTENER_ARN \
    --priority 2 \
    --conditions Field=path-pattern,Values="/url/*" Field=http-request-method,HttpRequestMethodConfig={Values=[GET]} \
    --actions Type=forward,TargetGroupArn=$RETRIEVE_TG_ARN

# Attach Auto Scaling Group to Target Groups
aws autoscaling attach-load-balancer-target-groups \
    --auto-scaling-group-name url-shortener-asg \
    --target-group-arns $CREATE_TG_ARN $RETRIEVE_TG_ARN
```

## 6. API Gateway Configuration

```bash
# Create REST API
API_ID=$(aws apigateway create-rest-api \
    --name "URLShortenerAPI" \
    --description "API for URL Shortener Service" \
    --endpoint-configuration types=REGIONAL \
    --query 'id' \
    --output text)

# Get root resource ID
ROOT_ID=$(aws apigateway get-resources \
    --rest-api-id $API_ID \
    --query 'items[0].id' \
    --output text)

# Create /url resource
URL_RESOURCE_ID=$(aws apigateway create-resource \
    --rest-api-id $API_ID \
    --parent-id $ROOT_ID \
    --path-part url \
    --query 'id' \
    --output text)

# Create /{proxy+} resource for dynamic paths
PROXY_RESOURCE_ID=$(aws apigateway create-resource \
    --rest-api-id $API_ID \
    --parent-id $URL_RESOURCE_ID \
    --path-part "{proxy+}" \
    --query 'id' \
    --output text)

# Create POST method for URL creation
aws apigateway put-method \
    --rest-api-id $API_ID \
    --resource-id $PROXY_RESOURCE_ID \
    --http-method POST \
    --authorization-type NONE

# Create GET method for URL retrieval
aws apigateway put-method \
    --rest-api-id $API_ID \
    --resource-id $PROXY_RESOURCE_ID \
    --http-method GET \
    --authorization-type NONE

# Configure HTTP proxy integration to ALB for POST
aws apigateway put-integration \
    --rest-api-id $API_ID \
    --resource-id $PROXY_RESOURCE_ID \
    --http-method POST \
    --type HTTP_PROXY \
    --integration-http-method POST \
    --uri "http://$ALB_DNS/url/{proxy}" \
    --request-parameters "integration.request.path.proxy=method.request.path.proxy"

# Configure HTTP proxy integration to ALB for GET
aws apigateway put-integration \
    --rest-api-id $API_ID \
    --resource-id $PROXY_RESOURCE_ID \
    --http-method GET \
    --type HTTP_PROXY \
    --integration-http-method GET \
    --uri "http://$ALB_DNS/url/{proxy}" \
    --request-parameters "integration.request.path.proxy=method.request.path.proxy"

# Deploy the API
aws apigateway create-deployment \
    --rest-api-id $API_ID \
    --stage-name prod \
    --stage-description "Production stage"

# Get the API endpoint
API_ENDPOINT="https://$API_ID.execute-api.us-east-1.amazonaws.com/prod"
echo "API Gateway Endpoint: $API_ENDPOINT"
```

## 7. Route 53 DNS Configuration

```bash
# Assumes you have a domain registered in Route 53
# Replace example.com with your actual domain
DOMAIN_NAME="example.com"
SUBDOMAIN="short.example.com"

# Get hosted zone ID
ZONE_ID=$(aws route53 list-hosted-zones \
    --query "HostedZones[?Name=='${DOMAIN_NAME}.'].Id" \
    --output text | cut -d'/' -f3)

# Create CNAME record pointing to API Gateway
cat > route53-record.json << EOF
{
  "Changes": [
    {
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "${SUBDOMAIN}",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [
          {
            "Value": "${API_ID}.execute-api.us-east-1.amazonaws.com"
          }
        ]
      }
    }
  ]
}
EOF

aws route53 change-resource-record-sets \
    --hosted-zone-id $ZONE_ID \
    --change-batch file://route53-record.json

# For production, you should set up a custom domain name in API Gateway
# with an ACM certificate for HTTPS
```

## 8. Application Code Templates

### Node.js Server Template (server.js)

```javascript
const express = require('express');
const AWS = require('aws-sdk');
const AmazonDaxClient = require('amazon-dax-client');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Configuration
const DAX_ENDPOINT = process.env.DAX_ENDPOINT || 'url-shortener-cache.xxxxx.dax-clusters.us-east-1.amazonaws.com:8111';
const TABLE_NAME = 'URLShortenerMappings';
const TTL_DAYS = 365;

// Initialize DAX client
const dax = new AmazonDaxClient({
    endpoints: [DAX_ENDPOINT],
    region: 'us-east-1'
});
const daxClient = new AWS.DynamoDB.DocumentClient({
    service: dax
});

// Initialize regular DynamoDB client for writes
const dynamodb = new AWS.DynamoDB.DocumentClient({
    region: 'us-east-1'
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy' });
});

// URL Creation Service
app.post('/url/:longUrl', async (req, res) => {
    try {
        const longUrl = decodeURIComponent(req.params.longUrl);
        
        // Generate SHA-256 hash and take first 30 characters
        const hash = crypto.createHash('sha256').update(longUrl).digest('hex');
        const shortUrl = hash.substring(0, 30);
        
        // Calculate TTL (current time + 365 days)
        const ttl = Math.floor(Date.now() / 1000) + (TTL_DAYS * 24 * 60 * 60);
        
        // Check if URL already exists using GSI
        const existingUrl = await dynamodb.query({
            TableName: TABLE_NAME,
            IndexName: 'LongURLIndex',
            KeyConditionExpression: 'long_url = :url',
            ExpressionAttributeValues: {
                ':url': longUrl
            }
        }).promise();
        
        if (existingUrl.Items && existingUrl.Items.length > 0) {
            // URL already exists, return existing short URL
            return res.status(200).json({
                shortUrl: existingUrl.Items[0].short_url,
                longUrl: longUrl,
                ttl: existingUrl.Items[0].ttl
            });
        }
        
        // Store in DynamoDB
        await dynamodb.put({
            TableName: TABLE_NAME,
            Item: {
                short_url: shortUrl,
                long_url: longUrl,
                ttl: ttl,
                created_at: new Date().toISOString(),
                access_count: 0
            },
            ConditionExpression: 'attribute_not_exists(short_url)'
        }).promise();
        
        res.status(201).json({
            shortUrl: shortUrl,
            longUrl: longUrl,
            ttl: ttl
        });
    } catch (error) {
        console.error('Error creating short URL:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// URL Retrieval Service
app.get('/url/:shortUrl', async (req, res) => {
    try {
        const shortUrl = req.params.shortUrl;
        
        // Try to get from DAX cache first
        const result = await daxClient.get({
            TableName: TABLE_NAME,
            Key: {
                short_url: shortUrl
            }
        }).promise();
        
        if (!result.Item) {
            return res.status(404).json({ error: 'URL not found' });
        }
        
        // Update access count (write directly to DynamoDB, not through DAX)
        dynamodb.update({
            TableName: TABLE_NAME,
            Key: {
                short_url: shortUrl
            },
            UpdateExpression: 'ADD access_count :inc',
            ExpressionAttributeValues: {
                ':inc': 1
            }
        }).promise().catch(err => {
            console.error('Error updating access count:', err);
        });
        
        // Redirect to long URL
        res.redirect(301, result.Item.long_url);
    } catch (error) {
        console.error('Error retrieving URL:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`URL Shortener service running on port ${PORT}`);
});
```

## 9. Monitoring and Auto-scaling

### CloudWatch Alarms

```bash
# Create CloudWatch alarm for high CPU utilization
aws cloudwatch put-metric-alarm \
    --alarm-name url-shortener-cpu-high \
    --alarm-description "Alarm when CPU exceeds 70%" \
    --metric-name CPUUtilization \
    --namespace AWS/EC2 \
    --statistic Average \
    --period 300 \
    --threshold 70 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 2 \
    --dimensions Name=AutoScalingGroupName,Value=url-shortener-asg

# Create CloudWatch alarm for DynamoDB throttling
aws cloudwatch put-metric-alarm \
    --alarm-name url-shortener-dynamodb-throttle \
    --alarm-description "Alarm when DynamoDB throttles requests" \
    --metric-name ThrottledRequests \
    --namespace AWS/DynamoDB \
    --statistic Sum \
    --period 300 \
    --threshold 10 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 1 \
    --dimensions Name=TableName,Value=URLShortenerMappings
```

### Auto Scaling Policies

```bash
# Create scaling policy for scale out
SCALE_OUT_ARN=$(aws autoscaling put-scaling-policy \
    --auto-scaling-group-name url-shortener-asg \
    --policy-name url-shortener-scale-out \
    --policy-type TargetTrackingScaling \
    --target-tracking-configuration "{
        \"PredefinedMetricSpecification\": {
            \"PredefinedMetricType\": \"ASGAverageCPUUtilization\"
        },
        \"TargetValue\": 60.0
    }" \
    --query 'PolicyARN' \
    --output text)

# Create scaling policy based on ALB request count
aws autoscaling put-scaling-policy \
    --auto-scaling-group-name url-shortener-asg \
    --policy-name url-shortener-request-scaling \
    --policy-type TargetTrackingScaling \
    --target-tracking-configuration "{
        \"PredefinedMetricSpecification\": {
            \"PredefinedMetricType\": \"ALBRequestCountPerTarget\",
            \"ResourceLabel\": \"${ALB_ARN}\"
        },
        \"TargetValue\": 1000.0
    }"
```

## 10. Testing Your Setup

```bash
# Test URL creation
curl -X POST "https://${API_ID}.execute-api.us-east-1.amazonaws.com/prod/url/https%3A%2F%2Fwww.google.com"

# Test URL retrieval (replace SHORT_CODE with actual generated code)
curl -i "https://${API_ID}.execute-api.us-east-1.amazonaws.com/prod/url/SHORT_CODE"

# Check ALB health
aws elbv2 describe-target-health \
    --target-group-arn $CREATE_TG_ARN

# Check Auto Scaling Group status
aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names url-shortener-asg

# Monitor DynamoDB metrics
aws cloudwatch get-metric-statistics \
    --namespace AWS/DynamoDB \
    --metric-name ConsumedReadCapacityUnits \
    --dimensions Name=TableName,Value=URLShortenerMappings \
    --start-time 2024-01-01T00:00:00Z \
    --end-time 2024-12-31T23:59:59Z \
    --period 3600 \
    --statistics Average
```

## Important Notes

1. **Security**: 
   - Enable VPC endpoints for DynamoDB to keep traffic private
   - Use AWS WAF on your API Gateway for additional protection
   - Enable AWS Shield for DDoS protection
   - Implement rate limiting in API Gateway

2. **Cost Optimization**:
   - Use Reserved Instances for predictable workloads
   - Consider using Spot Instances for non-critical capacity
   - Monitor DAX and DynamoDB usage to optimize costs
   - Use S3 for storing analytics data long-term

3. **Performance**:
   - DAX provides microsecond latency for cached reads
   - Consider using ElastiCache if you need more complex caching strategies
   - Implement connection pooling in your application

4. **High Availability**:
   - The setup uses multiple AZs for fault tolerance
   - Consider implementing cross-region replication for disaster recovery
   - Use Route 53 health checks for automatic failover

5. **Maintenance**:
   - Regularly update your EC2 instances
   - Monitor and rotate your logs
   - Implement proper backup strategies for your DynamoDB table

## Clean Up Resources (when needed)

```bash
# Delete resources in reverse order
aws autoscaling delete-auto-scaling-group --auto-scaling-group-name url-shortener-asg --force-delete
aws elbv2 delete-load-balancer --load-balancer-arn $ALB_ARN
aws elbv2 delete-target-group --target-group-arn $CREATE_TG_ARN
aws elbv2 delete-target-group --target-group-arn $RETRIEVE_TG_ARN
aws dax delete-cluster --cluster-name url-shortener-cache
aws dynamodb delete-table --table-name URLShortenerMappings
aws apigateway delete-rest-api --rest-api-id $API_ID
```

This completes the AWS infrastructure setup for your URL shortener service!
const express = require('express');
const AWS = require('aws-sdk');
const AmazonDaxClient = require('amazon-dax-client');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());

// Configuration
const DAX_ENDPOINT = process.env.DAX_ENDPOINT;
if (!DAX_ENDPOINT) {
    throw new Error('DAX_ENDPOINT environment variable is required');
}
const TABLE_NAME = 'URLShortenerMappings';
const TTL_DAYS = 365;
const SHORT_URL_LENGTH = 16;

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

// Serve static files from React app build directory
app.use(express.static(path.join(__dirname, '../ui/build')));

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy' });
});

// URL Creation Service - JSON body version
app.post('/url', async (req, res) => {
    try {
        const { longUrl } = req.body;
        
        if (!longUrl) {
            return res.status(400).json({ error: 'longUrl is required' });
        }

        const hash = crypto.createHash('sha256').update(longUrl).digest('hex');
        const shortUrl = hash.substring(0, SHORT_URL_LENGTH);

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

// URL Creation Service - Legacy endpoint with URL param (for backward compatibility)
app.post('/url/:longUrl', async (req, res) => {
    try {
        const longUrl = decodeURIComponent(req.params.longUrl);

        const hash = crypto.createHash('sha256').update(longUrl).digest('hex');
        const shortUrl = hash.substring(0, SHORT_URL_LENGTH);

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

// Catch all handler: send back React's index.html file for client-side routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../ui/build/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`URL Shortener service running on port ${PORT}`);
});

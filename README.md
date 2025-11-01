For simplicity, the frontend, and both the read and write path are hosted on the same ec2 instances.

For a production setup, we would:
Separate read service (GET /url/:shortUrl) — can scale for high read traffic
Separate write service (POST /url) — can scale for write operations
Serve the frontend on CDN — deploy static files to S3 + CloudFront

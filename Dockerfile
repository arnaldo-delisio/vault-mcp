# Use Node 20 with Python3
FROM node:20-slim

# Install Python3 and other dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create symlink for python (yt-dlp expects 'python3')
RUN ln -s /usr/bin/python3 /usr/bin/python || true

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev deps for build)
RUN npm ci

# Copy application files
COPY . .

# Build TypeScript
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Expose port
EXPOSE 8080

# Start application
CMD ["npm", "start"]

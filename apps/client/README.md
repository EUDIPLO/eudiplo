# eudiplo client

A web interface for interacting with an **eudiplo instance** to manage digital credential configurations.

## Features

- **Configuration Management**: Create, edit, and manage credential configurations
- **Key Management**: Handle cryptographic keys for credential signing
- **Issuance Configuration**: Set up and configure credential issuance parameters
- **Presentation Management**: Configure credential presentation and verification settings
- **Session Management**: Monitor and manage active credential sessions with multi-select operations
- **Real-time Updates**: Background polling for session status and QR code generation
- **Dashboard Overview**: Setup status, session counts, recent activity and warnings with links to their fix

## Prerequisites

- Node.js 18+
- pnpm or npm
- Docker (for containerized deployment)

## Quick Start

### Development Setup

#### 1. Install Dependencies

```bash
pnpm install
```

#### 2. Start Development Server

```bash
pnpm start
```

Navigate to `http://localhost:4200/` and enter your eudiplo instance details in the login form:

- **API URL**: Your eudiplo server URL (e.g., `https://your-eudiplo-instance.com/api`)
- **OIDC Provider URL**: Your eudiplo OIDC provider URL (e.g., `https://your-oidc-provider.com/auth/realms/your-realm`)
- **Client ID**: Your eudiplo client ID
- **Client Secret**: Your eudiplo client secret

### Docker Deployment

#### Using Docker Compose (Recommended)

```bash
# Build and run the application
make run

# Or manually with docker-compose
docker-compose up --build
```

The application will be available at `http://localhost:8080`

#### Using Docker directly

```bash
# Build the image
docker build -t eudiplo-client:latest .

# Run the container
docker run -p 8080:80 eudiplo-client:latest
```

#### Using Make Commands

```bash
make help          # Show all available commands
make build         # Build Docker image
make run           # Build and run with docker-compose
make dev           # Run in development mode
make stop          # Stop all containers
make clean         # Clean up containers and images
make logs          # Show application logs
make health        # Check application health
```

## Available Scripts

### Local Development

```bash
pnpm start         # Start development server
pnpm build         # Build for production
pnpm test          # Run tests
pnpm run lint      # Run linter
```

### Docker Operations

```bash
make build         # Build Docker image
make run           # Run with docker-compose
make stop          # Stop containers
make logs          # View logs
make health        # Health check
```

## Production Deployment

### Automated CI/CD

This project includes a GitHub Actions workflow that automatically:

- Builds the Docker image on push to main branch
- Publishes to GitHub Container Registry
- Supports multi-platform builds (AMD64, ARM64)

The workflow is triggered on:

- Push to `main` branch
- Manual workflow dispatch
- Release creation

### Manual Production Build

```bash
# Build production image
docker build -t eudiplo-client:latest .

# Tag for registry
docker tag eudiplo-client:latest ghcr.io/your-username/eudiplo-client:latest

# Push to registry
docker push ghcr.io/your-username/eudiplo-client:latest
```

## Architecture

- **Frontend**: Angular 17+ with standalone components
- **UI Framework**: Angular Material
- **Build Tool**: Angular CLI with esbuild
- **Container**: Multi-stage Docker build with Nginx
- **CI/CD**: GitHub Actions with GitHub Container Registry

## Health Monitoring

The application includes a health check endpoint at `/health` that returns:

- Status: `200 OK` with "healthy" response when running
- Used by Docker health checks and load balancers

## Session Management Features

- **Multi-select Operations**: Select multiple sessions for bulk actions
- **Real-time Status Updates**: Background polling for session status changes
- **QR Code Generation**: Automatic QR code generation for session offers
- **Status Filtering**: Filter sessions by their current status
- **Bulk Operations**: Delete multiple sessions simultaneously

## Configuration

### Environment Variables

The application can be configured using environment variables:

- `API_BASE_URL`: Default API base URL
- `CLIENT_BASE_HREF`: HTML base href (`<base href="<CLIENT_BASE_HREF>" />`). Useful for reverse proxy setups where the client is served from a subpath. For example, if the client is served from `https://example.com/eudiplo-client/`, set `CLIENT_BASE_HREF=/eudiplo-client/` to ensure correct routing and asset loading. Note: The value is automatically normalized to ensure it starts and ends with `/`. For example, `eudiplo-client` becomes `/eudiplo-client/`.

#### URL Query Parameters

The application supports configuration via URL query parameters, which is useful for sharing links with preconfigured settings:

```
https://your-app-domain.com/?apiUrl=https://api-server.example.com
```

Supported query parameters:

- `apiUrl`: Override the API base URL for the current session
- `clientId`: Set the client ID for the current session
- `clientSecret`: Set the client secret; with `clientId` and `apiUrl`, the page signs in with these credentials at once

This allows you to create shareable links that point to specific backend instances without changing the container configuration.

The instance receives the access token after a single sign-on, or the client secret, so the login page asks before signing in at an instance that the link chose, also for a link with `clientId`, `clientSecret` and `apiUrl`. It does not ask about the instance `API_BASE_URL` names or the one this browser last signed in to with single sign-on or a client secret the user entered.

#### Docker Environment Configuration

When running the application in Docker, you can dynamically set the API URL without rebuilding the image:

```bash
# Run with a custom API URL
docker run -p 8080:80 -e API_BASE_URL=https://your-api-url.com eudiplo-client:latest
```

With docker-compose:

```yaml
services:
  client:
    image: eudiplo-client:latest
    environment:
      - API_BASE_URL=https://your-api-url.com
    ports:
      - '8080:80'
```

The container uses an entrypoint script that updates the `env.js` file at startup with the provided environment variables.

### Nginx Configuration

The production build uses an optimized Nginx configuration with:

- SPA routing support
- Asset caching (1 year for static assets)
- Gzip compression
- Security headers
- Health check endpoint

Output will be in `dist/eudiplo-client/` directory.

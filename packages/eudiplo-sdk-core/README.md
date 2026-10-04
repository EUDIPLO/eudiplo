# @eudiplo/sdk-core

Framework-agnostic EUDIPLO SDK for demos and integrations. Works with Node.js, browsers, React, Vue, vanilla JS, and any other JavaScript environment.

## Installation

```bash
npm install @eudiplo/sdk-core
# or
pnpm add @eudiplo/sdk-core
# or
yarn add @eudiplo/sdk-core
```

## Quick Start

```typescript
import { EudiploClient } from '@eudiplo/sdk-core';

const client = new EudiploClient({
  baseUrl: 'https://eudiplo.example.com',
  clientId: 'my-demo',
  clientSecret: 'secret',
});

// Verification (QR flow)
const verifyOffer = await client.createPresentationRequest({
  configId: 'age-over-18',
});
showQRCode(verifyOffer.uri);
const verifiedSession = await client.waitForSession(verifyOffer.sessionId);

// Issuance (QR flow)
const issuanceOffer = await client.createIssuanceOffer({
  credentialConfigurationIds: ['PID'],
  claims: {
    PID: { given_name: 'John', family_name: 'Doe', birthdate: '1990-01-15' },
  },
});
showQRCode(issuanceOffer.uri);
await client.waitForSession(issuanceOffer.sessionId);
```

## Full API

### Class API

Use `EudiploClient` methods directly:

| Method                        | Description                                    |
| ----------------------------- | ---------------------------------------------- |
| `createPresentationRequest()` | Create verification request URI and session ID |
| `createIssuanceOffer()`       | Create issuance offer URI and session ID       |
| `waitForSession()`            | Poll session until terminal state              |
| `subscribeToSession()`        | Subscribe via SSE                              |
| `verifyWithDcApi()`           | Browser-native DC API end-to-end flow          |

### Digital Credentials API (Browser Native)

The SDK includes utilities for the [Digital Credentials API](https://wicg.github.io/digital-credentials/), enabling browser-native credential presentation without QR codes.

```typescript
import { isDcApiAvailable, EudiploClient } from '@eudiplo/sdk-core';

const client = new EudiploClient({
  baseUrl: 'https://eudiplo.example.com',
  clientId: 'my-demo',
  clientSecret: 'secret',
});

// Check if browser supports DC API
if (isDcApiAvailable()) {
  const result = await client.verifyWithDcApi({
    configId: 'age-over-18',
  });

  console.log('Verified!', result.credentials);
} else {
  // Fall back to QR code flow using EudiploClient methods
}
```

#### DC API Methods

| Method                                       | Description                                         |
| -------------------------------------------- | --------------------------------------------------- |
| `isDcApiAvailable()`                         | Check if browser supports Digital Credentials API   |
| `client.verifyWithDcApi()`                   | Complete verification flow using browser-native API |
| `client.createDcApiPresentationRequest(...)` | Create DC API session with request object           |

#### Lower-level DC API Usage

```typescript
import { EudiploClient } from '@eudiplo/sdk-core';

const client = new EudiploClient({...});

// Create DC API session with request object
const session = await client.createDcApiPresentationRequest({
  configId: 'age-over-18',
});

// Submit using the browser-native DC API end-to-end
const result = await client.submitDcApiPresentation(session);
```

#### Secure Deployment Note

For production deployments, keep `clientId` and `clientSecret` on the server.
Use `EudiploClient` methods to run the full flow (`createDcApiPresentationRequest` + `submitDcApiPresentation`) from trusted backend/application code.

### Class-based API (More Control)

```typescript
import { EudiploClient } from '@eudiplo/sdk-core';

const client = new EudiploClient({
  baseUrl: 'https://eudiplo.example.com',
  clientId: 'my-demo-client',
  clientSecret: 'your-secret',
});

// Create a presentation request (e.g., for age verification)
const { uri, sessionId } = await client.createPresentationRequest({
  configId: 'age-over-18',
});

console.log('Show this QR code:', uri);

// Wait for the user to scan and respond
const session = await client.waitForSession(sessionId, {
  onUpdate: (s) => console.log('Status:', s.status),
});

console.log('Verified credentials:', session.credentials);
```

## API

### `new EudiploClient(config)`

Create a new client instance.

```typescript
const client = new EudiploClient({
  baseUrl: 'https://eudiplo.example.com', // EUDIPLO server URL
  clientId: 'my-client', // OAuth2 client ID
  clientSecret: 'secret', // OAuth2 client secret
  autoRefresh: true, // Auto-refresh tokens (default: true)
});
```

### `createPresentationRequest(options)`

Create a presentation request for credential verification.

```typescript
const { uri, sessionId } = await client.createPresentationRequest({
  configId: 'age-over-18', // Presentation config ID
  responseType: 'uri', // 'uri' | 'qrcode' | 'dc-api'
  redirectUri: 'https://...', // Optional redirect after completion
  skewSeconds: 60, // Optional JWT clock skew override for this request
});
```

### `createIssuanceOffer(options)`

Create a credential issuance offer.

```typescript
const { uri, sessionId } = await client.createIssuanceOffer({
  credentialConfigurationIds: ['PID', 'mDL'],
  claims: {
    PID: { given_name: 'John', family_name: 'Doe' },
    mDL: { driving_privileges: [...] }
  },
  flow: 'pre_authorized_code',       // or 'authorization_code'
  txCode: '1234'                     // Optional transaction code
});
```

### `getSession(sessionId)`

Get the current state of a session.

```typescript
const session = await client.getSession(sessionId);
console.log(session.status); // 'active' | 'fetched' | 'completed' | 'expired' | 'failed'
```

### `waitForSession(sessionId, options)`

Poll until a session completes or fails.

```typescript
const session = await client.waitForSession(sessionId, {
  interval: 1000, // Poll every 1 second
  timeout: 60000, // Timeout after 60 seconds
  signal: abortController.signal, // Optional abort signal
  onUpdate: (session) => {
    console.log('Status:', session.status);
  },
});
```

### `subscribeToSession(sessionId, options)`

Subscribe to real-time session status updates via Server-Sent Events (SSE).
This is more efficient than polling and provides instant updates. The stream
is read with `fetch` and the client's access token in the `Authorization`
header, so it works in Node.js 18+ and in browsers. The client holds your
client secret: use it in your backend, not in a web page. Failed connections
are retried up to three times in total.

```typescript
const subscription = await client.subscribeToSession(sessionId, {
  onStatusChange: (event) => {
    console.log(`Status: ${event.status}`);
    if (['completed', 'expired', 'failed'].includes(event.status)) {
      subscription.close();
    }
  },
  onError: (error) => console.error('SSE error:', error),
  onOpen: () => console.log('Connected'),
});

// Later, to close the connection:
subscription.close();
```

### `waitForSessionWithSse(sessionId, options)`

Wait for session completion using SSE instead of polling. Returns a Promise
that resolves when the session completes and rejects when it fails or expires,
or when the stream cannot be opened.

```typescript
try {
  const finalStatus = await client.waitForSessionWithSse(sessionId, {
    onStatusChange: (event) => console.log('Status:', event.status),
  });
  console.log('Session completed:', finalStatus);
} catch (error) {
  console.error('Session failed:', error);
}
```

## Examples

### Age Verification in a Web Shop

```typescript
import { EudiploClient } from '@eudiplo/sdk-core';

const client = new EudiploClient({
  baseUrl: process.env.EUDIPLO_URL,
  clientId: process.env.EUDIPLO_CLIENT_ID,
  clientSecret: process.env.EUDIPLO_CLIENT_SECRET,
});

// Express.js route handler
app.post('/api/verify-age', async (req, res) => {
  const { uri, sessionId } = await client.createPresentationRequest({
    configId: 'age-over-18',
    redirectUri: `${req.headers.origin}/checkout`,
  });

  res.json({ qrCodeUri: uri, sessionId });
});

app.get('/api/verify-age/:sessionId', async (req, res) => {
  const session = await client.getSession(req.params.sessionId);
  res.json({
    status: session.status,
    verified: session.status === 'completed',
  });
});
```

### React Hook Example

```typescript
import { useState, useEffect } from 'react';
import { EudiploClient } from '@eudiplo/sdk-core';

const client = new EudiploClient({...});

function useAgeVerification(configId: string) {
  const [uri, setUri] = useState<string>();
  const [status, setStatus] = useState<string>('idle');
  const [verified, setVerified] = useState(false);

  const startVerification = async () => {
    setStatus('pending');
    const { uri, sessionId } = await client.createPresentationRequest({ configId });
    setUri(uri);

    try {
      const session = await client.waitForSession(sessionId, {
        onUpdate: (s) => setStatus(s.status)
      });
      setVerified(true);
      setStatus('completed');
    } catch (e) {
      setStatus('failed');
    }
  };

  return { uri, status, verified, startVerification };
}
```

## Advanced: Direct API Access

For advanced use cases, you can access the generated API functions directly:

```typescript
import {
  client,
  sessionControllerGetAllSessions,
  credentialConfigControllerGetConfigs,
} from '@eudiplo/sdk-core/api';

// Configure the client
client.setConfig({
  baseUrl: 'https://eudiplo.example.com',
  headers: { Authorization: 'Bearer your-token' },
});

// Use any API endpoint
const configs = await credentialConfigControllerGetConfigs({});
```

## Requirements

- Node.js 20+ (uses native `fetch`)
- For older environments, use a `fetch` polyfill

## License

Apache-2.0

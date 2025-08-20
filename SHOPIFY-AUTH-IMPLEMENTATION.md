# Shopify Authentication Implementation Guide

## Current Issues
- No session token validation
- No OAuth implementation
- Direct database queries without auth
- Missing CSRF protection

## Required Implementation

### 1. Session Token Authentication (for Embedded Apps)

```javascript
// server.js - Add Shopify authentication
const { shopifyApp } = require('@shopify/shopify-app-express');
const { SQLiteSessionStorage } = require('@shopify/shopify-app-session-storage-sqlite');

const shopify = shopifyApp({
  api: {
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SHOPIFY_SCOPES.split(','),
    hostName: process.env.SHOPIFY_APP_URL.replace(/https?:\/\//, ''),
    apiVersion: '2024-01',
  },
  auth: {
    path: '/api/auth',
    callbackPath: '/api/auth/callback',
  },
  webhooks: {
    path: '/api/webhooks',
  },
  sessionStorage: new SQLiteSessionStorage('./data/sessions.db'),
});

// Replace current auth with Shopify's
app.get('/admin', shopify.ensureInstalledOnShop(), async (req, res) => {
  const session = res.locals.shopify.session;
  const shop = session.shop;
  
  // Now properly authenticated!
  const shopData = await DatabaseQueries.getShop(shop);
  res.send(generateAdminPage(shop, shopData, null));
});
```

### 2. Token Exchange (Recommended for API Access)

```javascript
// For API routes that need to access Shopify Admin API
app.post('/api/test-message', 
  shopify.validateAuthenticatedSession(),
  async (req, res) => {
    const session = res.locals.shopify.session;
    const client = new shopify.api.clients.Graphql({ session });
    
    // Can now make authenticated Shopify API calls
    const products = await client.query({
      data: `{
        products(first: 10) {
          edges {
            node {
              id
              title
            }
          }
        }
      }`
    });
});
```

### 3. Webhook Validation (Replace Current Implementation)

```javascript
// Replace manual HMAC verification with Shopify's
app.post('/webhooks/orders/create',
  shopify.processWebhooks({ webhookHandlers: {
    ORDERS_CREATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: '/webhooks/orders/create',
      callback: async (topic, shop, body, webhookId) => {
        // Automatically verified!
        await handleOrderCreated(shop, body);
      },
    },
  }}),
);
```

### 4. Session Token Validation in Frontend

```javascript
// In admin dashboard HTML
import { authenticatedFetch } from '@shopify/app-bridge-utils';

// Create authenticated fetch instance
const app = createApp({
  apiKey: '${process.env.SHOPIFY_API_KEY}',
  host: '${host}',
});

const authFetch = authenticatedFetch(app);

// Use for all API calls
async function loadMetrics() {
  const response = await authFetch('/api/metrics');
  const data = await response.json();
  // Session token automatically included!
}
```

## Benefits of Proper Implementation

1. **Automatic Session Management** - No manual JWT handling
2. **Built-in CSRF Protection** - Shopify handles it
3. **Seamless Installation** - Shopify manages OAuth flow
4. **Token Rotation** - Automatic token refresh
5. **Webhook Verification** - Built-in HMAC validation

## Migration Steps

1. Install Shopify packages
2. Initialize shopifyApp middleware
3. Replace all routes with authenticated versions
4. Update frontend to use authenticatedFetch
5. Remove manual HMAC verification
6. Test with Shopify CLI

## Security Improvements

- ✅ Session tokens validate every request
- ✅ CSRF protection built-in
- ✅ Automatic token rotation
- ✅ Proper OAuth implementation
- ✅ Webhook signature validation
- ✅ Rate limiting included
// shopify.app.config.js
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

// Load environment variables first
if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
} else {
  dotenv.config();
}

const { shopifyApp } = require('@shopify/shopify-app-express');
const { SQLiteSessionStorage } = require('@shopify/shopify-app-session-storage-sqlite');
const { ApiVersion, DeliveryMethod } = require('@shopify/shopify-api');

// Initialize session storage with proper path
const sessionsDir = path.join(__dirname, 'data');

// Ensure sessions directory exists
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

const sessionStorage = new SQLiteSessionStorage(path.join(sessionsDir, 'sessions.db'));

// Configure Shopify app
const shopify = shopifyApp({
  api: {
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SHOPIFY_SCOPES?.split(',') || [
      'read_orders', 'write_orders',
      'read_customers', 'write_customers', 
      'read_products', 'write_products',
      'read_checkouts', 'write_checkouts'
    ],
    hostName: process.env.SHOPIFY_APP_URL?.replace(/https?:\/\//, '') || 'localhost',
    hostScheme: process.env.SHOPIFY_APP_URL?.includes('https') ? 'https' : 'http',
    apiVersion: ApiVersion.October24,
    isEmbeddedApp: true,
    logger: {
      level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
      httpRequests: true,
    },
    useOnlineTokens: false, // Critical: Use offline tokens for server-side apps
  },
  auth: {
    path: '/auth',
    callbackPath: '/auth/callback',
    exitIframePath: '/exitiframe',
  },
  redirectToShopifyOrAppRoot() {
    return '/app';
  },
  sessionStorage,
  webhooks: {
    path: '/webhooks',
    handlers: {
      ORDERS_CREATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: '/webhooks/orders/create',
      },
      ORDERS_UPDATED: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: '/webhooks/orders/updated',
      },
      ORDERS_PAID: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: '/webhooks/orders/paid',
      },
      ORDERS_FULFILLED: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: '/webhooks/orders/fulfilled',
      },
      CHECKOUTS_CREATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: '/webhooks/checkouts/create',
      },
      CHECKOUTS_UPDATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: '/webhooks/checkouts/update',
      },
      CUSTOMERS_CREATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: '/webhooks/customers/create',
      }
    },
  },
});

module.exports = { shopify, sessionStorage };
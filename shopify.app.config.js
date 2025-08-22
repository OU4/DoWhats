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
const { ApiVersion } = require('@shopify/shopify-api');

// Initialize session storage with proper path
const sessionsDir = path.join(__dirname, 'data');

// Ensure sessions directory exists
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

const sessionStorage = new SQLiteSessionStorage(path.join(sessionsDir, 'sessions.db'));

// Import database queries for afterAuth
const { initializeDatabase } = require('./database');
const DatabaseQueries = require('./database/queries');

// Initialize database
initializeDatabase().catch(console.error);

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
    future: {
      unstable_newEmbeddedAuthStrategy: true, // Enable new auth strategy
      unstable_managedPricingSupport: true,   // Enable managed installation features
      unstable_tokenExchange: true            // Enable token exchange (bypasses OAuth)
    }
  },
  auth: {
    path: '/auth',
    callbackPath: '/auth/callback',
    exitIframePath: '/exitiframe',
    afterAuth: async ({ session }) => {
      console.log('🎯🎯🎯 AFTERAUTH CALLBACK TRIGGERED!!! 🎯🎯🎯');
      console.log('Session details:', {
        shop: session.shop,
        hasAccessToken: !!session.accessToken,
        accessToken: session.accessToken ? session.accessToken.substring(0, 20) + '...' : 'None',
        scope: session.scope,
        sessionId: session.id,
        isOnline: session.isOnline,
        state: session.state,
        expires: session.expires
      });
      
      // Log current session storage state
      try {
        const existingSession = await sessionStorage.loadSession(session.id);
        console.log('🔍 Session storage check:', {
          sessionExists: !!existingSession,
          sessionId: session.id
        });
      } catch (error) {
        console.error('❌ Error checking session storage:', error);
      }
      
      // Save shop to our custom database
      try {
        console.log('📝 Attempting to save shop to database:', session.shop);
        await DatabaseQueries.createOrUpdateShop(
          session.shop,
          session.accessToken,
          {
            shop_name: session.shop.split('.')[0],
            email: null,
            phone: null
          }
        );
        console.log('✅✅✅ Shop saved to database successfully!');
        
        // Verify it was saved
        const saved = await DatabaseQueries.getShop(session.shop);
        console.log('🔍 Verification - Shop in database:', !!saved);
        console.log('🔍 Saved shop data:', saved);
        
      } catch (error) {
        console.error('❌❌❌ Failed to save shop to database:', error);
        console.error('Stack trace:', error.stack);
        throw error; // Re-throw to see if this causes issues
      }
      
      console.log('🎉 AFTERAUTH CALLBACK COMPLETED SUCCESSFULLY!');
      
      // Register webhooks for this shop
      console.log('📝 Registering webhooks for shop:', session.shop);
      try {
        const webhooksToRegister = [
          { topic: 'APP_UNINSTALLED', callbackUrl: '/webhooks' },
          { topic: 'ORDERS_CREATE', callbackUrl: '/webhooks' },
          { topic: 'ORDERS_UPDATED', callbackUrl: '/webhooks' },
          { topic: 'ORDERS_PAID', callbackUrl: '/webhooks' },
          { topic: 'ORDERS_FULFILLED', callbackUrl: '/webhooks' },
          { topic: 'CHECKOUTS_CREATE', callbackUrl: '/webhooks' },
          { topic: 'CHECKOUTS_UPDATE', callbackUrl: '/webhooks' },
          { topic: 'CUSTOMERS_CREATE', callbackUrl: '/webhooks' }
        ];
        
        const { GraphqlQueryError } = require('@shopify/shopify-api');
        const client = new shopify.api.clients.Graphql({ session });
        
        for (const webhook of webhooksToRegister) {
          try {
            const webhookUrl = `${process.env.SHOPIFY_APP_URL}${webhook.callbackUrl}`;
            console.log(`📌 Registering webhook: ${webhook.topic} -> ${webhookUrl}`);
            
            const response = await client.query({
              data: `
                mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
                  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
                    webhookSubscription {
                      id
                    }
                    userErrors {
                      field
                      message
                    }
                  }
                }
              `,
              variables: {
                topic: webhook.topic,
                webhookSubscription: {
                  callbackUrl: webhookUrl,
                  format: 'JSON'
                }
              }
            });
            
            if (response.body.data.webhookSubscriptionCreate.userErrors.length > 0) {
              console.warn(`⚠️ Webhook registration error for ${webhook.topic}:`, response.body.data.webhookSubscriptionCreate.userErrors);
            } else {
              console.log(`✅ Webhook registered: ${webhook.topic}`);
            }
          } catch (webhookError) {
            if (webhookError instanceof GraphqlQueryError) {
              console.warn(`⚠️ GraphQL error registering ${webhook.topic}:`, webhookError.response.errors);
            } else {
              console.warn(`⚠️ Error registering webhook ${webhook.topic}:`, webhookError.message);
            }
          }
        }
        
        console.log('✅ Webhook registration completed');
      } catch (error) {
        console.error('❌ Failed to register webhooks:', error);
        // Don't throw - webhook registration failure shouldn't prevent app installation
      }
    }
  },
  redirectToShopifyOrAppRoot() {
    // Redirect to embedded app URL with proper parameters
    return '/app?embedded=1';
  },
  sessionStorage,
  webhooks: {
    path: '/webhooks'
  },
});

module.exports = { shopify, sessionStorage };
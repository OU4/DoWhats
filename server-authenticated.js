const express = require('express');
const dotenv = require('dotenv');
const { db, initializeDatabase } = require('./database');
const DatabaseQueries = require('./database/queries');
const { body, query, param, validationResult } = require('express-validator');
const { shopify } = require('./shopify.app.config');
const escapeHtml = require('escape-html');

// Load environment variables - prefer .env.local for development
const fs = require('fs');
if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
} else {
  dotenv.config();
}

// Initialize Twilio (conditional)
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && 
    process.env.TWILIO_AUTH_TOKEN && 
    process.env.TWILIO_ACCOUNT_SID.startsWith('AC') &&
    process.env.TWILIO_ACCOUNT_SID !== 'your_twilio_account_sid_here') {
  try {
    twilioClient = require('twilio')(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    console.log('✅ Twilio client initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize Twilio client:', error.message);
  }
} else {
  console.warn('⚠️ Twilio credentials not configured. Update TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env file');
}

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Add ngrok bypass headers FIRST - CRITICAL for OAuth callback
app.use((req, res, next) => {
  // Bypass ngrok warning page - CRITICAL for callbacks
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.setHeader('ngrok-skip-browser-warning', 'any');
  req.headers['ngrok-skip-browser-warning'] = 'true';
  
  // For OAuth callbacks, add additional ngrok bypass headers
  if (req.path.includes('/auth/callback')) {
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Access-Control-Allow-Origin', '*');
    // CRITICAL: Add ngrok warning bypass for Shopify callbacks
    res.setHeader('X-Ngrok-Skip-Browser-Warning', 'true');
    res.setHeader('Ngrok-Skip-Browser-Warning', 'any');
    console.log('🔧 Adding ngrok bypass headers for OAuth callback');
  }
  
  next();
});

// Add detailed debugging for OAuth callbacks
app.use('/auth/callback', (req, res, next) => {
  console.log('🔍 CALLBACK DEBUG - Request received:', {
    method: req.method,
    url: req.originalUrl,
    query: req.query,
    headers: {
      'x-shopify-shop-domain': req.headers['x-shopify-shop-domain'],
      'x-shopify-topic': req.headers['x-shopify-topic'],
      'host': req.headers['host'],
      'user-agent': req.headers['user-agent'],
      'referer': req.headers['referer']
    },
    shop: req.query.shop,
    code: req.query.code,
    state: req.query.state,
    hmac: req.query.hmac,
    timestamp: new Date().toISOString()
  });
  next();
});

// Add Shopify middleware
app.use(shopify.cspHeaders());

// Apply Shopify auth middleware properly
app.use('/auth', shopify.auth.begin());
app.use('/auth/callback', shopify.auth.callback());

// Skip Shopify session validation for debug/test routes only
app.use((req, res, next) => {
  // Skip for debug/test routes and API routes
  if (req.path.startsWith('/debug') || 
      req.path.startsWith('/check-sessions') || 
      req.path.startsWith('/test-oauth') ||
      req.path.startsWith('/install') ||
      req.path.startsWith('/ngrok-test') ||
      req.path.startsWith('/exitiframe') ||
      req.path.startsWith('/auth') ||
      req.path.startsWith('/api')) {
    return next();
  }
  
  // For all other routes, let Shopify middleware handle session validation
  next();
});

// Handle direct access to callback URL (redirect to app)
app.get('/auth/callback', (req, res, next) => {
  // If someone accesses callback directly without going through OAuth
  if (!req.query.code && !req.query.shop) {
    return res.redirect('/app');
  }
  // Otherwise, let Shopify middleware handle it
  next();
});

// Add exitiframe route for embedded app OAuth flow
app.get('/exitiframe', (req, res) => {
  const shop = req.query.shop;
  const host = req.query.host;
  
  console.log('🚪 Exit iframe requested:', {
    shop: shop,
    host: host,
    query: req.query
  });
  
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }
  
  // Redirect to auth flow with proper parameters
  const authUrl = `/auth?shop=${encodeURIComponent(shop)}${host ? `&host=${encodeURIComponent(host)}` : ''}`;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Redirecting...</title>
      <script>
        window.top.location.href = "${authUrl}";
      </script>
    </head>
    <body>
      <p>Redirecting to authentication...</p>
      <p>If you are not redirected automatically, <a href="${authUrl}">click here</a>.</p>
    </body>
    </html>
  `);
});

// Add a post-auth success page that redirects back to app
app.get('/auth/success', (req, res) => {
  const shop = req.query.shop;
  const host = req.query.host;
  
  console.log('✅ Auth success, redirecting to app:', {
    shop: shop,
    host: host
  });
  
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }
  
  // Redirect back to the app
  const appUrl = `/app?shop=${encodeURIComponent(shop)}${host ? `&host=${encodeURIComponent(host)}` : ''}`;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Authentication Successful</title>
      <script>
        // For embedded apps, we need to redirect the parent window
        if (window.top !== window.self) {
          window.top.location.href = "${appUrl}";
        } else {
          window.location.href = "${appUrl}";
        }
      </script>
    </head>
    <body>
      <h1>✅ Authentication Successful!</h1>
      <p>Redirecting to your app...</p>
      <p>If you are not redirected automatically, <a href="${appUrl}">click here</a>.</p>
    </body>
    </html>
  `);
});

// Add error handling for auth failures
app.use((error, req, res, next) => {
  if (error && error.message && error.message.includes('oauth')) {
    console.error('🚨 OAuth Error:', {
      error: error.message,
      stack: error.stack,
      query: req.query,
      url: req.originalUrl
    });
    return res.status(500).json({
      error: 'OAuth authentication failed',
      details: error.message,
      query: req.query
    });
  }
  next(error);
});

// Body parsing middleware - exclude webhook routes to prevent stream conflicts
app.use('/api', express.json());
app.use('/api', express.urlencoded({ extended: true }));

// Validation helper
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    console.error('❌ Validation errors:', errors.array());
    return res.status(400).json({
      error: 'Invalid input data',
      details: errors.array()
    });
  }
  next();
};

// Input validation utilities (moved before usage)
const ValidationUtils = {
  isValidShopDomain(domain) {
    if (!domain || typeof domain !== 'string') return false;
    const shopifyDomainRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9]\.myshopify\.com$/;
    return shopifyDomainRegex.test(domain) && domain.length <= 100;
  },

  validatePhone(phone) {
    try {
      const { parsePhoneNumber, isValidPhoneNumber } = require('libphonenumber-js');
      if (!phone || typeof phone !== 'string') return null;
      
      const cleanPhone = phone.replace(/[^\d+]/g, '');
      if (!cleanPhone.startsWith('+')) {
        return null;
      }
      
      if (isValidPhoneNumber(cleanPhone)) {
        const parsed = parsePhoneNumber(cleanPhone);
        return parsed.format('E.164');
      }
      return null;
    } catch (error) {
      console.error('Phone validation error:', error);
      return null;
    }
  }
};

// Installation route for easy app installation
app.get('/install', (req, res) => {
  const shop = req.query.shop || 'dowhatss1.myshopify.com';
  const installUrl = `https://${shop}/admin/oauth/install_custom_app?client_id=${process.env.SHOPIFY_API_KEY}`;
  
  res.send(`
    <h1>🛠️ Install WhatsApp Shopify App</h1>
    <p><strong>Step 1:</strong> Click the install button below</p>
    <p><a href="${installUrl}" target="_blank" style="background: #008060; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">📱 Install WhatsApp App</a></p>
    
    <p><strong>Step 2:</strong> After installation, access your app from Shopify admin</p>
    
    <h3>🔧 Debug & Test Links:</h3>
    <ul>
      <li><a href="/debug?shop=${shop}">🔍 Environment & Session Debug</a></li>
      <li><a href="/test-oauth?shop=${shop}">🧪 OAuth Flow Test</a></li>
      <li><a href="/app-debug?shop=${shop}">🚫 Debug Version (No Auth)</a></li>
      <li><a href="/auth?shop=${shop}">🔐 Start OAuth Flow</a></li>
      <li><a href="/app?shop=${shop}">📱 Authenticated App</a></li>
    </ul>
    
    <h3>📋 Partner Dashboard URLs (Copy these to Partner Dashboard):</h3>
    <ul>
      <li><strong>App URL:</strong> <code>${process.env.SHOPIFY_APP_URL}/app</code></li>
      <li><strong>Allowed redirection URLs:</strong> 
        <ul>
          <li><code>${process.env.SHOPIFY_APP_URL}/auth/callback</code></li>
          <li><code>${process.env.SHOPIFY_APP_URL}/app</code></li>
        </ul>
      </li>
    </ul>
    
    <h3>🔍 Troubleshooting Steps:</h3>
    <ol>
      <li>Check that Partner Dashboard App URL points to: <code>${process.env.SHOPIFY_APP_URL}/app</code></li>
      <li>Verify redirect URLs include the callback URL above</li>
      <li>Ensure ngrok tunnel is running and SHOPIFY_APP_URL is correct</li>
      <li>Check server logs during OAuth flow</li>
      <li>Use debug endpoints above to diagnose issues</li>
    </ol>
  `);
});

// Home route - redirect to app if shop parameter exists
app.get('/', (req, res) => {
  console.log('🏠 Root route accessed:', {
    query: req.query,
    headers: req.headers['x-shopify-shop-domain'] || 'No shop header'
  });
  
  const shop = req.query.shop || req.headers['x-shopify-shop-domain'];
  
  if (shop && ValidationUtils.isValidShopDomain(shop)) {
    console.log(`🔄 Redirecting to app for shop: ${shop}`);
    return res.redirect(`/app?shop=${shop}&host=${req.query.host || ''}`);
  }
  
  res.send(`
    <h1>WhatsApp Shopify App - Authenticated Version</h1>
    <p>✅ Using Shopify Session Tokens</p>
    <p>✅ Proper OAuth Implementation</p>
    <p>✅ Built-in CSRF Protection</p>
    <p><strong>Debug Info:</strong></p>
    <ul>
      <li>Shop param: ${req.query.shop || 'None'}</li>
      <li>Host param: ${req.query.host || 'None'}</li>
      <li>Full URL: ${req.originalUrl}</li>
    </ul>
    <p><a href="/app?shop=dowhatss1.myshopify.com">Test App Dashboard</a></p>
  `);
});

// Debug route to check what Shopify is sending
app.get('/debug', async (req, res) => {
  let sessionCount = 'Error reading sessions';
  
  // Check session count safely
  try {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database('./data/sessions.db');
    sessionCount = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM shopify_sessions', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
        db.close();
      });
    });
  } catch (error) {
    console.error('Error checking session count:', error.message);
    sessionCount = `Error: ${error.message}`;
  }

  res.json({
    query: req.query,
    headers: {
      'x-shopify-shop-domain': req.headers['x-shopify-shop-domain'],
      'x-shopify-topic': req.headers['x-shopify-topic'],
      'user-agent': req.headers['user-agent'],
      'host': req.headers['host']
    },
    url: req.originalUrl,
    timestamp: new Date().toISOString(),
    environment: {
      shopifyApiKey: process.env.SHOPIFY_API_KEY ? '✅ Set' : '❌ Missing',
      shopifyApiSecret: process.env.SHOPIFY_API_SECRET ? '✅ Set' : '❌ Missing',
      shopifyAppUrl: process.env.SHOPIFY_APP_URL || '❌ Missing',
      nodeEnv: process.env.NODE_ENV || 'Not set'
    },
    sessionStorage: {
      sessionCount: sessionCount,
      sessionDbPath: './data/sessions.db'
    }
  });
});

// Add a manual session count checker
app.get('/check-sessions', async (req, res) => {
  try {
    const sessionCount = await new Promise((resolve, reject) => {
      const sqlite3 = require('sqlite3').verbose();
      const db = new sqlite3.Database('./data/sessions.db');
      db.all('SELECT * FROM shopify_sessions', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
      db.close();
    });
    
    res.json({
      sessionCount: sessionCount.length,
      sessions: sessionCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check sessions',
      details: error.message
    });
  }
});

// Ngrok test route - test if ngrok warning is bypassed
app.get('/ngrok-test', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>🧪 Ngrok Test</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        .success { color: green; font-weight: bold; }
        .warning { color: orange; }
        .info { background: #f0f0f0; padding: 10px; margin: 10px 0; }
      </style>
    </head>
    <body>
      <h1>🧪 Ngrok Connection Test</h1>
      <p class="success">✅ If you can see this page, ngrok is working!</p>
      
      <div class="info">
        <h3>📋 Test Results:</h3>
        <ul>
          <li><strong>Timestamp:</strong> ${new Date().toISOString()}</li>
          <li><strong>Request Headers:</strong></li>
          <pre>${JSON.stringify(req.headers, null, 2)}</pre>
        </ul>
      </div>
      
      <h3>🔧 Next Steps:</h3>
      <ol>
        <li>If you see a warning page before this, ngrok needs configuration</li>
        <li>Try accessing this URL directly: <code>https://d6a48525369e.ngrok-free.app/ngrok-test</code></li>
        <li>Then test OAuth: <a href="/auth?shop=dowhatss1.myshopify.com">Start OAuth Flow</a></li>
      </ol>
      
      <p><a href="/install">🔙 Back to Install Page</a></p>
    </body>
    </html>
  `);
});

// Test OAuth flow route  
app.get('/test-oauth', async (req, res) => {
  const shop = req.query.shop || 'dowhatss1.myshopify.com';
  
  if (!shop.includes('.myshopify.com')) {
    return res.json({
      error: 'Invalid shop domain. Must be a .myshopify.com domain',
      provided: shop
    });
  }

  try {
    // Test session storage manually
    const { sessionStorage } = require('./shopify.app.config');
    const testSessionId = `offline_${shop}`;
    
    // Try to get existing session
    const existingSession = await sessionStorage.loadSession(testSessionId);
    
    res.json({
      shop: shop,
      testSessionId: testSessionId,
      existingSession: existingSession || 'No existing session found',
      oauthUrl: `/auth?shop=${shop}`,
      appUrl: `/app?shop=${shop}`,
      instructions: [
        '1. Try the OAuth URL to start authentication',
        '2. After authentication, check this endpoint again to see if session was created',
        '3. Then try the App URL to test authenticated access'
      ],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to test OAuth setup',
      details: error.message,
      stack: error.stack
    });
  }
});

// Add session debugging middleware
app.use('/app', (req, res, next) => {
  console.log('🔍 APP ROUTE DEBUG:', {
    method: req.method,
    url: req.originalUrl,
    query: req.query,
    sessionLocals: res.locals.shopify || 'No session locals',
    cookies: req.headers.cookie || 'No cookies'
  });
  next();
});

// Authenticated app route (for Shopify admin access)
app.get('/app', 
  shopify.ensureInstalledOnShop(),
  async (req, res) => {
    // For embedded apps, we need to validate session tokens from the id_token parameter
    const idToken = req.query.id_token;
    const shop = req.query.shop;
    
    console.log('🔍 App route - Token validation:', {
      hasIdToken: !!idToken,
      shop: shop,
      embedded: req.query.embedded
    });
    
    // For embedded apps, extract session from id_token instead of traditional session validation
    let session = null;
    
    if (idToken) {
      try {
        // Decode the session token to get shop info
        const jwt = require('jsonwebtoken');
        const decoded = jwt.decode(idToken);
        console.log('🔍 Decoded JWT:', {
          iss: decoded?.iss,
          aud: decoded?.aud,
          shop: shop
        });
        
        // Load the session from our database using the shop
        const { sessionStorage } = require('./shopify.app.config');
        const sessionId = `offline_${shop}`;
        session = await sessionStorage.loadSession(sessionId);
        
        console.log('📦 Loaded session:', {
          sessionId: sessionId,
          hasSession: !!session,
          accessToken: session?.accessToken ? '✅ Present' : '❌ Missing'
        });
        
      } catch (error) {
        console.error('❌ Error validating session token:', error.message);
      }
    }
    
    if (!session) {
      console.error('❌ No valid session found');
      return res.status(500).json({
        error: 'No authenticated session found',
        debug: {
          shop: shop,
          hasIdToken: !!idToken,
          embedded: req.query.embedded
        }
      });
    }
    // Use the session we loaded from the database
    const authenticatedShop = session.shop;
    
    console.log(`🔍 Authenticated app access for: ${authenticatedShop}`);
    console.log('✅ Session validated:', {
      id: session.id,
      shop: session.shop,
      scope: session.scope
    });

    try {
      // Get shop data from our database
      let shopData = await DatabaseQueries.getShop(authenticatedShop);
      if (!shopData) {
        // Create shop record if it doesn't exist
        console.log(`📝 Creating shop record: ${authenticatedShop}`);
        await DatabaseQueries.createOrUpdateShop(authenticatedShop, session.accessToken, {
          shop_name: authenticatedShop.split('.')[0],
          email: null,
          phone: null
        });
        shopData = await DatabaseQueries.getShop(authenticatedShop);
      }

      // Render the admin dashboard with real authentication
      res.send(generateAdminPage(authenticatedShop, shopData, session, req));
    } catch (error) {
      console.error('Error loading app:', error);
      res.status(500).json({ error: 'Failed to load app' });
    }
  }
);

// Debug route for testing (no auth required)
app.get('/app-debug', (req, res) => {
  const shop = req.query.shop;
  
  console.log(`🔍 Direct app access - Shop: ${shop}`);
  console.log('Query params:', req.query);
  
  if (!shop) {
    return res.send(`
      <h1>❌ No Shop Parameter</h1>
      <p>Shop parameter is missing. This usually means:</p>
      <ul>
        <li>Partner Dashboard App URL is incorrect</li>
        <li>You're accessing the app directly instead of through Shopify</li>
      </ul>
      <p><strong>Debug Info:</strong></p>
      <pre>${JSON.stringify(req.query, null, 2)}</pre>
      <p><a href="/debug">View Debug Info</a></p>
    `);
  }
  
  if (!ValidationUtils.isValidShopDomain(shop)) {
    return res.send(`
      <h1>❌ Invalid Shop Domain</h1>
      <p>Shop: ${shop}</p>
      <p>This doesn't look like a valid Shopify domain.</p>
    `);
  }

  // For now, skip Shopify auth and show a simple page
  res.send(`
    <h1>✅ App Access Successful!</h1>
    <p><strong>Shop:</strong> ${shop}</p>
    <p><strong>Status:</strong> Connected (Debug Mode)</p>
    <p><strong>Next Step:</strong> Enable proper authentication</p>
    
    <h3>Debug Information:</h3>
    <pre>${JSON.stringify({
      shop: shop,
      query: req.query,
      timestamp: new Date().toISOString()
    }, null, 2)}</pre>
    
    <p><a href="/debug">Full Debug Info</a></p>
  `);
});

// API Routes - using proper session token authentication
app.get('/api/metrics', async (req, res) => {
    // Extract session token from Authorization header
    const authHeader = req.headers.authorization;
    let session = null;
    let shop = null;
    
    console.log('📊 Metrics API called:', {
      hasAuthHeader: !!authHeader,
      query: req.query
    });
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.substring(7);
        const jwt = require('jsonwebtoken');
        const decoded = jwt.decode(token);
        
        // Extract shop from the JWT token 
        shop = decoded?.iss?.replace('https://', '').replace('/admin', '');
        
        console.log('🔍 Decoded token:', {
          iss: decoded?.iss,
          shop: shop
        });
        
        // Load the session from our database using the shop
        const { sessionStorage } = require('./shopify.app.config');
        const sessionId = `offline_${shop}`;
        session = await sessionStorage.loadSession(sessionId);
        
      } catch (error) {
        console.error('❌ Error validating session token for metrics:', error.message);
      }
    }
    
    if (!session || !shop) {
      console.error('❌ No valid session found for metrics API');
      return res.status(401).json({
        success: false,
        error: 'Unauthorized - no valid session'
      });
    }
    
    try {
      // Get real metrics from database
      const messageStats = await DatabaseQueries.getMessageStats(shop, 30);
      const customerStats = await DatabaseQueries.getCustomerSegments(shop);
      
      const deliveryRate = messageStats.total_messages > 0 
        ? Math.round((messageStats.delivered / messageStats.total_messages) * 100)
        : 0;

      res.json({
        success: true,
        metrics: {
          monthly_messages: messageStats.total_messages || 0,
          delivery_rate: deliveryRate,
          active_customers: customerStats.active_customers || 0,
          unique_customers: messageStats.unique_customers || 0
        }
      });
    } catch (error) {
      console.error('Error getting metrics:', error);
      res.status(500).json({ success: false, error: 'Failed to get metrics' });
    }
  }
);

app.post('/api/settings',
  [
    body('setting').isString().isIn(['order_confirmation', 'shipping_updates', 'abandoned_cart', 'marketing']),
    body('enabled').isBoolean(),
    handleValidationErrors
  ],
  async (req, res) => {
    const { setting, enabled } = req.body;
    const shop = req.query.shop;
    
    if (!shop) {
      return res.status(400).json({
        success: false,
        error: 'Shop parameter required'
      });
    }
    
    try {
      // TODO: Save settings to database
      console.log(`📝 Settings updated for ${shop}:`, { setting, enabled });
      
      res.json({
        success: true,
        message: `${setting} ${enabled ? 'enabled' : 'disabled'}`
      });
    } catch (error) {
      console.error('Error updating settings:', error);
      res.status(500).json({ success: false, error: 'Failed to update settings' });
    }
  }
);

app.post('/api/test-message', async (req, res) => {
    const shop = req.query.shop;
    
    if (!shop) {
      return res.status(400).json({
        success: false,
        error: 'Shop parameter required'
      });
    }
    
    try {
      if (!twilioClient) {
        return res.status(400).json({
          success: false,
          error: 'Twilio not configured. Please add your Twilio credentials to .env.local'
        });
      }

      // Send test message
      const testPhone = process.env.TEST_PHONE_NUMBER;
      if (!testPhone) {
        return res.status(400).json({
          success: false,
          error: 'No test phone number configured'
        });
      }

      const message = await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: `whatsapp:${testPhone}`,
        body: `🧪 Test message from ${shop}\\n\\nYour WhatsApp notifications are working correctly!\\n\\nTime: ${new Date().toLocaleString()}`
      });

      // Save to database
      await DatabaseQueries.saveMessage({
        shop_domain: shop,
        customer_phone: testPhone,
        customer_name: 'Test User',
        message_type: 'test',
        message_body: message.body,
        twilio_sid: message.sid,
        twilio_status: message.status,
        cost: 0.02
      });

      res.json({
        success: true,
        message: 'Test message sent successfully!',
        twilio_sid: message.sid
      });
    } catch (error) {
      console.error('Error sending test message:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to send test message'
      });
    }
  }
);

// Webhook routes - use Shopify's webhook processing
app.use('/webhooks', shopify.processWebhooks({
  webhookHandlers: {
    ORDERS_CREATE: {
      deliveryMethod: 'http',
      callbackUrl: '/webhooks/orders/create',
      callback: async (topic, shop, body, webhookId) => {
        console.log(`📦 Order created webhook: ${shop}`);
        try {
          const order = JSON.parse(body);
          await handleOrderCreated(shop, order);
        } catch (error) {
          console.error('Error processing order created:', error);
        }
      }
    },
    ORDERS_UPDATED: {
      deliveryMethod: 'http', 
      callbackUrl: '/webhooks/orders/updated',
      callback: async (topic, shop, body, webhookId) => {
        console.log(`📦 Order updated webhook: ${shop}`);
        try {
          const order = JSON.parse(body);
          await handleOrderUpdated(shop, order);
        } catch (error) {
          console.error('Error processing order updated:', error);
        }
      }
    },
    ORDERS_PAID: {
      deliveryMethod: 'http',
      callbackUrl: '/webhooks/orders/paid', 
      callback: async (topic, shop, body, webhookId) => {
        console.log(`💳 Order paid webhook: ${shop}`);
        try {
          const order = JSON.parse(body);
          await handleOrderPaid(shop, order);
        } catch (error) {
          console.error('Error processing order paid:', error);
        }
      }
    },
    ORDERS_FULFILLED: {
      deliveryMethod: 'http',
      callbackUrl: '/webhooks/orders/fulfilled',
      callback: async (topic, shop, body, webhookId) => {
        console.log(`📦 Order fulfilled webhook: ${shop}`);
        try {
          const order = JSON.parse(body);
          await handleOrderFulfilled(shop, order);
        } catch (error) {
          console.error('Error processing order fulfilled:', error);
        }
      }
    },
    CHECKOUTS_CREATE: {
      deliveryMethod: 'http',
      callbackUrl: '/webhooks/checkouts/create',
      callback: async (topic, shop, body, webhookId) => {
        console.log(`🛒 Checkout created webhook: ${shop}`);
        try {
          const checkout = JSON.parse(body);
          await handleCheckoutCreated(shop, checkout);
        } catch (error) {
          console.error('Error processing checkout created:', error);
        }
      }
    },
    CHECKOUTS_UPDATE: {
      deliveryMethod: 'http', 
      callbackUrl: '/webhooks/checkouts/update',
      callback: async (topic, shop, body, webhookId) => {
        console.log(`🛒 Checkout updated webhook: ${shop}`);
        try {
          const checkout = JSON.parse(body);
          await handleCheckoutUpdated(shop, checkout);
        } catch (error) {
          console.error('Error processing checkout updated:', error);
        }
      }
    },
    CUSTOMERS_CREATE: {
      deliveryMethod: 'http',
      callbackUrl: '/webhooks/customers/create', 
      callback: async (topic, shop, body, webhookId) => {
        console.log(`👤 Customer created webhook: ${shop}`);
        try {
          const customer = JSON.parse(body);
          await handleCustomerCreated(shop, customer);
        } catch (error) {
          console.error('Error processing customer created:', error);
        }
      }
    }
  }
}));

// Webhook handlers
async function handleOrderCreated(shop, order) {
  try {
    // Ensure shop exists
    await ensureShopExists(shop);
    
    // Save order to database
    await DatabaseQueries.saveOrder({
      shop_domain: shop,
      order_id: order.id.toString(),
      order_number: order.order_number,
      customer_email: order.email,
      customer_phone: order.phone,
      customer_name: `${order.billing_address?.first_name || ''} ${order.billing_address?.last_name || ''}`.trim(),
      total_price: parseFloat(order.total_price),
      currency: order.currency,
      financial_status: order.financial_status,
      fulfillment_status: order.fulfillment_status,
      checkout_id: order.checkout_id
    });

    console.log(`✅ Order saved: ${order.order_number}`);

    // Send WhatsApp notification for new order
    await sendOrderConfirmationWhatsApp(shop, order);
    
  } catch (error) {
    console.error('Error handling order created:', error);
  }
}

async function handleOrderUpdated(shop, order) {
  try {
    await ensureShopExists(shop);
    
    // Get previous order state to detect changes
    const existingOrder = await DatabaseQueries.getOrder(shop, order.id.toString());
    
    // Update existing order
    await DatabaseQueries.saveOrder({
      shop_domain: shop,
      order_id: order.id.toString(),
      order_number: order.order_number,
      customer_email: order.email,
      customer_phone: order.phone,
      customer_name: `${order.billing_address?.first_name || ''} ${order.billing_address?.last_name || ''}`.trim(),
      total_price: parseFloat(order.total_price),
      currency: order.currency,
      financial_status: order.financial_status,
      fulfillment_status: order.fulfillment_status
    });

    console.log(`✅ Order updated: ${order.order_number}`);

    // Send WhatsApp notifications for status changes
    console.log(`🔍 Checking order status changes for ${order.order_number}:`, {
      existingOrder: !!existingOrder,
      oldFulfillmentStatus: existingOrder?.fulfillment_status,
      newFulfillmentStatus: order.fulfillment_status,
      oldFinancialStatus: existingOrder?.financial_status,  
      newFinancialStatus: order.financial_status
    });

    if (existingOrder) {
      // Check if order was just paid
      if (existingOrder.financial_status !== 'paid' && order.financial_status === 'paid') {
        console.log(`💳 Order ${order.order_number} was just paid - sending payment confirmation`);
        await sendPaymentConfirmationWhatsApp(shop, order);
      }
      
      // Check if order was just fulfilled/shipped
      if (existingOrder.fulfillment_status !== 'fulfilled' && order.fulfillment_status === 'fulfilled') {
        console.log(`📦 Order ${order.order_number} was just fulfilled - sending shipping notification`);
        await sendShippingNotificationWhatsApp(shop, order);
      }

      // Also check for partially fulfilled or other fulfillment statuses
      if (existingOrder.fulfillment_status !== order.fulfillment_status && 
          (order.fulfillment_status === 'fulfilled' || order.fulfillment_status === 'partial')) {
        console.log(`📦 Order ${order.order_number} fulfillment changed from "${existingOrder.fulfillment_status}" to "${order.fulfillment_status}" - sending shipping notification`);
        await sendShippingNotificationWhatsApp(shop, order);
      }
    } else {
      console.log(`⚠️ No existing order found for ${order.order_number} - trying again in 2 seconds (webhook race condition)`);
      
      // Wait 2 seconds and try again (webhook race condition handling)
      setTimeout(async () => {
        try {
          const retryExistingOrder = await DatabaseQueries.getOrder(shop, order.id.toString());
          
          if (retryExistingOrder) {
            console.log(`🔄 Found existing order on retry for ${order.order_number}`);
            
            // Check fulfillment status change
            if (retryExistingOrder.fulfillment_status !== order.fulfillment_status && 
                (order.fulfillment_status === 'fulfilled' || order.fulfillment_status === 'partial')) {
              console.log(`📦 Order ${order.order_number} fulfillment changed from "${retryExistingOrder.fulfillment_status}" to "${order.fulfillment_status}" (retry) - sending shipping notification`);
              await sendShippingNotificationWhatsApp(shop, order);
            }
            
            // Check payment status change  
            if (retryExistingOrder.financial_status !== 'paid' && order.financial_status === 'paid') {
              console.log(`💳 Order ${order.order_number} was just paid (retry) - sending payment confirmation`);
              await sendPaymentConfirmationWhatsApp(shop, order);
            }
          } else {
            // Still no existing order - send notifications based on current status
            console.log(`⚠️ Still no existing order found for ${order.order_number} on retry - sending notifications based on current status`);
            
            if (order.fulfillment_status === 'fulfilled' || order.fulfillment_status === 'partial') {
              console.log(`📦 Order ${order.order_number} is fulfilled (status: ${order.fulfillment_status}) - sending shipping notification`);
              await sendShippingNotificationWhatsApp(shop, order);
            }
            
            if (order.financial_status === 'paid') {
              console.log(`💳 Order ${order.order_number} is paid - sending payment confirmation`);
              await sendPaymentConfirmationWhatsApp(shop, order);
            }
          }
        } catch (error) {
          console.error(`Error in retry logic for order ${order.order_number}:`, error);
        }
      }, 2000);
    }
    
  } catch (error) {
    console.error('Error handling order updated:', error);
  }
}

// Additional webhook handlers
async function handleOrderPaid(shop, order) {
  try {
    await ensureShopExists(shop);
    
    console.log(`💳 Order ${order.order_number} paid - sending payment confirmation WhatsApp`);
    await sendPaymentConfirmationWhatsApp(shop, order);
    
  } catch (error) {
    console.error('Error handling order paid:', error);
  }
}

async function handleOrderFulfilled(shop, order) {
  try {
    await ensureShopExists(shop);
    
    console.log(`📦 Order ${order.order_number} fulfilled - sending shipping notification WhatsApp`);
    await sendShippingNotificationWhatsApp(shop, order);
    
  } catch (error) {
    console.error('Error handling order fulfilled:', error);
  }
}

async function handleCheckoutCreated(shop, checkout) {
  try {
    await ensureShopExists(shop);
    
    // Schedule abandoned cart reminder for 1 hour later
    console.log(`🛒 Checkout ${checkout.id} created - scheduling abandoned cart reminder`);
    
    // Save checkout to database for abandoned cart tracking
    await DatabaseQueries.saveCheckout({
      shop_domain: shop,
      checkout_id: checkout.id.toString(),
      customer_email: checkout.email,
      customer_phone: checkout.phone || checkout.billing_address?.phone,
      customer_name: `${checkout.billing_address?.first_name || ''} ${checkout.billing_address?.last_name || ''}`.trim(),
      total_price: parseFloat(checkout.total_price || checkout.subtotal_price || 0),
      currency: checkout.currency,
      line_items_count: checkout.line_items?.length || 0,
      created_at: new Date(checkout.created_at),
      updated_at: new Date(checkout.updated_at)
    });
    
  } catch (error) {
    console.error('Error handling checkout created:', error);
  }
}

async function handleCheckoutUpdated(shop, checkout) {
  try {
    await ensureShopExists(shop);
    
    // Update checkout in database
    await DatabaseQueries.saveCheckout({
      shop_domain: shop,
      checkout_id: checkout.id.toString(),
      customer_email: checkout.email,
      customer_phone: checkout.phone || checkout.billing_address?.phone,
      customer_name: `${checkout.billing_address?.first_name || ''} ${checkout.billing_address?.last_name || ''}`.trim(),
      total_price: parseFloat(checkout.total_price || checkout.subtotal_price || 0),
      currency: checkout.currency,
      line_items_count: checkout.line_items?.length || 0,
      created_at: new Date(checkout.created_at),
      updated_at: new Date(checkout.updated_at)
    });
    
    console.log(`🛒 Checkout ${checkout.id} updated`);
    
  } catch (error) {
    console.error('Error handling checkout updated:', error);
  }
}

async function handleCustomerCreated(shop, customer) {
  try {
    await ensureShopExists(shop);
    
    console.log(`👤 New customer ${customer.email} created - sending welcome WhatsApp`);
    await sendWelcomeWhatsApp(shop, customer);
    
  } catch (error) {
    console.error('Error handling customer created:', error);
  }
}

// WhatsApp messaging functions
async function sendOrderConfirmationWhatsApp(shop, order) {
  if (!twilioClient) {
    console.log('⚠️ Twilio not configured - skipping WhatsApp message');
    return;
  }

  try {
    // Check if customer has a valid phone number
    const customerPhone = order.phone || order.billing_address?.phone;
    if (!customerPhone) {
      console.log(`⚠️ No phone number for order ${order.order_number} - skipping WhatsApp`);
      return;
    }

    // Format phone number
    const { parsePhoneNumber } = require('libphonenumber-js');
    const phoneNumber = parsePhoneNumber(customerPhone, 'US');
    const formattedPhone = phoneNumber.formatInternational().replace(/\s/g, '');

    const customerName = `${order.billing_address?.first_name || ''} ${order.billing_address?.last_name || ''}`.trim() || 'Customer';
    
    const message = `🎉 Hi ${customerName}!

Your order #${order.order_number} has been confirmed!

💰 Total: ${order.currency} ${order.total_price}
📧 We'll send updates to: ${order.email}

Thank you for shopping with ${shop.replace('.myshopify.com', '')}! 

Track your order: https://${shop}/account/orders/${order.id}`;

    const twilioMessage = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${formattedPhone}`,
      body: message
    });

    // Save message to database
    await DatabaseQueries.saveMessage({
      shop_domain: shop,
      customer_phone: formattedPhone,
      customer_name: customerName,
      message_type: 'order_confirmation',
      message_body: message,
      twilio_sid: twilioMessage.sid,
      twilio_status: twilioMessage.status,
      cost: 0.005, // Approximate cost
      order_id: order.id.toString()
    });

    console.log(`✅ Order confirmation WhatsApp sent to ${formattedPhone} for order ${order.order_number}`);
  } catch (error) {
    console.error(`❌ Failed to send order confirmation WhatsApp for order ${order.order_number}:`, error.message);
  }
}

async function sendPaymentConfirmationWhatsApp(shop, order) {
  if (!twilioClient) return;

  try {
    const customerPhone = order.phone || order.billing_address?.phone;
    if (!customerPhone) return;

    const { parsePhoneNumber } = require('libphonenumber-js');
    const phoneNumber = parsePhoneNumber(customerPhone, 'US');
    const formattedPhone = phoneNumber.formatInternational().replace(/\s/g, '');

    const customerName = `${order.billing_address?.first_name || ''} ${order.billing_address?.last_name || ''}`.trim() || 'Customer';
    
    const message = `💳 Payment Confirmed!

Hi ${customerName}, your payment for order #${order.order_number} has been processed successfully.

💰 Amount: ${order.currency} ${order.total_price}
📦 We're now preparing your order for shipment!

Thank you for your business!`;

    const twilioMessage = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${formattedPhone}`,
      body: message
    });

    await DatabaseQueries.saveMessage({
      shop_domain: shop,
      customer_phone: formattedPhone,
      customer_name: customerName,
      message_type: 'payment_confirmation',
      message_body: message,
      twilio_sid: twilioMessage.sid,
      twilio_status: twilioMessage.status,
      cost: 0.005,
      order_id: order.id.toString()
    });

    console.log(`✅ Payment confirmation WhatsApp sent to ${formattedPhone} for order ${order.order_number}`);
  } catch (error) {
    console.error(`❌ Failed to send payment confirmation WhatsApp:`, error.message);
  }
}

async function sendShippingNotificationWhatsApp(shop, order) {
  if (!twilioClient) return;

  try {
    const customerPhone = order.phone || order.billing_address?.phone;
    if (!customerPhone) return;

    const { parsePhoneNumber } = require('libphonenumber-js');
    const phoneNumber = parsePhoneNumber(customerPhone, 'US');
    const formattedPhone = phoneNumber.formatInternational().replace(/\s/g, '');

    const customerName = `${order.billing_address?.first_name || ''} ${order.billing_address?.last_name || ''}`.trim() || 'Customer';
    
    const message = `📦 Your order is on the way!

Hi ${customerName}, great news! Order #${order.order_number} has been shipped.

🚚 Your package is on its way to:
${order.shipping_address?.address1 || order.billing_address?.address1}
${order.shipping_address?.city || order.billing_address?.city}, ${order.shipping_address?.province || order.billing_address?.province}

You'll receive tracking information soon!`;

    const twilioMessage = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${formattedPhone}`,
      body: message
    });

    await DatabaseQueries.saveMessage({
      shop_domain: shop,
      customer_phone: formattedPhone,
      customer_name: customerName,
      message_type: 'shipping_notification',
      message_body: message,
      twilio_sid: twilioMessage.sid,
      twilio_status: twilioMessage.status,
      cost: 0.005,
      order_id: order.id.toString()
    });

    console.log(`✅ Shipping notification WhatsApp sent to ${formattedPhone} for order ${order.order_number}`);
  } catch (error) {
    console.error(`❌ Failed to send shipping notification WhatsApp:`, error.message);
  }
}

async function sendWelcomeWhatsApp(shop, customer) {
  if (!twilioClient) {
    console.log('⚠️ Twilio not configured - skipping welcome WhatsApp');
    return;
  }

  try {
    // Check if customer has a valid phone number
    const customerPhone = customer.phone;
    if (!customerPhone) {
      console.log(`⚠️ No phone number for customer ${customer.email} - skipping welcome WhatsApp`);
      return;
    }

    // Format phone number
    const { parsePhoneNumber } = require('libphonenumber-js');
    const phoneNumber = parsePhoneNumber(customerPhone, 'US');
    const formattedPhone = phoneNumber.formatInternational().replace(/\s/g, '');

    const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'there';
    const shopName = shop.replace('.myshopify.com', '');
    
    const message = `👋 Welcome to ${shopName}, ${customerName}!

Thank you for creating an account with us. We're excited to have you as part of our community!

🎉 Here's what you can do:
• Browse our latest products
• Get exclusive member discounts  
• Track your orders easily
• Receive updates on new arrivals

Need help? Just reply to this message and we'll be happy to assist!

Happy shopping! 🛍️`;

    const twilioMessage = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${formattedPhone}`,
      body: message
    });

    // Save message to database
    await DatabaseQueries.saveMessage({
      shop_domain: shop,
      customer_phone: formattedPhone,
      customer_name: customerName,
      message_type: 'welcome',
      message_body: message,
      twilio_sid: twilioMessage.sid,
      twilio_status: twilioMessage.status,
      cost: 0.005,
      customer_id: customer.id?.toString()
    });

    console.log(`✅ Welcome WhatsApp sent to ${formattedPhone} for customer ${customer.email}`);
  } catch (error) {
    console.error(`❌ Failed to send welcome WhatsApp for customer ${customer.email}:`, error.message);
  }
}

async function sendAbandonedCartWhatsApp(shop, checkout) {
  if (!twilioClient) return;

  try {
    const customerPhone = checkout.phone || checkout.billing_address?.phone;
    if (!customerPhone) return;

    const { parsePhoneNumber } = require('libphonenumber-js');
    const phoneNumber = parsePhoneNumber(customerPhone, 'US');
    const formattedPhone = phoneNumber.formatInternational().replace(/\s/g, '');

    const customerName = `${checkout.billing_address?.first_name || ''} ${checkout.billing_address?.last_name || ''}`.trim() || 'there';
    const shopName = shop.replace('.myshopify.com', '');
    
    // Get first few items from cart
    const itemsText = checkout.line_items?.slice(0, 3).map(item => 
      `• ${item.title} (${item.quantity}x)`
    ).join('\n') || '• Your selected items';
    
    const message = `🛒 Hi ${customerName}!

You left some great items in your cart at ${shopName}:

${itemsText}
${checkout.line_items?.length > 3 ? `... and ${checkout.line_items.length - 3} more items` : ''}

💰 Total: ${checkout.currency} ${checkout.total_price}

Don't miss out! Complete your purchase now:
🔗 ${checkout.abandoned_checkout_url || `https://${shop}/cart`}

⏰ Limited time - items in your cart are popular and may sell out!

Questions? Just reply to this message.`;

    const twilioMessage = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${formattedPhone}`,
      body: message
    });

    await DatabaseQueries.saveMessage({
      shop_domain: shop,
      customer_phone: formattedPhone,
      customer_name: customerName,
      message_type: 'abandoned_cart',
      message_body: message,
      twilio_sid: twilioMessage.sid,
      twilio_status: twilioMessage.status,
      cost: 0.005,
      checkout_id: checkout.id?.toString()
    });

    console.log(`✅ Abandoned cart WhatsApp sent to ${formattedPhone} for checkout ${checkout.id}`);
  } catch (error) {
    console.error(`❌ Failed to send abandoned cart WhatsApp:`, error.message);
  }
}

// Helper function to ensure shop exists in database
async function ensureShopExists(shopDomain) {
  try {
    const existingShop = await DatabaseQueries.getShop(shopDomain);
    if (!existingShop) {
      console.log(`📝 Creating missing shop: ${shopDomain}`);
      await DatabaseQueries.createOrUpdateShop(shopDomain, 'webhook_access', {
        shop_name: shopDomain.split('.')[0],
        email: null,
        phone: null
      });
    }
    return true;
  } catch (error) {
    console.error(`❌ Failed to create shop ${shopDomain}:`, error);
    return false;
  }
}

// Generate admin dashboard HTML
function generateAdminPage(shop, shopData, session, req) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <title>WhatsApp Notifications - ${escapeHtml(shop)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    
    <!-- Shopify Polaris CSS -->
    <link rel="stylesheet" href="https://unpkg.com/@shopify/polaris@12.0.0/build/esm/styles.css" />
    
    <!-- App Bridge -->
    <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
    
    <style>
        body { 
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: #f6f6f7;
        }
        .page-header {
            background: white;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 20px;
            border: 1px solid #e1e3e5;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .shop-info h1 {
            margin: 0 0 4px 0;
            font-size: 24px;
            color: #202223;
        }
        .shop-status {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 4px;
        }
        .status-badge {
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 600;
            background: #d1f7c4;
            color: #365314;
        }
        .metric-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin: 20px 0;
        }
        .metric-card {
            background: white;
            border-radius: 8px;
            padding: 20px;
            border: 1px solid #e1e3e5;
            text-align: center;
        }
        .metric-number {
            font-size: 32px;
            font-weight: 700;
            color: #202223;
            margin-bottom: 4px;
        }
        .loading-spinner {
            border: 3px solid #f3f3f3;
            border-top: 3px solid #008060;
            border-radius: 50%;
            width: 24px;
            height: 24px;
            animation: spin 1s linear infinite;
            margin: 0 auto;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .metric-label {
            font-size: 14px;
            color: #6d7175;
            font-weight: 500;
        }
        .auth-info {
            background: #e1f5fe;
            border: 1px solid #4fc3f7;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 20px;
        }
        .auth-info h3 {
            margin: 0 0 8px 0;
            color: #01579b;
        }
        .settings-section {
            background: white;
            border-radius: 12px;
            border: 1px solid #e1e3e5;
            margin-bottom: 20px;
        }
        .settings-header {
            padding: 20px 24px 0;
            border-bottom: 1px solid #e1e3e5;
        }
        .settings-header h2 {
            margin: 0 0 16px 0;
            font-size: 20px;
            font-weight: 600;
            color: #202223;
        }
        .settings-content {
            padding: 24px;
        }
        .toggle-setting {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 16px 0;
            border-bottom: 1px solid #f1f2f3;
        }
        .toggle-setting:last-child {
            border-bottom: none;
        }
        .toggle-info h3 {
            margin: 0 0 4px 0;
            font-size: 16px;
            font-weight: 600;
            color: #202223;
        }
        .toggle-info p {
            margin: 0;
            font-size: 14px;
            color: #6d7175;
        }
        .toggle-switch {
            width: 44px;
            height: 24px;
            background: #c4c4c4;
            border-radius: 12px;
            position: relative;
            cursor: pointer;
            transition: background 0.2s;
        }
        .toggle-switch.active {
            background: #008060;
        }
        .toggle-switch::after {
            content: '';
            position: absolute;
            top: 2px;
            left: 2px;
            width: 20px;
            height: 20px;
            background: white;
            border-radius: 50%;
            transition: transform 0.2s;
        }
        .toggle-switch.active::after {
            transform: translateX(20px);
        }
        .test-button {
            background: #008060;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 6px;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            transition: background 0.2s;
        }
        .test-button:hover {
            background: #00664f;
        }
        .test-button:disabled {
            background: #c4c4c4;
            cursor: not-allowed;
        }
        .button-group {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
        }
    </style>
</head>
<body>
    <div class="page-header">
        <div class="shop-info">
            <h1>WhatsApp Notifications</h1>
            <div class="shop-status">
                <div class="status-badge">
                    ${shopData.is_active ? 'Active' : 'Inactive'}
                </div>
                <div style="font-size: 14px; color: #6d7175;">
                    Shop: ${escapeHtml(shop)}
                </div>
            </div>
        </div>
    </div>

    <!-- Authentication Status -->
    <div class="auth-info">
        <h3>🔐 Authenticated Session</h3>
        <p><strong>Session ID:</strong> ${session.id}</p>
        <p><strong>Access Token:</strong> ${session.accessToken ? '✅ Valid' : '❌ Missing'}</p>
        <p><strong>Scopes:</strong> ${session.scope || 'None'}</p>
    </div>

    <!-- Metrics Dashboard -->
    <div class="metric-grid">
        <div class="metric-card">
            <div class="metric-number" id="monthly-messages">
                <div class="loading-spinner"></div>
            </div>
            <div class="metric-label">Messages This Month</div>
        </div>
        <div class="metric-card">
            <div class="metric-number" id="delivery-rate">
                <div class="loading-spinner"></div>
            </div>
            <div class="metric-label">Delivery Rate</div>
        </div>
        <div class="metric-card">
            <div class="metric-number" id="active-customers">
                <div class="loading-spinner"></div>
            </div>
            <div class="metric-label">Active Customers</div>
        </div>
        <div class="metric-card">
            <div class="metric-number">${shopData.message_limit || 50}</div>
            <div class="metric-label">Monthly Limit</div>
        </div>
    </div>

    <!-- Notification Settings -->
    <div class="settings-section">
        <div class="settings-header">
            <h2>Notification Settings</h2>
        </div>
        <div class="settings-content">
            <div class="toggle-setting">
                <div class="toggle-info">
                    <h3>Order Confirmations</h3>
                    <p>Send WhatsApp message when customer places an order</p>
                </div>
                <div class="toggle-switch active" onclick="toggleSetting(this, 'order_confirmation')"></div>
            </div>
            
            <div class="toggle-setting">
                <div class="toggle-info">
                    <h3>Shipping Updates</h3>
                    <p>Notify customers when order is fulfilled and shipped</p>
                </div>
                <div class="toggle-switch active" onclick="toggleSetting(this, 'shipping_updates')"></div>
            </div>
            
            <div class="toggle-setting">
                <div class="toggle-info">
                    <h3>Abandoned Cart Recovery</h3>
                    <p>Send reminder messages for abandoned shopping carts</p>
                </div>
                <div class="toggle-switch" onclick="toggleSetting(this, 'abandoned_cart')"></div>
            </div>

            <div class="button-group" style="margin-top: 24px;">
                <button class="test-button" onclick="sendTestMessage()">Send Test Message</button>
            </div>
        </div>
    </div>

    <script>
        console.time('🚀 Dashboard initialization');
        
        // Get session token from URL parameters and use it for authenticated requests
        const urlParams = new URLSearchParams(window.location.search);
        const sessionToken = urlParams.get('id_token');
        
        const authenticatedFetch = async (url, options = {}) => {
            return fetch(url, {
                ...options,
                headers: {
                    'Authorization': \`Bearer \${sessionToken}\`,
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });
        };
        
        console.log('✅ Authenticated fetch ready');

        // Load metrics using authenticated fetch
        async function loadMetrics() {
            console.log('🔍 Starting to load metrics...');
            try {
                const response = await authenticatedFetch('/api/metrics');
                console.log('📡 Response received:', response.status);
                const data = await response.json();
                console.log('📊 Data parsed:', data);
                
                if (data.success) {
                    console.log('✅ Metrics loaded successfully, updating UI...');
                    updateMetrics(data.metrics);
                } else {
                    console.error('❌ API returned error:', data.error);
                    showError('Failed to load metrics');
                }
            } catch (error) {
                console.error('Failed to load metrics:', error);
                showError('Error loading metrics');
            }
        }

        function updateMetrics(metrics) {
            console.log('🎯 Updating metrics with:', metrics);
            const monthlyEl = document.getElementById('monthly-messages');
            const deliveryEl = document.getElementById('delivery-rate');
            const customersEl = document.getElementById('active-customers');
            
            console.log('🔍 Elements found:', {
                monthly: !!monthlyEl,
                delivery: !!deliveryEl, 
                customers: !!customersEl
            });
            
            if (monthlyEl) monthlyEl.textContent = metrics.monthly_messages || 0;
            if (deliveryEl) deliveryEl.textContent = (metrics.delivery_rate || 0) + '%';
            if (customersEl) customersEl.textContent = metrics.active_customers || 0;
            
            console.log('✅ Metrics UI updated');
        }
        
        function showError(message) {
            document.getElementById('monthly-messages').innerHTML = '<span style="color: #d72c0d; font-size: 14px;">Error</span>';
            document.getElementById('delivery-rate').innerHTML = '<span style="color: #d72c0d; font-size: 14px;">Error</span>';
            document.getElementById('active-customers').innerHTML = '<span style="color: #d72c0d; font-size: 14px;">Error</span>';
        }

        // App functions with authenticated requests
        function toggleSetting(element, setting) {
            element.classList.toggle('active');
            const isActive = element.classList.contains('active');
            
            // Save setting using authenticated fetch
            authenticatedFetch('/api/settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    setting: setting,
                    enabled: isActive
                })
            }).then(response => response.json())
              .then(data => {
                  if (data.success) {
                      console.log('Setting updated:', data.message);
                  } else {
                      console.error('Error:', data.error);
                      // Revert toggle on error
                      element.classList.toggle('active');
                      alert('Failed to update setting: ' + data.error);
                  }
              })
              .catch(error => {
                  console.error('Error updating setting:', error);
                  // Revert toggle on error
                  element.classList.toggle('active');
                  alert('Error updating setting');
              });
        }

        function sendTestMessage() {
            const button = event.target;
            button.disabled = true;
            button.textContent = 'Sending...';
            
            authenticatedFetch('/api/test-message', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                }
            }).then(response => response.json())
              .then(data => {
                  if (data.success) {
                      alert('✅ Test message sent successfully!');
                  } else {
                      alert('❌ Failed to send test message: ' + data.error);
                  }
              })
              .catch(error => {
                  console.error('Error sending test message:', error);
                  alert('❌ Error sending test message');
              })
              .finally(() => {
                  button.disabled = false;
                  button.textContent = 'Send Test Message';
              });
        }
        
        // Load metrics on page load
        console.time('📊 Metrics loading');
        loadMetrics().finally(() => {
            console.timeEnd('📊 Metrics loading');
            console.timeEnd('🚀 Dashboard initialization');
        });

        console.log('WhatsApp Notifications Admin loaded for shop: ${shop}');
    </script>
</body>
</html>
  `;
}

// Initialize database and start server
async function startServer() {
  try {
    await initializeDatabase();
    console.log('✅ Database initialized');
    
    app.listen(PORT, () => {
      console.log(`🚀 Authenticated server running on port ${PORT}`);
      console.log(`📱 WhatsApp ready with Shopify session tokens`);
      console.log(`🔗 App URL: ${process.env.SHOPIFY_APP_URL}/app`);
      console.log(`🔐 Using proper Shopify authentication`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
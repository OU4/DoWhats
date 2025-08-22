const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const { db, initializeDatabase } = require('./database');
const DatabaseQueries = require('./database/queries');
const { shopify } = require('./shopify.app.config');

// Load environment variables
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

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use('/public', express.static(path.join(__dirname, 'public')));

// Add ngrok bypass headers
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.setHeader('ngrok-skip-browser-warning', 'any');
  req.headers['ngrok-skip-browser-warning'] = 'true';
  
  // For embedded apps
  if (req.path === '/app' || req.path === '/' || req.query.embedded === '1') {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.shopify.com https://admin.shopify.com;");
    res.setHeader('X-Frame-Options', 'ALLOWALL');
  }
  
  next();
});

console.log('🔧 Shopify CLI with TOKEN EXCHANGE - modern authentication');

// ✅ TOKEN EXCHANGE AUTHENTICATION
// Session token validation middleware for modern embedded apps
async function validateSessionToken(req, res, next) {
  // Skip validation for certain paths
  if (req.path.startsWith('/webhooks') || 
      req.path.startsWith('/public') ||
      req.path === '/test-whatsapp-simple' ||
      req.path.startsWith('/auth')) {
    return next();
  }

  // Get session token from authorization header or query
  let sessionToken = req.headers.authorization?.replace('Bearer ', '') || req.query.id_token;
  
  if (!sessionToken) {
    console.log('❌ No session token provided for:', req.path);
    console.log('🔍 Available headers:', Object.keys(req.headers));
    console.log('🔍 Available query params:', Object.keys(req.query));
    console.log('🔍 Authorization header:', req.headers.authorization);
    console.log('🔍 id_token query:', req.query.id_token);
    return res.status(401).json({ error: 'No session token provided' });
  }

  try {
    // Validate session token using Shopify API
    const payload = await shopify.api.session.decodeSessionToken(sessionToken);
    
    console.log('✅ Session token validated:', {
      shop: payload.dest?.replace('https://', '').replace('/admin', ''),
      aud: payload.aud,
      path: req.path
    });

    // Extract shop from token
    const shop = payload.dest?.replace('https://', '').replace('/admin', '');
    if (!shop) {
      return res.status(400).json({ error: 'Invalid shop in token' });
    }

    // Add to request for use in routes
    req.sessionToken = sessionToken;
    req.shop = shop;
    req.tokenPayload = payload;
    
    next();
    
  } catch (error) {
    console.error('❌ Session token validation failed:', error.message);
    return res.status(401).json({ error: 'Invalid session token' });
  }
}

// Apply token validation to app routes (modern approach)
app.use(validateSessionToken);

// Keep OAuth setup as fallback for installation flow
app.use('/auth', shopify.auth.begin());
app.use('/auth/callback', shopify.auth.callback(), 
  shopify.redirectToShopifyOrAppRoot()
);

// Add exitiframe route for embedded app OAuth flow
app.get('/exitiframe', (req, res) => {
  const shop = req.query.shop;
  const host = req.query.host;
  
  console.log('🚪 Exitiframe route accessed:', { shop, host });
  
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }
  
  // Build auth URL with proper parameters
  let authUrl = `/auth?shop=${encodeURIComponent(shop)}`;
  if (host) {
    authUrl += `&host=${encodeURIComponent(host)}`;
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Redirecting...</title>
      <script>
        // Multiple redirect methods for embedded apps
        console.log('Attempting redirect to: ${authUrl}');
        
        // Method 1: Try parent window
        if (window.parent && window.parent !== window) {
          window.parent.location.href = "${authUrl}";
        }
        // Method 2: Try top window  
        else if (window.top && window.top !== window) {
          window.top.location.href = "${authUrl}";
        }
        // Method 3: Regular redirect
        else {
          window.location.href = "${authUrl}";
        }
        
        // Fallback: Show manual link after 3 seconds
        setTimeout(function() {
          document.getElementById('manual-link').style.display = 'block';
        }, 3000);
      </script>
    </head>
    <body>
      <h2>🔐 Authenticating with Shopify...</h2>
      <p>You should be redirected automatically.</p>
      <div id="manual-link" style="display: none;">
        <p><strong>Manual redirect needed:</strong></p>
        <p><a href="${authUrl}" target="_top">Click here to continue authentication</a></p>
      </div>
    </body>
    </html>
  `);
});

// Add CSP headers
app.use(shopify.cspHeaders());

// Root route - redirect to app with proper parameters and session token
app.get('/', (req, res) => {
  const shop = req.shop || req.query.shop; // Get from validated token or query
  const host = req.query.host;
  const sessionToken = req.sessionToken;
  
  if (shop) {
    console.log('🔄 Root route redirecting to app for shop:', shop, 'host:', host || 'No host provided');
    
    // Build redirect URL with all necessary parameters including session token
    let redirectUrl = `/app?shop=${encodeURIComponent(shop)}&embedded=1`;
    if (host) {
      redirectUrl += `&host=${encodeURIComponent(host)}`;
    }
    // Preserve session token in redirect
    if (sessionToken) {
      redirectUrl += `&id_token=${encodeURIComponent(sessionToken)}`;
    }
    
    return res.redirect(redirectUrl);
  }
  res.send('<h1>WhatsApp for Shopify</h1><p>Please access this app through your Shopify admin.</p>');
});

// ✅ TOKEN EXCHANGE APP ROUTE
app.get('/app', async (req, res) => {
  const shop = req.shop; // From validated session token
  const sessionToken = req.sessionToken;
  
  console.log('✅ App route - Token Exchange mode:', { shop });
  
  try {
    // Check if we have an offline access token for this shop
    let shopData = await DatabaseQueries.getShop(shop);
    let accessToken = shopData?.access_token;
    
    // If no access token, use token exchange to get one
    if (!accessToken || accessToken === 'session_token_auth') {
      console.log('🔄 Getting access token via token exchange...');
      
      try {
        // Use Shopify's token exchange to get offline access token
        const response = await shopify.api.auth.tokenExchange({
          sessionToken,
          shop,
        });
        
        console.log('✅ Token exchange successful:', {
          hasAccessToken: !!response?.access_token,
          hasSession: !!response?.session,
          responseKeys: Object.keys(response || {})
        });
        
        // Extract access token from response (could be in different places)
        accessToken = response?.access_token || response?.session?.accessToken || response?.accessToken;
        
        if (!accessToken) {
          console.warn('⚠️ No access token found in token exchange response, using session token as fallback');
          accessToken = 'session_token_validated';
        }
        
        // Save the access token to database
        await DatabaseQueries.createOrUpdateShop(shop, accessToken, {
          shop_name: shop.split('.')[0],
          email: null,
          phone: null
        });
        
        console.log('✅ Access token saved to database');
        
      } catch (tokenError) {
        console.error('❌ Token exchange failed:', tokenError.message);
        // Fall back to session token for now
        accessToken = 'session_token_temp';
        
        await DatabaseQueries.createOrUpdateShop(shop, accessToken, {
          shop_name: shop.split('.')[0],
          email: null,  
          phone: null
        });
      }
    }
    
    // Get updated shop data
    shopData = await DatabaseQueries.getShop(shop);
    
    // Create session object for compatibility with existing code
    const { Session } = require('@shopify/shopify-api');
    const session = new Session({
      id: `offline_${shop}`,
      shop: shop,
      state: '',
      isOnline: false,
      accessToken: accessToken,
      scope: process.env.SHOPIFY_SCOPES || 'read_orders,write_orders,read_customers,write_customers'
    });
    
    res.locals.shopify = { session };
    
    console.log('✅ Serving app dashboard for shop:', shop);
    
    // Serve the admin dashboard
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    
  } catch (error) {
    console.error('❌ Error in token exchange app route:', error);
    return res.status(500).json({ error: 'Failed to load app' });
  }
});

// Webhook handler with detailed logging
app.post('/webhooks', express.raw({ type: 'application/json' }), async (req, res) => {
  const shop = req.get('X-Shopify-Shop-Domain');
  const topic = req.get('X-Shopify-Topic');
  
  console.log(`📦 Webhook received: ${topic} from ${shop}`);
  console.log('📦 Webhook headers:', {
    'X-Shopify-Shop-Domain': req.get('X-Shopify-Shop-Domain'),
    'X-Shopify-Topic': req.get('X-Shopify-Topic'),
    'X-Shopify-Hmac-Sha256': req.get('X-Shopify-Hmac-Sha256'),
  });
  
  if (topic === 'app/uninstalled') {
    console.log('⚠️ App uninstall webhook received - this may indicate OAuth failure');
    try {
      const deletedRows = await DatabaseQueries.deleteShop(shop);
      console.log(`🗑️ Shop uninstalled and cleaned up: ${shop} (${deletedRows} rows affected)`);
    } catch (error) {
      console.error('Error cleaning up uninstalled shop:', error);
    }
  } else {
    console.log(`📦 Other webhook: ${topic} from ${shop}`);
  }
  
  res.status(200).send('OK');
});

// Test endpoint
app.get('/test-whatsapp-simple', async (req, res) => {
  if (!twilioClient) {
    return res.send('⚠️ Twilio not configured. Check your .env.local file.');
  }
  
  try {
    const message = await twilioClient.messages.create({
      body: 'Hello from your Shopify WhatsApp app! 🛍️',
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: process.env.TEST_PHONE_NUMBER || 'whatsapp:+966592000903'
    });
    
    res.send(`✅ Success! WhatsApp message sent. SID: ${message.sid}`);
  } catch (error) {
    console.error('WhatsApp send error:', error);
    res.send(`❌ Error: ${error.message}`);
  }
});

// Initialize database and start server
async function startServer() {
  try {
    await initializeDatabase();
    console.log('✅ Database initialized');
    
    app.listen(PORT, () => {
      console.log(`🚀 Shopify CLI compatible server running on port ${PORT}`);
      console.log(`📱 WhatsApp ready with Shopify CLI authentication`);
      console.log(`🔗 App URL: ${process.env.SHOPIFY_APP_URL}/app`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
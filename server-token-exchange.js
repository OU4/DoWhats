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
  console.warn('⚠️ Twilio credentials not configured');
}

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use('/public', express.static(path.join(__dirname, 'public')));

// Add headers for embedded apps
app.use((req, res, next) => {
  // Ngrok bypass
  res.setHeader('ngrok-skip-browser-warning', 'true');
  
  // Embedded app headers
  res.setHeader('Content-Security-Policy', 
    "frame-ancestors 'self' https://*.shopify.com https://admin.shopify.com;"
  );
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  
  next();
});

console.log('🔧 TOKEN EXCHANGE SERVER - Modern Shopify Authentication');

// ✅ TOKEN EXCHANGE AUTHENTICATION (No OAuth redirects needed!)
// Session token validation middleware
async function validateSessionToken(req, res, next) {
  // Skip validation for certain paths
  if (req.path.startsWith('/webhooks') || 
      req.path.startsWith('/public') ||
      req.path === '/test-whatsapp-simple') {
    return next();
  }

  // Get session token from authorization header or query
  let sessionToken = req.headers.authorization?.replace('Bearer ', '') || req.query.id_token;
  
  if (!sessionToken) {
    console.log('❌ No session token provided');
    return res.status(401).json({ error: 'No session token provided' });
  }

  try {
    // Validate session token using Shopify API
    const payload = await shopify.api.session.decodeSessionToken(sessionToken);
    
    console.log('✅ Session token validated:', {
      shop: payload.dest?.replace('https://', '').replace('/admin', ''),
      aud: payload.aud,
      exp: new Date(payload.exp * 1000).toISOString()
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

// Apply session token validation to app routes
app.use(validateSessionToken);

// Root route - redirect to app
app.get('/', (req, res) => {
  const shop = req.query.shop;
  const host = req.query.host;
  
  if (shop) {
    console.log('🔄 Root route - redirecting to app');
    let redirectUrl = `/app?shop=${encodeURIComponent(shop)}`;
    if (host) redirectUrl += `&host=${encodeURIComponent(host)}`;
    return res.redirect(redirectUrl);
  }
  
  res.send('<h1>WhatsApp for Shopify</h1><p>Please access through Shopify admin.</p>');
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
        
        console.log('✅ Token exchange successful');
        accessToken = response.access_token;
        
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

// Webhook handler
app.post('/webhooks', express.raw({ type: 'application/json' }), async (req, res) => {
  const shop = req.get('X-Shopify-Shop-Domain');
  const topic = req.get('X-Shopify-Topic');
  
  console.log(`📦 Webhook: ${topic} from ${shop}`);
  
  if (topic === 'app/uninstalled') {
    try {
      await DatabaseQueries.deleteShop(shop);
      console.log(`🗑️ Shop uninstalled and cleaned up: ${shop}`);
    } catch (error) {
      console.error('Error cleaning up uninstalled shop:', error);
    }
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
      body: 'Hello from your Token Exchange Shopify WhatsApp app! 🛍️',
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
      console.log(`🚀 TOKEN EXCHANGE server running on port ${PORT}`);
      console.log(`📱 Modern Shopify authentication with session tokens`);
      console.log(`🔗 App URL: ${process.env.SHOPIFY_APP_URL}/app`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
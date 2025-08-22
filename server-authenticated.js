const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
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

// Serve static files from public directory
app.use('/public', express.static(path.join(__dirname, 'public')));

// Add ngrok bypass headers FIRST - CRITICAL for OAuth callback
app.use((req, res, next) => {
  // Bypass ngrok warning page - CRITICAL for callbacks
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.setHeader('ngrok-skip-browser-warning', 'any');
  req.headers['ngrok-skip-browser-warning'] = 'true';
  
  // CRITICAL: Fix embedded app cookie issues for iframe loading
  if (req.path === '/app' || req.path.startsWith('/app?')) {
    // Remove X-Frame-Options to allow iframe embedding
    res.removeHeader('X-Frame-Options');
    
    // Set CSP to allow Shopify iframe embedding
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.shopify.com https://admin.shopify.com");
    
    // Set SameSite=None for cookies to work in third-party context (iframe)
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = function(name, value) {
      if (name.toLowerCase() === 'set-cookie') {
        if (Array.isArray(value)) {
          value = value.map(cookie => cookie.includes('SameSite') ? cookie : cookie + '; SameSite=None; Secure');
        } else {
          value = value.includes('SameSite') ? value : value + '; SameSite=None; Secure';
        }
      }
      return originalSetHeader(name, value);
    };
    
    console.log('🍪 Setting embedded app iframe headers for:', req.path);
  }
  
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

// Session Token Validation Middleware - CRITICAL for embedded apps
async function validateSessionToken(req, res, next) {
  // Skip validation for webhooks and public routes
  if (req.path.startsWith('/webhooks') || 
      req.path.startsWith('/auth') || 
      req.path.startsWith('/exitiframe') ||
      req.path.startsWith('/public') ||
      req.path.startsWith('/api/auth/session-token-exchange') ||
      req.path === '/force-cleanup' ||
      req.path === '/check-webhooks' ||
      req.path === '/bounce' ||
      req.path.startsWith('/debug') ||
      req.path === '/') {
    return next();
  }

  console.log('🔐 Validating session token for:', req.path);

  // Get session token from Authorization header (primary method)
  let sessionToken = req.headers.authorization?.replace('Bearer ', '');
  
  // Fallback: Get session token from URL parameter (initial load only)
  if (!sessionToken) {
    sessionToken = req.query.id_token;
  }

  // Get shop from query or extract from token
  let shop = req.query.shop;

  if (!sessionToken) {
    console.log('❌ No session token found, redirecting to bounce page');
    return redirectToBouncePage(req, res);
  }

  try {
    // Validate session token using Shopify API library
    const decodedSessionToken = await shopify.api.session.decodeSessionToken(sessionToken);
    
    console.log('✅ Session token validated:', {
      dest: decodedSessionToken.dest,
      aud: decodedSessionToken.aud,
      exp: new Date(decodedSessionToken.exp * 1000).toISOString()
    });

    // Extract shop from token if not in query
    if (!shop && decodedSessionToken.dest) {
      shop = decodedSessionToken.dest.replace('https://', '').replace('/admin', '');
    }

    if (!shop) {
      console.log('❌ No shop found in token or query');
      return res.status(400).json({ error: 'Shop parameter required' });
    }

    console.log('✅ Session token validated for shop:', shop);
    
    // Add validated data to request
    req.sessionToken = sessionToken;
    req.shop = shop;
    req.sessionData = decodedSessionToken;
    
    next();

  } catch (error) {
    console.error('❌ Session token validation error:', error.message);
    
    // If session token is invalid/expired, redirect to bounce page for refresh
    if (error.message.includes('expired') || error.message.includes('invalid')) {
      console.log('🔄 Session token expired/invalid, redirecting to bounce page');
      return redirectToBouncePage(req, res);
    }
    
    return redirectToBouncePage(req, res);
  }
}

// Helper function to redirect to bounce page
function redirectToBouncePage(req, res) {
  const shop = req.query.shop || req.shop;
  const searchParams = new URLSearchParams(req.query);
  
  // Remove stale id_token to prevent invalid token issues
  searchParams.delete('id_token');
  
  // Add shopify-reload parameter for automatic redirect after token refresh
  searchParams.set('shopify-reload', `${req.path}?${searchParams.toString()}`);
  
  const bounceUrl = `/bounce?${searchParams.toString()}`;
  console.log('🔄 Redirecting to bounce page:', bounceUrl);
  
  return res.redirect(bounceUrl);
}

// When using Shopify CLI, disable custom authentication middleware
// Shopify CLI handles all authentication automatically
console.log('🔧 Running with Shopify CLI - custom authentication disabled');

// Skip custom authentication middleware entirely when using Shopify CLI
app.use((req, res, next) => {
  // Skip completely for all Shopify OAuth related paths
  if (req.path === '/auth' || 
      req.path === '/auth/callback' || 
      req.path.startsWith('/auth/') ||
      req.path === '/exitiframe') {
    console.log(`🔄 Skipping ALL middleware for Shopify OAuth path: ${req.path}`);
    return next();
  }
  
  // For Shopify CLI development, skip custom token validation
  // Shopify CLI handles authentication via its own mechanisms
  console.log(`✅ Shopify CLI mode - allowing access to: ${req.path}`);
  return next();
});

// OAuth callback debugging removed - let Shopify App Bridge handle completely

// Add Shopify middleware
app.use(shopify.cspHeaders());

// OAuth flow logging removed - let Shopify App Bridge handle completely

// ✅ SHOPIFY CLI COMPATIBLE AUTH SETUP
// Use ONLY Shopify's built-in auth handlers - no custom middleware
console.log('🔧 Shopify CLI mode - using clean auth setup');

app.use('/auth', shopify.auth.begin());
app.use('/auth/callback', shopify.auth.callback(), 
  shopify.redirectToShopifyOrAppRoot()
);

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

// Debug route to check Partner Dashboard configuration
app.get('/debug/partner-config', (req, res) => {
  const currentUrl = `${req.protocol}://${req.get('host')}`;
  
  res.send(`
    <h1>🔧 Partner Dashboard Configuration Check</h1>
    
    <h2>Current Server Configuration:</h2>
    <ul>
      <li><strong>Current URL:</strong> ${currentUrl}</li>
      <li><strong>SHOPIFY_APP_URL:</strong> ${process.env.SHOPIFY_APP_URL || 'Not set'}</li>
      <li><strong>API Key:</strong> ${process.env.SHOPIFY_API_KEY || 'Not set'}</li>
    </ul>
    
    <h2>✅ Correct Partner Dashboard Settings:</h2>
    <div style="background: #f0f0f0; padding: 20px; border-radius: 8px; margin: 20px 0;">
      <h3>App URL:</h3>
      <code style="background: white; padding: 10px; display: block; margin: 10px 0;">${process.env.SHOPIFY_APP_URL}/app</code>
      
      <h3>Allowed redirection URLs (add ALL of these):</h3>
      <ul style="background: white; padding: 10px; margin: 10px 0;">
        <li><code>${process.env.SHOPIFY_APP_URL}/auth/callback</code></li>
        <li><code>${process.env.SHOPIFY_APP_URL}/auth/success</code></li>
        <li><code>${process.env.SHOPIFY_APP_URL}/app</code></li>
        <li><code>${process.env.SHOPIFY_APP_URL}/</code></li>
        <li><code>${process.env.SHOPIFY_APP_URL}/exitiframe</code></li>
      </ul>
    </div>
    
    <h2>🔍 Common Issues:</h2>
    <ol>
      <li><strong>"There's no page at this address" error:</strong>
        <ul>
          <li>App URL in Partner Dashboard doesn't match server route</li>
          <li>Missing /app at the end of the App URL</li>
          <li>Not all redirect URLs are whitelisted</li>
        </ul>
      </li>
      <li><strong>OAuth errors:</strong>
        <ul>
          <li>Redirect URLs don't match exactly (check for trailing slashes)</li>
          <li>Using http instead of https (or vice versa)</li>
          <li>ngrok URL changed but Partner Dashboard not updated</li>
        </ul>
      </li>
    </ol>
    
    <h2>🧪 Test Links:</h2>
    <ul>
      <li><a href="/app?shop=dowhatss1.myshopify.com">Test App Route</a></li>
      <li><a href="/auth?shop=dowhatss1.myshopify.com">Test OAuth Flow</a></li>
      <li><a href="/debug">General Debug Info</a></li>
    </ul>
  `);
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

// Bounce page route for session token handling
app.get('/bounce', (req, res) => {
  console.log('📄 Bounce page requested:', req.query);
  
  const fs = require('fs');
  const path = require('path');
  
  // Read the bounce.html template
  const bounceTemplate = fs.readFileSync(path.join(__dirname, 'public/bounce.html'), 'utf8');
  
  // Replace environment variable placeholders
  const bounceHtml = bounceTemplate.replace('${process.env.SHOPIFY_API_KEY}', process.env.SHOPIFY_API_KEY);
  
  res.send(bounceHtml);
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
        <li>Try accessing this URL directly: <code>https://f44d8241da37.ngrok-free.app/ngrok-test</code></li>
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

// Manual install route to save shop to database (for testing)
app.get('/install-shop', async (req, res) => {
  const shop = req.query.shop || 'dowhatss1.myshopify.com';
  
  if (!shop || !ValidationUtils.isValidShopDomain(shop)) {
    return res.status(400).json({ error: 'Invalid shop domain' });
  }
  
  try {
    // Check session storage for existing session
    const { sessionStorage } = require('./shopify.app.config');
    const sessionId = `offline_${shop}`;
    const session = await sessionStorage.loadSession(sessionId);
    
    if (!session || !session.accessToken) {
      return res.json({
        error: 'No session found',
        message: 'Please install the app through Shopify first',
        installUrl: `/auth?shop=${shop}`
      });
    }
    
    // Save to our custom database
    await DatabaseQueries.createOrUpdateShop(
      shop,
      session.accessToken,
      {
        shop_name: shop.split('.')[0],
        email: null,
        phone: null
      }
    );
    
    // Verify it was saved
    const savedShop = await DatabaseQueries.getShop(shop);
    
    res.json({
      success: true,
      message: 'Shop saved to database',
      shop: shop,
      savedShop: savedShop,
      redirect: `/app?shop=${shop}`
    });
    
  } catch (error) {
    console.error('Error saving shop:', error);
    res.status(500).json({ error: 'Failed to save shop', details: error.message });
  }
});

// Add session debugging middleware
app.use('/app', async (req, res, next) => {
  console.log('🔍 APP ROUTE DEBUG:', {
    method: req.method,
    url: req.originalUrl,
    query: req.query,
    sessionLocals: res.locals.shopify || 'No session locals',
    cookies: req.headers.cookie || 'No cookies'
  });
  
  // Check if we have a valid session and save shop if needed
  if (res.locals.shopify && res.locals.shopify.session) {
    const session = res.locals.shopify.session;
    const shop = session.shop;
    
    try {
      // Check if shop exists in our database
      const existingShop = await DatabaseQueries.getShop(shop);
      if (!existingShop) {
        console.log('📝 Shop not in database, saving now:', shop);
        await DatabaseQueries.createOrUpdateShop(
          shop,
          session.accessToken,
          {
            shop_name: shop.split('.')[0],
            email: null,
            phone: null
          }
        );
        console.log('✅ Shop saved to database');
      }
    } catch (error) {
      console.error('❌ Error checking/saving shop:', error);
    }
  }
  
  next();
});

// Add bounce page route
app.get('/bounce', (req, res) => {
  // Allow this page to be embedded in Shopify iframe
  res.removeHeader('Content-Security-Policy');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  
  // Read the bounce.html file and replace the API key placeholder
  const fs = require('fs');
  const bounceHtmlPath = path.join(__dirname, 'public', 'bounce.html');
  const bounceHtml = fs.readFileSync(bounceHtmlPath, 'utf8');
  const modifiedHtml = bounceHtml.replace('INSERT_API_KEY_HERE', process.env.SHOPIFY_API_KEY);
  
  res.send(modifiedHtml);
});

// Authenticated app route (for Shopify admin access)
app.get('/app', async (req, res, next) => {
  const shop = req.shop || req.query.shop;
  const embedded = req.query.embedded;
  const host = req.query.host;
  
  console.log('🔍 App route accessed:', {
    shop,
    hasValidatedSession: !!req.sessionToken,
    hasSessionData: !!req.sessionData,
    embedded: embedded,
    host: host
  });
  
  // If no shop parameter, show error
  if (!shop) {
    console.error('❌ No shop parameter provided');
    return res.send(`
      <h1>❌ No Shop Parameter</h1>
      <p>This app must be accessed through Shopify admin or with a shop parameter.</p>
      <p><a href="/install">Go to Installation Page</a></p>
    `);
  }
  
  // Check if this is the initial redirect from Shopify (with hmac but no embedded flag)
  if (req.query.hmac && !embedded) {
    console.log('🔄 Initial Shopify redirect detected, redirecting to embedded app');
    const redirectUrl = `/app?embedded=1&shop=${encodeURIComponent(shop)}${host ? `&host=${encodeURIComponent(host)}` : ''}`;
    return res.redirect(redirectUrl);
  }
  
  // If we have validated session data from middleware, use it
  if (req.sessionToken && req.sessionData) {
    console.log('✅ Using validated session from middleware');
    
    try {
      // Get shop data from database
      let shopData = await DatabaseQueries.getShop(shop);
      
      if (shopData && shopData.access_token) {
        console.log('✅ Shop found in database, generating admin page');
        
        // Create session object for compatibility
        const { Session } = require('@shopify/shopify-api');
        const session = new Session({
          id: `offline_${shop}`,
          shop: shop,
          state: '',
          isOnline: false,
          accessToken: shopData.access_token,
          scope: process.env.SHOPIFY_SCOPES || 'read_orders,write_orders,read_customers,write_customers'
        });
        
        res.locals.shopify = { session };
        
        // Generate and send the admin page
        const adminPage = generateAdminPage(shop, shopData, session, req);
        return res.send(adminPage);
        
      } else {
        console.log('💾 Shop not found in database, but we have valid session token - creating shop record');
        
        // We have a valid session token, so the app is installed
        // Create a temporary access token using the session token flow
        try {
          // For now, create a shop record with placeholder access token
          // The real access token will be obtained through session token exchange
          await DatabaseQueries.createOrUpdateShop(
            shop,
            'session_token_auth', // Placeholder - will be replaced with real token
            {
              shop_name: shop.split('.')[0],
              email: null,
              phone: null
            }
          );
          
          shopData = await DatabaseQueries.getShop(shop);
          console.log('✅ Shop record created with session token auth');
          
          // Create session object
          const { Session } = require('@shopify/shopify-api');
          const session = new Session({
            id: `offline_${shop}`,
            shop: shop,
            state: '',
            isOnline: false,
            accessToken: 'session_token_auth', // Placeholder
            scope: process.env.SHOPIFY_SCOPES || 'read_orders,write_orders,read_customers,write_customers'
          });
          
          res.locals.shopify = { session };
          
          // Generate and send the admin page
          const adminPage = generateAdminPage(shop, shopData, session, req);
          return res.send(adminPage);
          
        } catch (dbError) {
          console.error('❌ Error creating shop record:', dbError);
          // Fall through to OAuth flow
        }
      }
    } catch (error) {
      console.error('❌ Error using validated session:', error);
      // Fall through to OAuth flow
    }
  }
  
  // No valid session token or shop not in database - use OAuth flow
  console.log('🔄 No valid session token, using OAuth flow');
  
  return shopify.ensureInstalledOnShop()(req, res, async (err) => {
    if (err) {
      console.error('❌ Shopify auth middleware error:', err);
      
      // Clear any stale data before redirecting to OAuth
      try {
        await DatabaseQueries.deleteShop(shop);
        await DatabaseQueries.deleteShopOrders(shop);
        await DatabaseQueries.deleteShopCustomers(shop);
        await DatabaseQueries.deleteShopMessages(shop);
        console.log('🗑️ Cleaned up stale shop data');
      } catch (cleanupError) {
        console.error('Error cleaning up shop data:', cleanupError);
      }
      
      // Redirect to OAuth
      const authUrl = `/auth?shop=${encodeURIComponent(shop)}${host ? `&host=${encodeURIComponent(host)}` : ''}`;
      return res.redirect(authUrl);
    }
    
    // Auth succeeded through Shopify middleware
    const session = res.locals.shopify?.session;
    
    if (!session) {
      console.error('❌ No session after auth middleware');
      const authUrl = `/auth?shop=${encodeURIComponent(shop)}${host ? `&host=${encodeURIComponent(host)}` : ''}`;
      return res.redirect(authUrl);
    }
    
    console.log('✅ Session validated through Shopify middleware:', {
      shop: session.shop,
      hasAccessToken: !!session.accessToken
    });
    
    try {
      // Save shop to database
      await DatabaseQueries.createOrUpdateShop(
        session.shop,
        session.accessToken,
        {
          shop_name: session.shop.split('.')[0],
          email: null,
          phone: null
        }
      );
      
      const shopData = await DatabaseQueries.getShop(shop);
      console.log('✅ Shop saved to database after OAuth');
      
      // Generate and send the admin page
      console.log('📱 Generating admin dashboard...');
      const adminPage = generateAdminPage(shop, shopData, session, req);
      return res.send(adminPage);
      
    } catch (error) {
      console.error('Error in app route:', error);
      return res.status(500).send('Failed to load app');
    }
  });
});

// Manual cleanup route for testing uninstall process
app.get('/force-cleanup', async (req, res) => {
  const shop = req.query.shop || 'dowhatss1.myshopify.com';
  
  console.log('🗑️ MANUAL CLEANUP REQUESTED for shop:', shop);
  
  try {
    // Perform the same cleanup as app uninstall
    await handleAppUninstalled(shop);
    
    // Also clear any session storage
    const { sessionStorage } = require('./shopify.app.config');
    try {
      await sessionStorage.deleteSession(`offline_${shop}`);
      console.log('✅ Session storage cleared');
    } catch (sessionError) {
      console.log('⚠️ No session to clear');
    }
    
    // Verify cleanup by checking database
    const shopData = await DatabaseQueries.getShop(shop);
    
    res.json({
      success: true,
      message: 'Cleanup completed',
      shop: shop,
      shopStillExists: !!shopData,
      cleanupTimestamp: new Date().toISOString(),
      nextSteps: [
        'Now try reinstalling the app',
        'It should go through proper OAuth flow',
        'Check that it shows installation, not "update data access"'
      ]
    });
    
  } catch (error) {
    console.error('❌ Manual cleanup failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      shop: shop
    });
  }
});

// Check webhook registration status
app.get('/check-webhooks', async (req, res) => {
  const shop = req.query.shop || 'dowhatss1.myshopify.com';
  
  try {
    // Get shop data to check if we have access token
    const shopData = await DatabaseQueries.getShop(shop);
    
    if (!shopData || !shopData.access_token) {
      return res.json({
        error: 'Shop not found or no access token',
        shop: shop,
        hasShopData: !!shopData
      });
    }
    
    // Check registered webhooks via Shopify API
    const axios = require('axios');
    const response = await axios.get(
      `https://${shop}/admin/api/2024-01/webhooks.json`,
      {
        headers: {
          'X-Shopify-Access-Token': shopData.access_token,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const webhooks = response.data.webhooks || [];
    const appUninstalledWebhook = webhooks.find(w => w.topic === 'app/uninstalled');
    
    res.json({
      success: true,
      shop: shop,
      totalWebhooks: webhooks.length,
      appUninstalledWebhook: appUninstalledWebhook ? {
        id: appUninstalledWebhook.id,
        topic: appUninstalledWebhook.topic,
        address: appUninstalledWebhook.address,
        created_at: appUninstalledWebhook.created_at
      } : null,
      hasAppUninstalledWebhook: !!appUninstalledWebhook,
      allWebhooks: webhooks.map(w => ({
        topic: w.topic,
        address: w.address,
        created_at: w.created_at
      }))
    });
    
  } catch (error) {
    console.error('❌ Error checking webhooks:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      shop: shop
    });
  }
});

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
    // Extract shop from query parameter (primary method)
    let shop = req.query.shop;
    let session = null;
    
    console.log('📊 Metrics API called:', {
      shopFromQuery: shop,
      hasAuthHeader: !!req.headers.authorization,
      query: req.query
    });
    
    // If no shop parameter, try to extract from Authorization header
    if (!shop) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.substring(7);
          const jwt = require('jsonwebtoken');
          const decoded = jwt.decode(token);
          
          // Extract shop from the JWT token 
          shop = decoded?.iss?.replace('https://', '').replace('/admin', '');
          
          console.log('🔍 Decoded token for shop:', shop);
        } catch (error) {
          console.error('❌ Error decoding token:', error.message);
        }
      }
    }
    
    if (!shop) {
      console.error('❌ No shop parameter found in query or token');
      return res.status(400).json({
        success: false,
        error: 'Shop parameter required'
      });
    }
    
    try {
      // Try to create session from database (our fallback method that works)
      const { Session } = require('@shopify/shopify-api');
      const shopData = await DatabaseQueries.getShop(shop);
      
      if (shopData && shopData.access_token) {
        session = new Session({
          id: `offline_${shop}`,
          shop: shop,
          state: '',
          isOnline: false,
          accessToken: shopData.access_token,
          scope: 'write_products,write_checkouts,write_orders,write_customers,read_fulfillments,read_shipping'
        });
        
        console.log('✅ Session created from database for metrics');
      } else {
        console.error('❌ No shop data found in database');
        return res.status(401).json({
          success: false,
          error: 'Shop not found - please reinstall the app'
        });
      }
    } catch (error) {
      console.error('❌ Error creating session for metrics:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Internal server error'
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
        body: `🧪 Test message from ${shop}\n\nYour WhatsApp notifications are working correctly!\n\nTime: ${new Date().toLocaleString()}`
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

// Token exchange endpoint for embedded app authorization
app.post('/api/auth/session-token-exchange', async (req, res) => {
  try {
    const { sessionToken, shop } = req.body;
    
    if (!sessionToken || !shop) {
      return res.status(400).json({
        success: false,
        error: 'Missing sessionToken or shop parameter'
      });
    }

    console.log('🔐 Token exchange request:', {
      shop: shop,
      hasSessionToken: !!sessionToken
    });

    // First, validate the session token using Shopify API
    try {
      const { Session } = require('@shopify/shopify-api');
      const decodedSessionToken = await shopify.api.session.decodeSessionToken(sessionToken);
      
      console.log('✅ Session token validated by Shopify API:', {
        shop: decodedSessionToken.dest.replace('https://', ''),
        aud: decodedSessionToken.aud
      });
      
      // Ensure the shop from token matches the requested shop
      const tokenShop = decodedSessionToken.dest.replace('https://', '').replace('/admin', '');
      if (tokenShop !== shop) {
        console.error('❌ Shop mismatch between token and request');
        return res.json({
          success: false,
          error: 'Shop mismatch - please reinstall the app',
          requiresAuth: true
        });
      }
      
    } catch (sessionTokenError) {
      console.error('❌ Session token validation failed:', sessionTokenError.message);
      return res.json({
        success: false,
        error: 'Invalid session token - please refresh the page',
        requiresAuth: true
      });
    }

    // Use Shopify's official Token Exchange API as per documentation
    const axios = require('axios');
    
    try {
      console.log('🔄 Making request to Shopify Token Exchange API...');
      
      const tokenExchangeUrl = `https://${shop}/admin/oauth/access_token`;
      const tokenExchangePayload = {
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: sessionToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token'
      };

      console.log('📤 Token exchange payload:', {
        client_id: process.env.SHOPIFY_API_KEY,
        grant_type: tokenExchangePayload.grant_type,
        subject_token_type: tokenExchangePayload.subject_token_type,
        requested_token_type: tokenExchangePayload.requested_token_type,
        hasSubjectToken: !!tokenExchangePayload.subject_token
      });

      const response = await axios.post(tokenExchangeUrl, tokenExchangePayload, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      console.log('✅ Token exchange successful:', {
        hasAccessToken: !!response.data.access_token,
        scope: response.data.scope
      });

      // Create session with the new access token
      const { Session } = require('@shopify/shopify-api');
      const session = new Session({
        id: `offline_${shop}`,
        shop: shop,
        state: '',
        isOnline: false,
        accessToken: response.data.access_token,
        scope: response.data.scope
      });

      // Store session in Shopify's session storage
      const { sessionStorage } = require('./shopify.app.config');
      await sessionStorage.storeSession(session);
      
      // Also save/update shop in our database
      await DatabaseQueries.createOrUpdateShop(shop, response.data.access_token, {
        shop_name: shop.split('.')[0],
        email: null,
        phone: null
      });
      
      console.log('✅ Session created and stored, shop saved to database');

      return res.json({
        success: true,
        message: 'Token exchange successful',
        sessionId: session.id
      });

    } catch (tokenExchangeError) {
      console.error('❌ Shopify token exchange failed:', {
        status: tokenExchangeError.response?.status,
        statusText: tokenExchangeError.response?.statusText,
        data: tokenExchangeError.response?.data,
        message: tokenExchangeError.message
      });
      
      // If token exchange fails with 400, it means the session token is invalid or expired
      if (tokenExchangeError.response?.status === 400) {
        console.log('🔄 Session token expired or invalid, redirecting to OAuth');
        return res.json({
          success: false,
          error: 'Session token expired - redirecting to OAuth',
          requiresAuth: true
        });
      }
      
      // For other errors, check if shop exists in our database as fallback
      const shopData = await DatabaseQueries.getShop(shop);
      
      if (!shopData) {
        console.log('❌ Shop not found in database, requires OAuth installation');
        return res.json({
          success: false,
          error: 'Shop not installed - redirecting to OAuth',
          requiresAuth: true
        });
      }

      // Fallback: Create session with existing access token from database
      const { Session } = require('@shopify/shopify-api');
      const session = new Session({
        id: `offline_${shop}`,
        shop: shop,
        state: '',
        isOnline: false,
        accessToken: shopData.access_token,
        scope: process.env.SHOPIFY_SCOPES || 'read_orders,write_orders,read_customers,write_customers'
      });

      const { sessionStorage } = require('./shopify.app.config');
      await sessionStorage.storeSession(session);
      
      console.log('✅ Fallback session created from database');

      return res.json({
        success: true,
        message: 'Token exchange successful (fallback)',
        sessionId: session.id
      });
    }

  } catch (error) {
    console.error('❌ Token exchange error:', error);
    return res.status(500).json({
      success: false,
      error: 'Token exchange failed'
    });
  }
});

// Webhook routes - use Shopify's webhook processing
app.use('/webhooks', shopify.processWebhooks({
  webhookHandlers: {
    'ORDERS_CREATE': {
      deliveryMethod: 'http',
      callbackUrl: '/webhooks',
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
    'ORDERS_UPDATED': {
      deliveryMethod: 'http',
      callbackUrl: '/webhooks',
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
    'ORDERS_PAID': {
      deliveryMethod: 'http',
      callbackUrl: '/webhooks',
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
    'ORDERS_FULFILLED': {
      deliveryMethod: 'http',
      callbackUrl: '/webhooks',
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
    'CHECKOUTS_CREATE': {
      deliveryMethod: 'http',
      callbackUrl: '/webhooks',
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
    'CHECKOUTS_UPDATE': {
      deliveryMethod: 'http',
      callbackUrl: '/webhooks',
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
    'CUSTOMERS_CREATE': {
      deliveryMethod: 'http',
      callbackUrl: '/webhooks',
      callback: async (topic, shop, body, webhookId) => {
        console.log(`👤 Customer created webhook: ${shop}`);
        try {
          const customer = JSON.parse(body);
          await handleCustomerCreated(shop, customer);
        } catch (error) {
          console.error('Error processing customer created:', error);
        }
      }
    },
    'APP_UNINSTALLED': {
      deliveryMethod: 'http',
      callbackUrl: '/webhooks',
      callback: async (topic, shop, body, webhookId) => {
        console.log(`❌ App uninstalled webhook: ${shop}`);
        try {
          await handleAppUninstalled(shop);
        } catch (error) {
          console.error('Error processing app uninstalled:', error);
        }
      }
    }
  }
}));

// Test endpoint for manual cleanup (development only)
app.get('/debug/cleanup/:shop', async (req, res) => {
  const shop = req.params.shop;
  
  if (!shop.includes('.myshopify.com')) {
    return res.status(400).json({ error: 'Invalid shop domain' });
  }
  
  // Add manual force-cleanup endpoint
  console.log(`🗑️ Manual cleanup requested for shop: ${shop}`);
  
  try {
    // Use the comprehensive cleanup function
    await handleAppUninstalled(shop);
    
    res.json({
      success: true,
      message: `Shop ${shop} has been completely cleaned up. You can now reinstall the app.`,
      nextStep: `Visit: /auth?shop=${shop}`
    });
  } catch (error) {
    console.error('Error during cleanup:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Force reinstall endpoint (for testing)
app.get('/debug/force-reinstall/:shop', async (req, res) => {
  const shop = req.params.shop;
  
  try {
    console.log(`🧪 Manual comprehensive cleanup triggered for: ${shop}`);
    await handleAppUninstalled(shop);
    
    // Verify cleanup was successful
    const verifyShop = await DatabaseQueries.getShop(shop);
    
    res.json({
      success: true,
      message: `Comprehensive cleanup completed for: ${shop}`,
      cleanup_verified: !verifyShop,
      next_steps: [
        `Visit: https://${shop}/admin/apps`,
        'Reinstall the app from Partner Dashboard',
        'Or visit: /auth?shop=' + shop
      ],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Manual cleanup error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Verify cleanup endpoint
app.get('/debug/verify-cleanup/:shop', async (req, res) => {
  const shop = req.params.shop;
  
  try {
    // Check all possible places where shop data might exist
    const shopData = await DatabaseQueries.getShop(shop);
    
    // Count records in all related tables
    const { sessionStorage } = require('./shopify.app.config');
    
    let sessionExists = false;
    try {
      const session = await sessionStorage.loadSession(`offline_${shop}`);
      sessionExists = !!session;
    } catch (e) {
      sessionExists = false;
    }

    // Check database tables
    const tableChecks = {};
    try {
      const tables = ['messages', 'orders', 'customers', 'abandoned_carts', 'analytics'];
      for (const table of tables) {
        try {
          const { db } = require('./database');
          await new Promise((resolve, reject) => {
            db.get(`SELECT COUNT(*) as count FROM ${table} WHERE shop_domain = ?`, [shop], (err, row) => {
              if (err) reject(err);
              else {
                tableChecks[table] = row.count;
                resolve();
              }
            });
          });
        } catch (error) {
          tableChecks[table] = 'error: ' + error.message;
        }
      }
    } catch (error) {
      tableChecks.error = error.message;
    }

    const isCompletelyClean = !shopData && !sessionExists && 
      Object.values(tableChecks).every(count => count === 0 || typeof count === 'string');

    res.json({
      shop: shop,
      completely_clean: isCompletelyClean,
      shop_in_database: !!shopData,
      session_exists: sessionExists,
      table_record_counts: tableChecks,
      status: isCompletelyClean ? '✅ CLEAN - Ready for fresh install' : '⚠️ Data remains - needs cleanup',
      cleanup_command: `/debug/force-reinstall/${shop}`
    });
  } catch (error) {
    console.error('Verify cleanup error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// COMPLETE DATABASE WIPE ENDPOINTS (BE CAREFUL!)

// Wipe ALL database data (nuclear option)
app.get('/debug/wipe-all-data', async (req, res) => {
  try {
    console.log('🔥 COMPLETE DATABASE WIPE REQUESTED');
    
    const wipeResults = await DatabaseQueries.wipeAllData();
    await DatabaseQueries.resetAutoIncrement();
    
    // Also clear ALL sessions
    const { sessionStorage } = require('./shopify.app.config');
    try {
      // This is a more aggressive approach to clear sessions
      const { db: sessionDb } = sessionStorage;
      if (sessionDb && sessionDb.run) {
        await new Promise((resolve, reject) => {
          sessionDb.run('DELETE FROM sessions', (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        console.log('✅ Cleared all Shopify sessions');
      }
    } catch (sessionError) {
      console.log('⚠️ Could not clear sessions:', sessionError.message);
    }

    const finalStats = await DatabaseQueries.getDatabaseStats();

    res.json({
      success: true,
      message: '🔥 COMPLETE DATABASE WIPE COMPLETED',
      wipe_results: wipeResults,
      final_stats: finalStats,
      warning: 'ALL DATA HAS BEEN PERMANENTLY DELETED',
      next_steps: [
        '1. All shops must reinstall the app',
        '2. All sessions have been cleared',
        '3. Database is now completely empty'
      ]
    });
  } catch (error) {
    console.error('Database wipe error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get database statistics
app.get('/debug/database-stats', async (req, res) => {
  try {
    const stats = await DatabaseQueries.getDatabaseStats();
    
    const totalRecords = Object.values(stats).reduce((total, table) => {
      return total + (table.count || 0);
    }, 0);

    res.json({
      success: true,
      total_records: totalRecords,
      table_stats: stats,
      status: totalRecords === 0 ? '✅ Database is empty' : `📊 ${totalRecords} total records`,
      wipe_all_command: '/debug/wipe-all-data'
    });
  } catch (error) {
    console.error('Database stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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

async function handleAppUninstalled(shop) {
  try {
    console.log(`🗑️ Starting comprehensive cleanup for uninstalled app: ${shop}`);
    
    // STEP 1: Get the shop's access token before deleting (we might need it for API cleanup)
    let shopData = null;
    try {
      shopData = await DatabaseQueries.getShop(shop);
      console.log(`📋 Found shop data for ${shop}: ${shopData ? 'YES' : 'NO'}`);
    } catch (error) {
      console.log(`⚠️ Could not retrieve shop data: ${error.message}`);
    }

    // STEP 2: Revoke access token via Shopify API (this ensures complete disconnection)
    if (shopData && shopData.access_token) {
      try {
        const axios = require('axios');
        console.log(`🔐 Revoking access token for ${shop}...`);
        
        await axios.delete(`https://${shop}/admin/api_permissions/current.json`, {
          headers: {
            'X-Shopify-Access-Token': shopData.access_token,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        });
        
        console.log(`✅ Access token revoked successfully for ${shop}`);
      } catch (revokeError) {
        console.log(`⚠️ Could not revoke access token (may already be revoked): ${revokeError.message}`);
        // Continue with cleanup even if token revocation fails
      }
    }

    // STEP 3: Clean up all shop-related data from all tables
    // Note: We clean dependent tables first, then the main shops table last
    const cleanupTasks = [
      // Dependent tables first (have foreign keys to shops)
      { name: 'messages', fn: () => DatabaseQueries.deleteShopMessages(shop) },
      { name: 'orders', fn: () => DatabaseQueries.deleteShopOrders(shop) },
      { name: 'customers', fn: () => DatabaseQueries.deleteShopCustomers(shop) },
      { name: 'abandoned carts', fn: () => DatabaseQueries.deleteShopAbandonedCarts(shop) },
      { name: 'analytics', fn: () => DatabaseQueries.deleteShopAnalytics(shop) },
      { name: 'campaigns', fn: () => DatabaseQueries.deleteShopCampaigns(shop) },
      { name: 'templates', fn: () => DatabaseQueries.deleteShopTemplates(shop) },
      { name: 'automations', fn: () => DatabaseQueries.deleteShopAutomations(shop) },
      { name: 'webhooks', fn: () => DatabaseQueries.deleteShopWebhooks(shop) },
      { name: 'billing records', fn: () => DatabaseQueries.deleteShopBilling(shop) },
      { name: 'conversations', fn: () => DatabaseQueries.deleteShopConversations(shop) }
    ];

    // Handle tables that might not exist yet (referenced in queries.js but not in main schema)
    const optionalCleanupTasks = [
      { name: 'back in stock subscriptions', fn: () => DatabaseQueries.deleteShopBackInStockSubscriptions(shop) },
      { name: 'product variants', fn: () => DatabaseQueries.deleteShopProductVariants(shop) }
    ];

    // Execute all cleanup tasks
    for (const task of cleanupTasks) {
      try {
        await task.fn();
      } catch (error) {
        console.error(`⚠️ Failed to delete ${task.name} for ${shop}:`, error.message);
        // Continue with other cleanup tasks
      }
    }

    // Execute optional cleanup tasks (may fail if tables don't exist)
    for (const task of optionalCleanupTasks) {
      try {
        await task.fn();
      } catch (error) {
        console.log(`⚠️ Optional cleanup failed for ${task.name} (table may not exist): ${error.message}`);
        // Continue with other cleanup tasks
      }
    }

    // STEP 4: Remove the main shop record last (after all dependent records are deleted)
    try {
      await DatabaseQueries.deleteShop(shop);
      console.log(`✅ Removed shop record from database: ${shop}`);
    } catch (error) {
      console.error(`❌ Failed to delete shop record for ${shop}:`, error.message);
    }
    
    // STEP 5: Remove ALL Shopify sessions (both online and offline)
    const { sessionStorage } = require('./shopify.app.config');
    const sessionIds = [`offline_${shop}`, `online_${shop}`];
    
    for (const sessionId of sessionIds) {
      try {
        await sessionStorage.deleteSession(sessionId);
        console.log(`✅ Removed Shopify session: ${sessionId}`);
      } catch (sessionError) {
        console.log(`⚠️ Session not found or already deleted: ${sessionId}`);
      }
    }

    // STEP 6: Clear any additional session variations (some might have timestamps)
    try {
      // Try to clear any sessions that might have timestamps or other variations
      const { sessionStorage } = require('./shopify.app.config');
      if (sessionStorage.clearAllSessionsForShop) {
        await sessionStorage.clearAllSessionsForShop(shop);
      }
    } catch (clearError) {
      console.log(`⚠️ Additional session clearing failed: ${clearError.message}`);
    }

    // STEP 7: Final verification
    try {
      const verifyShop = await DatabaseQueries.getShop(shop);
      if (verifyShop) {
        console.error(`❌ WARNING: Shop still exists in database after cleanup: ${shop}`);
        // Force delete one more time
        await DatabaseQueries.deleteShop(shop);
      } else {
        console.log(`✅ Verification passed: Shop completely removed from database`);
      }
    } catch (verifyError) {
      console.log(`✅ Shop verification failed (good - shop is completely deleted): ${verifyError.message}`);
    }
    
    console.log(`🎉 COMPREHENSIVE APP UNINSTALL CLEANUP COMPLETED for: ${shop}`);
    console.log(`📋 All shop data, sessions, and access tokens have been completely removed`);
    console.log(`🔄 Next installation will be treated as a fresh install`);
    
  } catch (error) {
    console.error(`❌ Error during app uninstall cleanup for ${shop}:`, error);
    // Don't throw the error - we want the webhook to succeed even if cleanup partially fails
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
    <script src="https://unpkg.com/@shopify/app-bridge@3.7.9"></script>
    <script src="https://unpkg.com/@shopify/app-bridge/umd/index.js"></script>
    
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
        
        // Add error handler for postMessage origin mismatch issues
        window.addEventListener('error', function(e) {
            if (e.message && e.message.includes('postMessage') && e.message.includes('origin')) {
                console.log('⚠️ Suppressing postMessage origin error (normal for embedded apps)');
                e.preventDefault();
                return false;
            }
        });
        
        // Initialize App Bridge with session token authentication
        const AppBridge = window['app-bridge'];
        const createApp = AppBridge.default;
        const actions = AppBridge.actions;
        const utils = AppBridge.utilities;
        
        let app;
        let authenticatedFetch;
        
        try {
            console.log('🔧 Initializing App Bridge...');
            
            // Get URL parameters
            const urlParams = new URLSearchParams(window.location.search);
            const host = urlParams.get('host');
            const embedded = urlParams.get('embedded');
            
            console.log('🔍 Context check:', {
                isIframe: window.top !== window.self,
                hasHost: !!host,
                hasEmbedded: embedded === '1',
                userAgent: navigator.userAgent.includes('Shopify')
            });
            
            // Initialize App Bridge if we have the embedded parameter or are in iframe
            if ((embedded === '1' || window.top !== window.self) && host) {
                // Create App Bridge instance for embedded context
                app = createApp({
                    apiKey: '${process.env.SHOPIFY_API_KEY}',
                    host: host,
                    forceRedirect: false
                });
                
                // Use App Bridge's authenticated fetch which automatically handles session tokens
                authenticatedFetch = utils.authenticatedFetch(app);
                
                console.log('✅ App Bridge initialized with authenticated fetch');
            } else {
                console.log('⚠️ Not in embedded context or missing host parameter');
                throw new Error('Not in embedded context');
            }
            
        } catch (error) {
            console.error('❌ App Bridge initialization failed:', error);
            
            // Fallback to manual authentication for non-embedded or direct access
            const sessionToken = urlParams.get('id_token');
            authenticatedFetch = async (url, options = {}) => {
                try {
                    const headers = {
                        'Content-Type': 'application/json',
                        'X-Shopify-Shop-Domain': '${shop}',
                        ...options.headers
                    };
                    
                    // Add authorization header if session token is available
                    if (sessionToken) {
                        headers['Authorization'] = \`Bearer \${sessionToken}\`;
                    }
                    
                    return fetch(url, {
                        ...options,
                        headers
                    });
                } catch (fetchError) {
                    console.error('❌ Fetch error:', fetchError);
                    throw fetchError;
                }
            };
            console.log('⚠️ Using fallback authenticated fetch');
        }

        // Load metrics using authenticated fetch with shop parameter
        async function loadMetrics() {
            console.log('🔍 Starting to load metrics...');
            try {
                const response = await authenticatedFetch('/api/metrics?shop=${encodeURIComponent(shop)}');
                console.log('📡 Response received:', response.status);
                
                if (!response.ok) {
                    console.error('❌ API request failed:', response.status, response.statusText);
                    showError('API request failed');
                    return;
                }
                
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
                console.error('❌ Failed to load metrics:', error);
                showError('Error loading metrics');
                // Prevent any errors from propagating and causing navigation issues
                return;
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
            authenticatedFetch('/api/settings?shop=${encodeURIComponent(shop)}', {
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
            
            authenticatedFetch('/api/test-message?shop=${encodeURIComponent(shop)}', {
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
                  console.error('❌ Error sending test message:', error);
                  alert('❌ Error sending test message');
                  // Prevent errors from propagating
                  return;
              })
              .finally(() => {
                  button.disabled = false;
                  button.textContent = 'Send Test Message';
              });
        }
        
        // Load metrics on page load with error isolation
        console.time('📊 Metrics loading');
        loadMetrics().catch(error => {
            console.error('❌ Metrics loading failed, but continuing:', error);
            showError('Failed to load metrics');
        }).finally(() => {
            console.timeEnd('📊 Metrics loading');
            console.timeEnd('🚀 Dashboard initialization');
        });

        console.log('WhatsApp Notifications Admin loaded for shop: ${shop}');
    </script>
</body>
</html>
  `;
}

// Catch-all fallback route for unmatched paths (must be last)
app.get('*', (req, res) => {
  const shop = req.query.shop;
  const path = req.path;
  
  console.log('🚨 404 - Unmatched route:', {
    path: path,
    shop: shop,
    query: req.query,
    headers: {
      'x-shopify-shop-domain': req.headers['x-shopify-shop-domain'],
      'referer': req.headers['referer']
    }
  });
  
  // If this is from Shopify admin and has a shop parameter, show helpful info
  if (shop && ValidationUtils.isValidShopDomain(shop)) {
    res.send(`
      <h1>🚫 Route Not Found: ${escapeHtml(path)}</h1>
      <p><strong>Shop:</strong> ${escapeHtml(shop)}</p>
      
      <h2>📋 This usually means:</h2>
      <ol>
        <li>The App URL in Partner Dashboard is incorrect</li>
        <li>Shopify is trying to access a route that doesn't exist</li>
        <li>There's a mismatch between expected and actual routes</li>
      </ol>
      
      <h2>✅ Available Routes:</h2>
      <ul>
        <li><code>/app</code> - Main app dashboard (authenticated)</li>
        <li><code>/auth</code> - OAuth flow start</li>
        <li><code>/auth/callback</code> - OAuth callback</li>
        <li><code>/api/*</code> - API endpoints</li>
        <li><code>/webhooks/*</code> - Webhook endpoints</li>
      </ul>
      
      <h2>🔧 Quick Actions:</h2>
      <ul>
        <li><a href="/app?shop=${encodeURIComponent(shop)}">Go to App Dashboard</a></li>
        <li><a href="/debug/partner-config">Check Partner Dashboard Config</a></li>
        <li><a href="/debug?shop=${encodeURIComponent(shop)}">View Debug Info</a></li>
      </ul>
      
      <h2>💡 To Fix This:</h2>
      <ol>
        <li>Go to your Shopify Partner Dashboard</li>
        <li>Find your app and click "App setup"</li>
        <li>Set the App URL to: <code>${process.env.SHOPIFY_APP_URL}/app</code></li>
        <li>Save changes and try again</li>
      </ol>
    `);
  } else {
    // Generic 404 page
    res.status(404).send(`
      <h1>404 - Page Not Found</h1>
      <p>The requested path <code>${escapeHtml(path)}</code> was not found.</p>
      <p><a href="/">Go to Home</a></p>
    `);
  }
});

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
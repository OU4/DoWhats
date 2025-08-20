const express = require('express');
const dotenv = require('dotenv');
const crypto = require('crypto');
const { db, initializeDatabase } = require('./database');
const bodyParser = require('body-parser');
const DatabaseQueries = require('./database/queries');
const { body, query, param, validationResult } = require('express-validator');
const validator = require('validator');
const escapeHtml = require('escape-html');
const { parsePhoneNumber, isValidPhoneNumber } = require('libphonenumber-js');

// Load environment variables - prefer .env.local for development
const fs = require('fs');
if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
} else {
  dotenv.config();
}

// Validate required environment variables
function validateEnvironment() {
  const requiredVars = [
    'SHOPIFY_API_KEY',
    'SHOPIFY_API_SECRET',
    'SHOPIFY_WEBHOOK_SECRET',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_WHATSAPP_NUMBER'
  ];

  const missing = requiredVars.filter(varName => !process.env[varName]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(varName => console.error(`   - ${varName}`));
    console.error('\n💡 Copy .env.example to .env and fill in your credentials');
    process.exit(1);
  }
}

// Validate environment on startup
validateEnvironment();

// Simple in-memory cache for metrics (expires after 2 minutes)
const metricsCache = new Map();
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes in milliseconds

function getCachedMetrics(shop) {
  const cached = metricsCache.get(shop);
  if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
    return cached.data;
  }
  return null;
}

function setCachedMetrics(shop, metrics) {
  metricsCache.set(shop, {
    data: metrics,
    timestamp: Date.now()
  });
}

// Shopify webhook verification middleware
function verifyShopifyWebhook(req, res, next) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const body = JSON.stringify(req.body);
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(body, 'utf8')
    .digest('base64');

  if (!hmac || hash !== hmac) {
    console.error('❌ Webhook verification failed:', {
      received_hmac: hmac,
      expected_hmac: hash,
      body_length: body.length
    });
    return res.status(401).send('Unauthorized: Invalid webhook signature');
  }

  next();
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Apply webhook verification to all Shopify webhook routes
app.use('/webhooks', (req, res, next) => {
  // Skip verification for non-Shopify webhooks (like Twilio)
  if (req.path.startsWith('/whatsapp')) {
    return next();
  }
  
  // Apply Shopify webhook verification
  verifyShopifyWebhook(req, res, next);
});

// Input validation utility functions
const ValidationUtils = {
  // Validate and sanitize shop domain
  isValidShopDomain(domain) {
    if (!domain || typeof domain !== 'string') return false;
    
    // Check if it's a valid Shopify domain format
    const shopifyDomainRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9]\.myshopify\.com$/;
    return shopifyDomainRegex.test(domain) && domain.length <= 100;
  },

  // Validate and format phone number
  validatePhone(phone) {
    if (!phone || typeof phone !== 'string') return null;
    
    try {
      // Remove all non-numeric characters
      const cleaned = phone.replace(/\D/g, '');
      
      // Must be 10-15 digits (international format)
      if (cleaned.length < 10 || cleaned.length > 15) return null;
      
      // Add country code if missing (assume +1 for US/Canada)
      let formatted = cleaned;
      if (!formatted.startsWith('1') && formatted.length === 10) {
        formatted = '1' + formatted;
      }
      
      return isValidPhoneNumber('+' + formatted) ? '+' + formatted : null;
    } catch (error) {
      return null;
    }
  },

  // Sanitize text for messages (prevent injection)
  sanitizeMessage(text) {
    if (!text || typeof text !== 'string') return '';
    
    // Remove potentially harmful characters and limit length
    return text
      .replace(/[<>\"'&]/g, '') // Remove HTML/script chars
      .replace(/[\r\n\t]+/g, ' ') // Replace line breaks with spaces
      .trim()
      .substring(0, 1000); // Limit message length
  },

  // Validate email format
  isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    return validator.isEmail(email) && email.length <= 254;
  },

  // Sanitize and validate currency
  validateCurrency(currency) {
    if (!currency || typeof currency !== 'string') return 'USD';
    
    const validCurrencies = ['USD', 'CAD', 'EUR', 'GBP', 'SAR', 'AED'];
    const cleaned = currency.toUpperCase().trim();
    
    return validCurrencies.includes(cleaned) ? cleaned : 'USD';
  },

  // Validate numeric values (prices, quantities, etc.)
  validateNumber(value, min = 0, max = 999999) {
    const num = parseFloat(value);
    if (isNaN(num) || num < min || num > max) return null;
    return num;
  }
};

// Express-validator middleware for handling validation errors
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

// Webhook data validation and sanitization middleware
const validateWebhookData = (req, res, next) => {
  try {
    const data = req.body;
    
    // Validate webhook data exists
    if (!data || typeof data !== 'object') {
      return res.status(400).json({error: 'Invalid webhook payload'});
    }

    // For order webhooks, validate critical fields
    if (req.path.includes('order')) {
      // Validate order structure
      if (data.id && typeof data.id !== 'number') {
        console.warn('⚠️ Invalid order ID format');
      }
      
      // Sanitize customer data if present
      if (data.customer) {
        if (data.customer.phone) {
          const validPhone = ValidationUtils.validatePhone(data.customer.phone);
          if (!validPhone) {
            console.warn('⚠️ Invalid phone number in webhook, skipping notification');
            data.customer.phone = null; // Remove invalid phone
          } else {
            data.customer.phone = validPhone; // Use sanitized phone
          }
        }
        
        // Sanitize customer name
        if (data.customer.first_name) {
          data.customer.first_name = ValidationUtils.sanitizeMessage(data.customer.first_name);
        }
        
        // Validate email if present
        if (data.customer.email && !ValidationUtils.isValidEmail(data.customer.email)) {
          console.warn('⚠️ Invalid email in webhook');
          data.customer.email = null;
        }
      }
      
      // Sanitize order name and other text fields
      if (data.name) {
        data.name = ValidationUtils.sanitizeMessage(data.name);
      }
      
      // Validate currency
      if (data.currency) {
        data.currency = ValidationUtils.validateCurrency(data.currency);
      }
      
      // Validate shop domain
      const shopDomain = data.shop_domain || req.get('X-Shopify-Shop-Domain');
      if (shopDomain && !ValidationUtils.isValidShopDomain(shopDomain)) {
        console.error('❌ Invalid shop domain in webhook');
        return res.status(400).json({error: 'Invalid shop domain'});
      }
    }
    
    // Store sanitized data back
    req.body = data;
    next();
    
  } catch (error) {
    console.error('❌ Webhook validation error:', error);
    return res.status(500).json({error: 'Webhook processing failed'});
  }
};

// Apply data validation to all webhook routes (after HMAC verification)
app.use('/webhooks', validateWebhookData);

// Helper function to ensure shop exists
async function ensureShopExists(shopDomain, req) {
  if (!shopDomain) {
    return false;
  }

  try {
    // Check if shop exists
    const existingShop = await DatabaseQueries.getShop(shopDomain);
    if (existingShop) {
      return true;
    }

    // Create shop with basic info from webhook
    console.log(`📝 Creating missing shop: ${shopDomain}`);
    await DatabaseQueries.createOrUpdateShop(shopDomain, 'webhook_access', {
      shop_name: shopDomain.split('.')[0],
      email: null,
      phone: null
    });

    return true;
  } catch (error) {
    console.error(`❌ Failed to create shop ${shopDomain}:`, error);
    return false;
  }
}

// Basic route - redirect to admin if shop parameter exists
app.get('/', (req, res) => {
  const shop = req.query.shop;
  
  // Log the request to debug
  console.log('🏠 Root route accessed:', {
    shop: shop,
    headers: req.headers,
    query: req.query,
    fullUrl: req.originalUrl
  });
  
  // If accessed from Shopify (with shop parameter), redirect to admin dashboard
  if (shop && ValidationUtils.isValidShopDomain(shop)) {
    console.log(`🔄 Redirecting to admin dashboard for shop: ${shop}`);
    // Preserve all query parameters when redirecting
    const queryString = new URLSearchParams(req.query).toString();
    return res.redirect(`/admin?${queryString}`);
  }
  
  // Otherwise show basic info page
  res.send(`
    <h1>WhatsApp Shopify App is running!</h1>
    <h3>🔗 Access Links:</h3>
    <ul>
      <li><strong>Admin Dashboard:</strong> <a href="/admin?shop=dowhatss1.myshopify.com">/admin?shop=dowhatss1.myshopify.com</a></li>
      <li><strong>Install on Shopify:</strong> <a href="/shopify?shop=dowhatss1.myshopify.com">/shopify?shop=dowhatss1.myshopify.com</a></li>
      <li><strong>Debug Config:</strong> <a href="/debug/config">/debug/config</a></li>
    </ul>
    <p><em>For Shopify embedded app, install via Partners Dashboard or use the links above.</em></p>
  `);
});

// Debug configuration endpoint
app.get('/debug/config', (req, res) => {
  res.json({
    app_status: '✅ Running',
    ngrok_url: process.env.SHOPIFY_APP_URL || 'Not configured',
    expected_callback: `${process.env.SHOPIFY_APP_URL}/shopify/callback`,
    shopify_partner_dashboard_settings: {
      'App URL': `${process.env.SHOPIFY_APP_URL}/admin`,
      'Allowed redirection URL(s)': [
        `${process.env.SHOPIFY_APP_URL}/shopify/callback`,
        `${process.env.SHOPIFY_APP_URL}/admin`
      ]
    },
    fix_instructions: {
      step1: 'Go to Shopify Partner Dashboard → Apps → Your App → Configuration',
      step2: `Set "App URL" to: ${process.env.SHOPIFY_APP_URL}/admin`,
      step3: `Add to "Allowed redirection URL(s)": ${process.env.SHOPIFY_APP_URL}/shopify/callback`,
      step4: 'Save changes and reinstall the app'
    }
  });
});

// Shopify Admin App Route (Embedded App)
app.get('/admin', [
  query('shop').isString().matches(/^[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9]\.myshopify\.com$/),
  handleValidationErrors
], async (req, res) => {
  const startTime = Date.now();
  const shop = req.query.shop;
  const isEmbedded = req.query.embedded === '1';
  
  if (!ValidationUtils.isValidShopDomain(shop)) {
    return res.status(400).json({error: 'Invalid shop domain'});
  }

  console.log(`🔍 Admin page requested for: ${shop} (embedded: ${isEmbedded})`);

  // Check if shop is authenticated
  const dbStartTime = Date.now();
  const shopData = await DatabaseQueries.getShop(shop);
  console.log(`📊 Database query took: ${Date.now() - dbStartTime}ms`);

  if (!shopData) {
    console.log(`❌ Shop not found, redirecting to installation: ${shop}`);
    // Redirect to app installation
    return res.redirect(`/shopify?shop=${shop}`);
  }

  // Render the embedded app page with loading state (metrics load async)
  const renderTime = Date.now();
  const html = generateAdminPage(shop, shopData, null);
  console.log(`🎨 Page generation took: ${Date.now() - renderTime}ms`);
  console.log(`⚡ Total admin page load: ${Date.now() - startTime}ms`);
  
  res.send(html);
});

// Generate Shopify Admin Page with App Bridge
function generateAdminPage(shop, shopData, metrics) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <title>WhatsApp Notifications - ${escapeHtml(shop)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    
    <!-- Shopify Polaris CSS -->
    <link rel="stylesheet" href="https://unpkg.com/@shopify/polaris@12.0.0/build/esm/styles.css" />
    
    <!-- App Bridge - Latest Stable Version -->
    <script src="https://cdn.shopify.com/shopifycloud/app-bridge/shopify-app-bridge-3.1.0.js" onerror="console.warn('⚠️ Failed to load App Bridge from CDN')"></script>
    
    <style>
        body { 
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            margin: 0;
            background: #f6f6f7;
        }
        .app-container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }
        .status-card {
            background: white;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 20px;
            border: 1px solid #e1e3e5;
            box-shadow: 0 1px 0 0 rgba(22, 29, 37, 0.05);
        }
        .status-indicator {
            display: inline-flex;
            align-items: center;
            font-weight: 600;
            font-size: 14px;
        }
        .status-indicator.active { color: #008060; }
        .status-indicator.inactive { color: #bf0711; }
        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 8px;
        }
        .status-dot.active { background: #008060; }
        .status-dot.inactive { background: #bf0711; }
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
            font-size: 14px;
            font-weight: 600;
            color: #202223;
        }
        .toggle-info p {
            margin: 0;
            font-size: 13px;
            color: #6d7175;
        }
        .toggle-switch {
            position: relative;
            width: 44px;
            height: 24px;
            background: #e1e3e5;
            border-radius: 12px;
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
        .secondary-button {
            background: #f6f6f7;
            color: #202223;
            border: 1px solid #c9cccf;
            padding: 12px 24px;
            border-radius: 6px;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            transition: background 0.2s;
        }
        .secondary-button:hover {
            background: #f1f2f3;
        }
        .button-group {
            display: flex;
            gap: 12px;
            margin-top: 16px;
        }
        .alert-banner {
            background: #fef7e0;
            border: 1px solid #f1c40f;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
        }
        .alert-banner.success {
            background: #f0f9f4;
            border-color: #008060;
        }
        .alert-icon {
            margin-right: 12px;
            font-size: 16px;
        }
    </style>
</head>
<body>
    <div class="app-container">
        <!-- Header -->
        <div class="status-card">
            <h1 style="margin: 0 0 16px 0; font-size: 28px; color: #202223;">WhatsApp Notifications</h1>
            <div style="display: flex; align-items: center; justify-content: space-between;">
                <div class="status-indicator ${shopData.is_active ? 'active' : 'inactive'}">
                    <div class="status-dot ${shopData.is_active ? 'active' : 'inactive'}"></div>
                    ${shopData.is_active ? 'Active' : 'Inactive'}
                </div>
                <div style="font-size: 14px; color: #6d7175;">
                    Shop: ${escapeHtml(shop)}
                </div>
            </div>
        </div>

        <!-- Quick Setup Banner -->
        ${(!process.env.TWILIO_ACCOUNT_SID || 
           !process.env.TWILIO_AUTH_TOKEN || 
           !process.env.TWILIO_ACCOUNT_SID.startsWith('AC') ||
           process.env.TWILIO_ACCOUNT_SID === 'your_twilio_account_sid_here') ? `
        <div class="alert-banner">
            <div class="alert-icon">⚠️</div>
            <div>
                <strong>Setup Required:</strong> Configure your Twilio WhatsApp credentials to start sending notifications.
                <a href="#twilio-setup" style="color: #1a73e8; text-decoration: none; font-weight: 600;">Configure now →</a>
            </div>
        </div>
        ` : `
        <div class="alert-banner success">
            <div class="alert-icon">✅</div>
            <div>
                <strong>Ready to go!</strong> Your WhatsApp notifications are configured and active.
            </div>
        </div>
        `}

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
                
                <div class="toggle-setting">
                    <div class="toggle-info">
                        <h3>Marketing Messages</h3>
                        <p>Send promotional offers and marketing campaigns</p>
                    </div>
                    <div class="toggle-switch" onclick="toggleSetting(this, 'marketing')"></div>
                </div>

                <div class="button-group">
                    <button class="test-button" onclick="sendTestMessage()">Send Test Message</button>
                    <button class="secondary-button" onclick="viewCustomers()">Manage Customers</button>
                </div>
            </div>
        </div>

        <!-- Message Templates -->
        <div class="settings-section">
            <div class="settings-header">
                <h2>Message Templates</h2>
            </div>
            <div class="settings-content">
                <p style="color: #6d7175; margin-bottom: 16px;">
                    Customize WhatsApp messages sent to your customers
                </p>
                <div class="button-group">
                    <button class="secondary-button" onclick="editTemplates()">Edit Templates</button>
                    <button class="secondary-button" onclick="previewTemplates()">Preview Messages</button>
                </div>
            </div>
        </div>

        <!-- Analytics -->
        <div class="settings-section">
            <div class="settings-header">
                <h2>Analytics & Reports</h2>
            </div>
            <div class="settings-content">
                <p style="color: #6d7175; margin-bottom: 16px;">
                    Track message delivery, customer engagement, and ROI
                </p>
                <div class="button-group">
                    <button class="secondary-button" onclick="viewAnalytics()">View Full Report</button>
                    <button class="secondary-button" onclick="exportData()">Export Data</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        console.time('🚀 Dashboard initialization');
        console.time('📦 App Bridge setup');
        
        // Initialize Shopify App Bridge with retry logic
        function initializeAppBridge() {
            let app = null;
            try {
                if (window.ShopifyAppBridge) {
                    const AppBridge = window.ShopifyAppBridge;
                    app = AppBridge.createApp({
                        apiKey: '${process.env.SHOPIFY_API_KEY}',
                        shopOrigin: '${shop}',
                    });
                    
                    // Configure title bar if available
                    if (AppBridge.actions && AppBridge.actions.TitleBar) {
                        const titleBar = AppBridge.actions.TitleBar.create(app, {
                            title: 'WhatsApp Notifications',
                        });
                    }
                    
                    console.log('✅ App Bridge initialized successfully');
                    console.timeEnd('📦 App Bridge setup');
                    return true;
                } else {
                    return false;
                }
            } catch (error) {
                console.error('❌ App Bridge initialization failed:', error);
                console.timeEnd('📦 App Bridge setup');
                return false;
            }
        }
        
        // Try immediate initialization, fallback after delay
        if (!initializeAppBridge()) {
            setTimeout(() => {
                if (!initializeAppBridge()) {
                    console.warn('⚠️ App Bridge not available - dashboard running in standalone mode');
                    console.timeEnd('📦 App Bridge setup');
                }
            }, 1000);
        }

        // App functions
        function toggleSetting(element, setting) {
            element.classList.toggle('active');
            const isActive = element.classList.contains('active');
            
            // Save setting to backend
            fetch('/api/settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Shop-Domain': '${shop}'
                },
                body: JSON.stringify({
                    setting: setting,
                    enabled: isActive
                })
            }).then(response => response.json())
              .then(data => {
                  console.log('Setting updated:', data);
              })
              .catch(error => {
                  console.error('Error updating setting:', error);
                  // Revert toggle on error
                  element.classList.toggle('active');
              });
        }

        function sendTestMessage() {
            const button = event.target;
            button.disabled = true;
            button.textContent = 'Sending...';
            
            fetch('/api/test-message', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Shop-Domain': '${shop}'
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
                  alert('❌ Error sending test message');
                  console.error('Error:', error);
              })
              .finally(() => {
                  button.disabled = false;
                  button.textContent = 'Send Test Message';
              });
        }

        function viewCustomers() {
            window.location.href = '/admin/customers?shop=${shop}';
        }

        function editTemplates() {
            window.location.href = '/admin/templates?shop=${shop}';
        }

        function previewTemplates() {
            window.location.href = '/admin/templates/preview?shop=${shop}';
        }

        function viewAnalytics() {
            window.location.href = '/admin/analytics?shop=${shop}';
        }

        function exportData() {
            window.location.href = '/api/export?shop=${shop}';
        }

        // Auto-refresh metrics every 30 seconds
        setInterval(() => {
            fetch('/api/metrics?shop=${shop}')
                .then(response => response.json())
                .then(data => {
                    // Update metrics display
                    if (data.success) {
                        updateMetrics(data.metrics);
                    }
                })
                .catch(error => console.log('Metrics update failed:', error));
        }, 30000);

        // Load metrics asynchronously
        async function loadMetrics() {
            try {
                const response = await fetch('/api/metrics?shop=${encodeURIComponent(shop)}');
                const data = await response.json();
                
                if (data.success) {
                    updateMetrics(data.metrics);
                }
            } catch (error) {
                console.error('Failed to load metrics:', error);
                // Show error state
                document.getElementById('monthly-messages').innerHTML = '<span style="color: #d72c0d;">Error</span>';
                document.getElementById('delivery-rate').innerHTML = '<span style="color: #d72c0d;">Error</span>';
                document.getElementById('active-customers').innerHTML = '<span style="color: #d72c0d;">Error</span>';
            }
        }

        function updateMetrics(metrics) {
            document.getElementById('monthly-messages').textContent = metrics.monthly_messages || 0;
            document.getElementById('delivery-rate').textContent = (metrics.delivery_rate || 0) + '%';
            document.getElementById('active-customers').textContent = metrics.active_customers || 0;
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

// API endpoint for updating settings
app.post('/api/settings', [
  body('setting').isString().isIn(['order_confirmation', 'shipping_updates', 'abandoned_cart', 'marketing']),
  body('enabled').isBoolean(),
  handleValidationErrors
], async (req, res) => {
  const { setting, enabled } = req.body;
  const shop = req.get('X-Shopify-Shop-Domain');
  
  if (!ValidationUtils.isValidShopDomain(shop)) {
    return res.status(400).json({error: 'Invalid shop domain'});
  }

  try {
    // Update setting in database (you'll need to add this to DatabaseQueries)
    const settings = {
      [setting]: enabled
    };
    
    // For now, we'll just log it (implement database storage later)
    console.log(`📝 Settings updated for ${shop}:`, settings);
    
    res.json({
      success: true,
      message: `${setting} ${enabled ? 'enabled' : 'disabled'}`
    });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({error: 'Failed to update settings'});
  }
});

// API endpoint for loading metrics asynchronously
app.get('/api/metrics', [
  query('shop').custom(ValidationUtils.isValidShopDomain),
  handleValidationErrors
], async (req, res) => {
  const shop = req.query.shop;
  
  try {
    // Check cache first
    const cachedMetrics = getCachedMetrics(shop);
    if (cachedMetrics) {
      return res.json({
        success: true,
        metrics: cachedMetrics
      });
    }

    // Get metrics from database asynchronously
    const messageStats = await DatabaseQueries.getMessageStats(shop, 30);
    const customerStats = await DatabaseQueries.getCustomerSegments(shop);
    
    // Calculate delivery rate
    const deliveryRate = messageStats.total_messages > 0 
      ? Math.round((messageStats.delivered / messageStats.total_messages) * 100)
      : 0;

    const metrics = {
      monthly_messages: messageStats.total_messages || 0,
      delivery_rate: deliveryRate,
      active_customers: customerStats.active_customers || 0,
      unique_customers: messageStats.unique_customers || 0
    };

    // Cache the results
    setCachedMetrics(shop, metrics);

    res.json({
      success: true,
      metrics
    });
  } catch (error) {
    console.error('Error loading metrics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to load metrics'
    });
  }
});

// API endpoint for sending test messages
app.post('/api/test-message', async (req, res) => {
  const shop = req.get('X-Shopify-Shop-Domain');
  
  if (!ValidationUtils.isValidShopDomain(shop)) {
    return res.status(400).json({error: 'Invalid shop domain'});
  }

  try {
    const shopData = await DatabaseQueries.getShop(shop);
    if (!shopData) {
      return res.status(404).json({error: 'Shop not found'});
    }

    // Get test phone from environment
    const testPhone = process.env.TEST_PHONE_NUMBER;
    if (!testPhone) {
      return res.status(400).json({error: 'Test phone number not configured'});
    }

    const validPhone = ValidationUtils.validatePhone(testPhone);
    if (!validPhone) {
      return res.status(400).json({error: 'Invalid test phone number'});
    }

    // Check if Twilio is configured
    if (!process.env.TWILIO_ACCOUNT_SID || 
        !process.env.TWILIO_AUTH_TOKEN || 
        !process.env.TWILIO_ACCOUNT_SID.startsWith('AC') ||
        process.env.TWILIO_ACCOUNT_SID === 'your_twilio_account_sid_here') {
      return res.status(400).json({
        error: 'Twilio not configured',
        message: 'Please configure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_WHATSAPP_NUMBER in your .env file'
      });
    }

    // Send test message using Twilio
    const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    const result = await twilioClient.messages.create({
      body: `🎉 Test message from your WhatsApp Shopify app!\n\nShop: ${shop}\nTime: ${new Date().toLocaleString()}\n\nIf you received this, your setup is working perfectly! ✅`,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${validPhone}`
    });

    console.log('✅ Test message sent:', result.sid);
    
    res.json({
      success: true,
      message: 'Test message sent successfully',
      messageSid: result.sid
    });
  } catch (error) {
    console.error('Error sending test message:', error);
    res.status(500).json({
      error: 'Failed to send test message',
      details: error.message
    });
  }
});

// API endpoint for getting metrics
app.get('/api/metrics', async (req, res) => {
  const shop = req.query.shop;
  
  if (!ValidationUtils.isValidShopDomain(shop)) {
    return res.status(400).json({error: 'Invalid shop domain'});
  }

  try {
    const shopData = await DatabaseQueries.getShop(shop);
    if (!shopData) {
      return res.status(404).json({error: 'Shop not found'});
    }

    // Get real metrics from database
    const messageStats = await DatabaseQueries.getMessageStats(shop, 30);
    const customerStats = await DatabaseQueries.getCustomerSegments(shop);
    
    // Calculate real delivery rate
    const deliveryRate = messageStats.total_messages > 0 
      ? Math.round((messageStats.delivered / messageStats.total_messages) * 100)
      : 0;
    
    const metrics = {
      monthly_messages: messageStats.total_messages || 0,
      delivery_rate: deliveryRate,
      active_customers: customerStats.active_customers || 0,
      unique_customers: messageStats.unique_customers || 0
    };

    res.json({
      success: true,
      metrics: metrics
    });
  } catch (error) {
    console.error('Error getting metrics:', error);
    res.status(500).json({error: 'Failed to get metrics'});
  }
});

// Webhook security test endpoint (development only)
app.get('/webhooks/test-security', (req, res) => {
  res.json({
    message: 'Webhook security is active!',
    security_status: {
      hmac_verification: '✅ Enabled',
      protected_routes: '/webhooks/* (except /webhooks/whatsapp/*)',
      environment_check: process.env.SHOPIFY_WEBHOOK_SECRET ? '✅ Secret configured' : '❌ Secret missing'
    },
    instructions: {
      step1: 'Get webhook secret from Shopify Partner Dashboard',
      step2: 'Add SHOPIFY_WEBHOOK_SECRET to your .env file',
      step3: 'All webhook requests must include valid X-Shopify-Hmac-Sha256 header'
    }
  });
});

// Shopify App Installation Route
app.get('/shopify', [
  query('shop').isString().isLength({min: 1, max: 100}).matches(/^[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9]\.myshopify\.com$/),
  handleValidationErrors
], (req, res) => {
  const shop = req.query.shop;
  
  // Additional validation using our utility
  if (!ValidationUtils.isValidShopDomain(shop)) {
    return res.status(400).json({error: 'Invalid shop domain format'});
  }

  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${process.env.SHOPIFY_APP_URL}/shopify/callback`;
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=${process.env.SHOPIFY_SCOPES}&state=${state}&redirect_uri=${redirectUri}`;

  res.cookie('state', state);
  res.redirect(installUrl);
});

// Add fallback for Partner Dashboard misconfiguration 
app.get('/oauth/callback', (req, res) => {
  console.warn('⚠️ OAuth callback hit wrong route - check Partner Dashboard settings');
  console.warn('Expected:', `${process.env.SHOPIFY_APP_URL}/shopify/callback`);
  console.warn('Got request to:', req.originalUrl);
  res.redirect(`/shopify/callback?${req.url.split('?')[1]}`);
});

// Shopify OAuth Callback
app.get('/shopify/callback', [
  query('shop').isString().matches(/^[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9]\.myshopify\.com$/),
  query('code').isString().isLength({min: 10, max: 200}).matches(/^[a-zA-Z0-9]+$/),
  query('hmac').optional().isString().isLength({max: 200}),
  query('state').optional().isString().isLength({max: 100}),
  handleValidationErrors
], async (req, res) => {
  const { shop, hmac, code, state } = req.query;
  
  // Validate shop domain
  if (!ValidationUtils.isValidShopDomain(shop)) {
    return res.status(400).json({error: 'Invalid shop domain'});
  }
  
  const accessTokenRequestUrl = `https://${shop}/admin/oauth/access_token`;
  const accessTokenPayload = {
    client_id: process.env.SHOPIFY_API_KEY,
    client_secret: process.env.SHOPIFY_API_SECRET,
    code,
  };

  try {
    const axios = require('axios');
    const response = await axios.post(accessTokenRequestUrl, accessTokenPayload);
    const accessToken = response.data.access_token;
    
    // Store this access token in your database associated with the shop
    console.log('✅ OAuth successful for shop:', shop);
    
    // Store shop data in database
    await DatabaseQueries.createOrUpdateShop(shop, accessToken, {
      shop_name: shop.split('.')[0],
      email: null,
      phone: null
    });
    
    console.log('✅ Shop data saved to database');
    
    // Register webhooks
    await registerWebhooks(shop, accessToken);
    
    // Redirect to admin dashboard instead of apps page
    res.redirect(`/admin?shop=${shop}`);
  } catch (error) {
    console.error('Error getting access token:', error);
    res.status(500).send('Error during OAuth process');
  }
});

async function registerWebhooks(shop, accessToken) {
  const axios = require('axios');
  
  // Clear existing webhooks first
  try {
    const existing = await axios.get(
      `https://${shop}/admin/api/2024-01/webhooks.json`,
      {
        headers: { 'X-Shopify-Access-Token': accessToken }
      }
    );
    
    for (const webhook of existing.data.webhooks) {
      await axios.delete(
        `https://${shop}/admin/api/2024-01/webhooks/${webhook.id}.json`,
        {
          headers: { 'X-Shopify-Access-Token': accessToken }
        }
      );
    }
    console.log('🗑️ Cleared existing webhooks');
  } catch (error) {
    console.log('No existing webhooks to clear');
  }
  
  // ALL webhooks including RESTRICTED ones
  const webhooks = [
    // ✅ WORKING WEBHOOKS (No approval needed)
    { 
      topic: 'checkouts/create', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/checkout-created` 
    },
    { 
      topic: 'checkouts/update', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/checkout-updated` 
    },
    { 
      topic: 'checkouts/delete', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/checkout-deleted` 
    },
    
    // ❌ RESTRICTED WEBHOOKS (Need approval - but let's try!)
    { 
      topic: 'orders/create', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/order-created` 
    },
    { 
      topic: 'orders/paid', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/order-paid` 
    },
    { 
      topic: 'orders/updated', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/order-updated` 
    },
    { 
      topic: 'orders/edited', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/order-edited` 
    },
    { 
      topic: 'orders/cancelled', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/order-cancelled` 
    },
    { 
      topic: 'orders/fulfilled', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/order-fulfilled` 
    },
    { 
      topic: 'orders/partially_fulfilled', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/order-partial-fulfilled` 
    },
    
    // Customer webhooks (RESTRICTED)
    { 
      topic: 'customers/create', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/customer-created` 
    },
    { 
      topic: 'customers/update', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/customer-updated` 
    },
    { 
      topic: 'customers/disable', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/customer-disabled` 
    },
    
    // Cart webhooks (RESTRICTED)
    { 
      topic: 'carts/create', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/cart-created` 
    },
    { 
      topic: 'carts/update', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/cart-updated` 
    },
    
    // Fulfillment webhooks
    { 
      topic: 'fulfillments/create', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/fulfillment-created` 
    },
    { 
      topic: 'fulfillments/update', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/fulfillment-updated` 
    },
    
    // Refund webhooks
    { 
      topic: 'refunds/create', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/refund-created` 
    },
    
    // Product webhooks (for back in stock notifications)
    { 
      topic: 'products/update', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/product-updated` 
    },
    
    // Shop update webhook
    { 
      topic: 'shop/update', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/shop-updated` 
    },
    
    // App uninstalled
    { 
      topic: 'app/uninstalled', 
      address: `${process.env.SHOPIFY_WEBHOOK_URL}/app-uninstalled` 
    }
  ];

  const results = {
    successful: [],
    failed: []
  };

  for (const webhook of webhooks) {
    try {
      const response = await axios.post(
        `https://${shop}/admin/api/2024-01/webhooks.json`,
        { webhook },
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json'
          }
        }
      );
      results.successful.push(webhook.topic);
    } catch (error) {
      const errorMsg = error.response?.data?.errors || error.message;
      console.error(`❌ Failed ${webhook.topic}:`, errorMsg);
      results.failed.push({ topic: webhook.topic, error: errorMsg });
    }
  }
  
  console.log(`📊 Webhooks: ${results.successful.length} registered, ${results.failed.length} failed`);
  
  return results;
}

// ============ RESTRICTED WEBHOOKS (Need Approval) ============

// 1. ORDERS/CREATE - When order is first created
app.post('/webhooks/order-created', async (req, res) => {
  const order = req.body;
  console.log('🆕 ORDER CREATED (Restricted):', order.name);
  
  if (order.customer?.phone) {
    const phone = order.customer.phone.replace(/\D/g, '');
    
    const message = `🎉 Order Received! ${order.customer.first_name}

Order #${order.name}
Total: ${order.currency} ${order.total_price}

📦 Items:
${order.line_items.map(item => `• ${item.name} x${item.quantity} - ${order.currency} ${item.price}`).join('\n')}

📍 Shipping Address:
${order.shipping_address?.name || order.customer.first_name}
${order.shipping_address?.address1}
${order.shipping_address?.city}, ${order.shipping_address?.province}
${order.shipping_address?.country}

💳 Payment: ${order.financial_status}
📦 Status: ${order.fulfillment_status || 'Processing'}

We'll keep you updated on WhatsApp!
Track anytime: ${order.order_status_url}`;

    try {
      const result = await twilioClient.messages.create({
        body: message,
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: `whatsapp:+${phone}`
      });
      console.log('✅ Order confirmation sent (from orders/create):', result.sid);
    } catch (error) {
      console.error('Error:', error);
    }
  }
  
  res.status(200).send('OK');
});

// 2. ORDERS/PAID - When payment is confirmed
app.post('/webhooks/order-paid', async (req, res) => {
  const order = req.body;
  console.log('💰 ORDER PAID (Restricted):', order.name);
  
  if (order.customer?.phone) {
    const phone = order.customer.phone.replace(/\D/g, '');
    
    const message = `💰 Payment Confirmed!

Order #${order.name}
Amount: ${order.currency} ${order.total_price}

Your order is now being prepared for shipping.
Estimated delivery: 3-5 business days

Thank you for your purchase! 🙏`;

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:+${phone}`
    });
  }
  
  res.status(200).send('OK');
});

// 3. CUSTOMERS/CREATE - Welcome new customers
app.post('/webhooks/customer-created', async (req, res) => {
  const customer = req.body;
  console.log('👤 NEW CUSTOMER (Restricted):', customer.email);
  
  if (customer.phone) {
    const phone = customer.phone.replace(/\D/g, '');
    
    const message = `Welcome to ${process.env.SHOP_NAME || 'our store'}, ${customer.first_name}! 🎉

Thank you for creating an account!

🎁 Here's your welcome gift:
- 15% off your first order with code: WELCOME15
- Free shipping on orders over $50
- Early access to new products

Save this number to get:
- Order updates
- Exclusive deals
- Customer support

Reply STOP anytime to unsubscribe.
Reply HELP for assistance.`;

    try {
      await twilioClient.messages.create({
        body: message,
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: `whatsapp:+${phone}`
      });
      console.log('✅ Welcome message sent to new customer');
    } catch (error) {
      console.error('Error:', error);
    }
  }
  
  res.status(200).send('OK');
});

// 4. CUSTOMERS/UPDATE - Customer info changed
app.post('/webhooks/customer-updated', async (req, res) => {
  const customer = req.body;
  console.log('👤 Customer updated:', customer.email);
  
  // You might want to update their phone number in your database
  // Or send a confirmation if critical info changed
  
  res.status(200).send('OK');
});

// 5. CARTS/CREATE - Track cart creation
app.post('/webhooks/cart-created', async (req, res) => {
  const cart = req.body;
  console.log('🛒 CART CREATED (Restricted):', cart.id);
  
  // Start tracking for abandoned cart
  if (cart.customer?.phone) {
    // Store cart info for later follow-up
    storeCartForTracking(cart);
  }
  
  res.status(200).send('OK');
});

// 6. CARTS/UPDATE - Track cart changes
app.post('/webhooks/cart-updated', async (req, res) => {
  const cart = req.body;
  console.log('🛒 CART UPDATED (Restricted):', cart.id);
  
  // Check if cart is abandoned
  if (!cart.completed_at && cart.updated_at) {
    const lastUpdate = new Date(cart.updated_at);
    const now = new Date();
    const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);
    
    if (hoursSinceUpdate > 1 && cart.customer?.phone) {
      // Send abandoned cart reminder
      const phone = cart.customer.phone.replace(/\D/g, '');
      
      const message = `Hi ${cart.customer.first_name}! 🛒

You left some amazing items in your cart:
${cart.line_items?.map(item => `• ${item.title} - ${cart.currency} ${item.price}`).join('\n')}

Total: ${cart.currency} ${cart.total_price}

Complete your purchase and get 10% off with code: COMEBACK10
${cart.abandoned_checkout_url}

Your cart will be saved for 24 hours!`;

      await twilioClient.messages.create({
        body: message,
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: `whatsapp:+${phone}`
      });
    }
  }
  
  res.status(200).send('OK');
});

// 7. PRODUCTS/UPDATE - For back in stock notifications
app.post('/webhooks/product-updated', async (req, res) => {
  const product = req.body;
  console.log('📦 Product updated:', product.title);
  
  // Check if product came back in stock
  if (product.variants) {
    for (const variant of product.variants) {
      if (variant.inventory_quantity > 0 && variant.old_inventory_quantity === 0) {
        // Product is back in stock!
        await notifyWaitingCustomers(product, variant);
      }
    }
  }
  
  res.status(200).send('OK');
});

// 8. APP/UNINSTALLED - Clean up when app is removed
app.post('/webhooks/app-uninstalled', async (req, res) => {
  const shop = req.get('X-Shopify-Shop-Domain');
  console.log('❌ APP UNINSTALLED from shop:', shop);
  
  // Clean up shop data
  if (typeof db !== 'undefined') {
    db.run('DELETE FROM shops WHERE shop_domain = ?', [shop]);
  }
  
  // Remove from memory
  if (global.shopData?.[shop]) {
    delete global.shopData[shop];
  }
  
  res.status(200).send('OK');
});
app.get('/fix-webhooks', async (req, res) => {
  const shop = process.env.DEFAULT_SHOP_DOMAIN || 'your-shop.myshopify.com';
  const accessToken = global.shopData?.[shop]?.accessToken;
  
  if (!accessToken) {
    return res.send('Shop not found. Install the app first.');
  }
  
  // Re-register webhooks
  await registerWebhooks(shop, accessToken);
  
  // List all registered webhooks
  const axios = require('axios');
  const response = await axios.get(
    `https://${shop}/admin/api/2024-01/webhooks.json`,
    {
      headers: { 'X-Shopify-Access-Token': accessToken }
    }
  );
  
  res.json({
    message: 'Webhooks re-registered',
    active_webhooks: response.data.webhooks.map(w => ({
      id: w.id,
      topic: w.topic,
      address: w.address,
      created: w.created_at
    }))
  });
});
// 1. CHECKOUT CREATED (Potential abandoned cart)
app.post('/webhooks/checkout-created', async (req, res) => {
  const checkout = req.body;
  console.log('🛒 Checkout started:', checkout.id);
  
  // Track for abandoned cart follow-up
  if (checkout.phone || checkout.email) {
    // Store for later follow-up if not completed
    setTimeout(async () => {
      // Check if still abandoned after 1 hour
      // Send reminder if not completed
    }, 60 * 60 * 1000);
  }
  
  res.status(200).send('OK');
});

// 2. CHECKOUT UPDATED (Order confirmation - WORKING!)
app.post('/webhooks/checkout-updated', async (req, res) => {
  // Your existing working code
  res.status(200).send('OK');
});



// 8. ORDER EDITED (Price/items changed)
app.post('/webhooks/order-edited', async (req, res) => {
  const order = req.body;
  console.log('✏️ Order edited:', order.name);
  
  if (order.customer?.phone) {
    const message = `Your order ${order.name} has been updated.

New total: ${order.currency} ${order.total_price}

Check your email for details or reply here for help.`;

    // Send notification
  }
  
  res.status(200).send('OK');
});

// Import notification manager at the top
const NotificationManager = require('./services/notificationManager');

// ============= ORDER WEBHOOKS =============

// 1. ORDER CREATED (If you get approval for protected data)
app.post('/webhooks/order-created', async (req, res) => {
  const order = req.body;
  console.log('🆕 ORDER CREATED:', order.name);
  
  try {
    // Save order to database
    await DatabaseQueries.saveOrder({
      shop_domain: order.shop_domain || req.get('X-Shopify-Shop-Domain'),
      order_id: order.id,
      order_number: order.name,
      customer_email: order.customer?.email,
      customer_phone: order.customer?.phone,
      customer_name: `${order.customer?.first_name} ${order.customer?.last_name}`,
      total_price: order.total_price,
      currency: order.currency,
      financial_status: order.financial_status,
      fulfillment_status: order.fulfillment_status,
      checkout_id: order.checkout_id
    });
    
    // Send order confirmation if phone exists
    if (order.customer?.phone) {
      const phone = order.customer.phone.replace(/\D/g, '');
      
      await NotificationManager.sendNotification(
        order.shop_domain || req.get('X-Shopify-Shop-Domain'),
        phone,
        'order_placed',
        {
          customer_name: order.customer.first_name,
          order_number: order.name,
          currency: order.currency,
          total_price: order.total_price,
          items: order.line_items.map(item => ({
            name: item.name,
            quantity: item.quantity,
            price: item.price
          })),
          shipping_address: order.shipping_address,
          delivery_estimate: '3-5 business days',
          order_status_url: order.order_status_url
        }
      );
    }
    
    // Mark abandoned cart as recovered if it exists
    if (order.checkout_id) {
      await DatabaseQueries.markCartRecovered(order.checkout_id, order.total_price);
    }
    
  } catch (error) {
    console.error('Error processing order created:', error);
  }
  
  res.status(200).send('OK');
});

// 2. ORDER PAID (Payment confirmed)
app.post('/webhooks/order-paid', async (req, res) => {
  const order = req.body;
  console.log('💰 ORDER PAID:', order.name);
  
  try {
    if (order.customer?.phone) {
      const phone = order.customer.phone.replace(/\D/g, '');
      
      await NotificationManager.sendNotification(
        order.shop_domain || req.get('X-Shopify-Shop-Domain'),
        phone,
        'order_paid',
        {
          customer_name: order.customer.first_name,
          order_number: order.name,
          currency: order.currency,
          total_price: order.total_price
        }
      );
      
      // Update order status in database
      await DatabaseQueries.updateOrderStatus(order.id, 'paid', order.financial_status);
    }
  } catch (error) {
    console.error('Error processing order paid:', error);
  }
  
  res.status(200).send('OK');
});

// 3. ORDER UPDATED (Any order change)
app.post('/webhooks/order-updated', async (req, res) => {
  const order = req.body;
  console.log('📝 ORDER UPDATED:', order.name, 'Status:', order.fulfillment_status);
  
  try {
    // Ensure shop exists before processing
    const shopDomain = order.shop_domain || req.get('X-Shopify-Shop-Domain');
    const shopExists = await ensureShopExists(shopDomain, req);
    if (!shopExists) {
      console.error(`❌ Could not create/find shop: ${shopDomain}`);
      return res.status(500).send('Shop validation failed');
    }
    // Update order in database
    await DatabaseQueries.updateOrder(order.id, {
      financial_status: order.financial_status,
      fulfillment_status: order.fulfillment_status,
      updated_at: new Date()
    });
    
    // Check what changed and send appropriate notification
    if (order.fulfillment_status === 'fulfilled' && order.customer?.phone) {
      // Order was just fulfilled
      const phone = order.customer.phone.replace(/\D/g, '');
      
      try {
        await NotificationManager.sendNotification(
          order.shop_domain || req.get('X-Shopify-Shop-Domain'),
          phone,
          'order_processing',
          {
            customer_name: order.customer.first_name,
            order_number: order.name
          }
        );
      } catch (notificationError) {
        console.error(`❌ Failed to send order_processing: ${notificationError.message}`);
        // Continue processing the order even if notification fails
      }
    }
  } catch (error) {
    console.error('Error processing order update:', error);
  }
  
  res.status(200).send('OK');
});

// 4. ORDER FULFILLED (All items shipped)
app.post('/webhooks/order-fulfilled', async (req, res) => {
  const order = req.body;
  console.log('✅ ORDER FULFILLED:', order.name);
  
  try {
    // Ensure shop exists before processing
    const shopDomain = order.shop_domain || req.get('X-Shopify-Shop-Domain');
    const shopExists = await ensureShopExists(shopDomain, req);
    if (!shopExists) {
      console.error(`❌ Could not create/find shop: ${shopDomain}`);
      return res.status(500).send('Shop validation failed');
    }
    if (order.customer?.phone) {
      const phone = order.customer.phone.replace(/\D/g, '');
      const fulfillment = order.fulfillments?.[0];
      
      try {
        await NotificationManager.sendNotification(
          order.shop_domain || req.get('X-Shopify-Shop-Domain'),
          phone,
          'order_fulfilled',
          {
            customer_name: order.customer.first_name,
            order_number: order.name,
            carrier: fulfillment?.tracking_company || 'Our shipping partner',
            tracking_number: fulfillment?.tracking_number || '',
            tracking_url: fulfillment?.tracking_urls?.[0] || '',
            delivery_date: '3-5 business days'
          }
        );
      } catch (notificationError) {
        console.error(`❌ Failed to send order_fulfilled: ${notificationError.message}`);
        // Continue processing the order even if notification fails
      }
      
      // Update database
      await DatabaseQueries.updateOrderShipping(order.id, true);
    }
  } catch (error) {
    console.error('Error processing order fulfilled:', error);
  }
  
  res.status(200).send('OK');
});

// 5. ORDER PARTIALLY FULFILLED
app.post('/webhooks/order-partial-fulfilled', async (req, res) => {
  const order = req.body;
  console.log('📦 ORDER PARTIALLY FULFILLED:', order.name);
  
  try {
    if (order.customer?.phone) {
      const phone = order.customer.phone.replace(/\D/g, '');
      const shippedItems = order.fulfillments?.flatMap(f => f.line_items) || [];
      
      await NotificationManager.sendNotification(
        order.shop_domain || req.get('X-Shopify-Shop-Domain'),
        phone,
        'order_partially_fulfilled',
        {
          customer_name: order.customer.first_name,
          order_number: order.name,
          shipped_items: shippedItems.map(item => item.name).join(', '),
          remaining_items: order.line_items
            .filter(item => !shippedItems.find(s => s.id === item.id))
            .map(item => item.name)
            .join(', ')
        }
      );
    }
  } catch (error) {
    console.error('Error processing partial fulfillment:', error);
  }
  
  res.status(200).send('OK');
});

// 6. ORDER CANCELLED
app.post('/webhooks/order-cancelled', async (req, res) => {
  const order = req.body;
  console.log('❌ ORDER CANCELLED:', order.name);
  
  try {
    if (order.customer?.phone) {
      const phone = order.customer.phone.replace(/\D/g, '');
      
      await NotificationManager.sendNotification(
        order.shop_domain || req.get('X-Shopify-Shop-Domain'),
        phone,
        'order_cancelled',
        {
          customer_name: order.customer.first_name,
          order_number: order.name,
          currency: order.currency,
          refund_amount: order.total_price,
          support_phone: process.env.SUPPORT_PHONE || 'Reply here'
        }
      );
      
      // Update database
      await DatabaseQueries.updateOrderStatus(order.id, 'cancelled', 'cancelled');
    }
  } catch (error) {
    console.error('Error processing order cancellation:', error);
  }
  
  res.status(200).send('OK');
});

// 7. ORDER EDITED (Items/price changed)
app.post('/webhooks/order-edited', async (req, res) => {
  const order = req.body;
  console.log('✏️ ORDER EDITED:', order.name);
  
  try {
    if (order.customer?.phone) {
      const phone = order.customer.phone.replace(/\D/g, '');
      
      await NotificationManager.sendNotification(
        order.shop_domain || req.get('X-Shopify-Shop-Domain'),
        phone,
        'order_edited',
        {
          customer_name: order.customer.first_name,
          order_number: order.name,
          currency: order.currency,
          new_total: order.total_price
        }
      );
    }
  } catch (error) {
    console.error('Error processing order edit:', error);
  }
  
  res.status(200).send('OK');
});

// ============= CHECKOUT WEBHOOKS =============

// 8. CHECKOUT CREATED
app.post('/webhooks/checkout-created', async (req, res) => {
  const checkout = req.body;
  console.log('🛒 CHECKOUT CREATED:', checkout.id);
  
  try {
    // Save to abandoned carts table for tracking
    await DatabaseQueries.saveAbandonedCart({
      shop_domain: checkout.shop_domain || req.get('X-Shopify-Shop-Domain'),
      checkout_id: checkout.id,
      checkout_token: checkout.token,
      customer_email: checkout.email,
      customer_phone: checkout.phone,
      customer_name: checkout.customer?.first_name,
      cart_value: parseFloat(checkout.total_price || 0),
      currency: checkout.currency,
      items_count: checkout.line_items?.length || 0,
      line_items: checkout.line_items,
      checkout_url: checkout.abandoned_checkout_url
    });
    
    // Don't send notification yet - wait to see if they complete
    
  } catch (error) {
    console.error('Error processing checkout created:', error);
  }
  
  res.status(200).send('OK');
});

// 9. CHECKOUT UPDATED (Including completion)
app.post('/webhooks/checkout-updated', async (req, res) => {
  const checkout = req.body;
  console.log('🛒 CHECKOUT UPDATED:', {
    id: checkout.id,
    completed: checkout.completed_at ? 'YES' : 'NO'
  });
  
  try {
    if (checkout.completed_at && checkout.phone) {
      // Checkout completed = Order created
      const phone = checkout.phone.replace(/\D/g, '');
      
      await NotificationManager.sendNotification(
        checkout.shop_domain || req.get('X-Shopify-Shop-Domain'),
        phone,
        'order_placed',
        {
          customer_name: checkout.customer?.first_name || checkout.email?.split('@')[0],
          order_number: checkout.order_name || checkout.name,
          currency: checkout.currency || 'USD',
          total_price: checkout.total_price,
          items: checkout.line_items,
          shipping_address: checkout.shipping_address,
          delivery_estimate: '3-5 business days',
          order_status_url: checkout.order_status_url || 'Check your email'
        }
      );
      
      // Mark cart as recovered
      await DatabaseQueries.markCartRecovered(checkout.id, checkout.total_price);
      
    } else {
      // Update abandoned cart info
      await DatabaseQueries.updateAbandonedCart(checkout.id, {
        customer_email: checkout.email,
        customer_phone: checkout.phone,
        cart_value: checkout.total_price,
        updated_at: new Date()
      });
    }
  } catch (error) {
    console.error('Error processing checkout update:', error);
  }
  
  res.status(200).send('OK');
});

// 10. CHECKOUT DELETED
app.post('/webhooks/checkout-deleted', async (req, res) => {
  const checkout = req.body;
  console.log('🗑️ CHECKOUT DELETED:', checkout.id);
  
  try {
    // Remove from abandoned carts
    await DatabaseQueries.deleteAbandonedCart(checkout.id);
  } catch (error) {
    console.error('Error processing checkout deletion:', error);
  }
  
  res.status(200).send('OK');
});

// ============= FULFILLMENT WEBHOOKS =============

// 11. FULFILLMENT CREATED
app.post('/webhooks/fulfillment-created', async (req, res) => {
  const fulfillment = req.body;
  console.log('📦 FULFILLMENT CREATED:', fulfillment.id);
  
  try {
    // Get order details to find phone
    const orderId = fulfillment.order_id;
    const order = await DatabaseQueries.getOrder(orderId);
    
    if (order?.customer_phone) {
      const phone = order.customer_phone.replace(/\D/g, '');
      
      await NotificationManager.sendNotification(
        order.shop_domain,
        phone,
        'shipping_label_created',
        {
          customer_name: order.customer_name?.split(' ')[0],
          order_number: order.order_number
        }
      );
    }
  } catch (error) {
    console.error('Error processing fulfillment created:', error);
  }
  
  res.status(200).send('OK');
});

// 12. FULFILLMENT UPDATED (Tracking updates)
app.post('/webhooks/fulfillment-updated', async (req, res) => {
  const fulfillment = req.body;
  console.log('📦 FULFILLMENT UPDATED:', fulfillment.id);
  
  try {
    const order = await DatabaseQueries.getOrder(fulfillment.order_id);
    
    if (order?.customer_phone && fulfillment.shipment_status) {
      const phone = order.customer_phone.replace(/\D/g, '');
      
      // Check shipment status
      if (fulfillment.shipment_status === 'out_for_delivery') {
        await NotificationManager.sendNotification(
          order.shop_domain,
          phone,
          'order_out_for_delivery',
          {
            customer_name: order.customer_name?.split(' ')[0],
            order_number: order.order_number,
            tracking_url: fulfillment.tracking_urls?.[0] || ''
          }
        );
      } else if (fulfillment.shipment_status === 'delivered') {
        await NotificationManager.sendNotification(
          order.shop_domain,
          phone,
          'order_delivered',
          {
            customer_name: order.customer_name?.split(' ')[0],
            order_number: order.order_number,
            review_url: `${order.shop_domain}/reviews/new?order=${order.order_id}`
          }
        );
        
        // Update database
        await DatabaseQueries.updateOrderDelivered(order.id);
      } else if (fulfillment.shipment_status === 'failure' || fulfillment.shipment_status === 'exception') {
        await NotificationManager.sendNotification(
          order.shop_domain,
          phone,
          'shipping_exception',
          {
            customer_name: order.customer_name?.split(' ')[0],
            order_number: order.order_number,
            exception_reason: fulfillment.exception || 'Delivery issue',
            support_phone: process.env.SUPPORT_PHONE || 'Reply here'
          }
        );
      }
    }
  } catch (error) {
    console.error('Error processing fulfillment update:', error);
  }
  
  res.status(200).send('OK');
});

// ============= CUSTOMER WEBHOOKS =============

// 13. CUSTOMER CREATED
app.post('/webhooks/customer-created', async (req, res) => {
  const customer = req.body;
  console.log('👤 NEW CUSTOMER:', customer.email);
  
  try {
    const shopDomain = customer.shop_domain || req.get('X-Shopify-Shop-Domain');
    
    // Save to database
    await DatabaseQueries.createOrUpdateCustomer({
      shop_domain: shopDomain,
      customer_phone: customer.phone,
      customer_email: customer.email,
      first_name: customer.first_name,
      last_name: customer.last_name
    });
    
    // Send welcome message if phone exists
    if (customer.phone) {
      const phone = customer.phone.replace(/\D/g, '');
      
      await NotificationManager.sendNotification(
        shopDomain,
        phone,
        'welcome_customer',
        {
          customer_name: customer.first_name,
          shop_name: shopDomain.replace('.myshopify.com', ''),
          free_shipping_threshold: '$50',
          shop_url: `https://${shopDomain}`
        }
      );
      
      // Start welcome series (delayed messages)
      scheduleWelcomeSeries(shopDomain, phone, customer.first_name);
    }
  } catch (error) {
    console.error('Error processing customer created:', error);
  }
  
  res.status(200).send('OK');
});

// 14. CUSTOMER UPDATED
app.post('/webhooks/customer-updated', async (req, res) => {
  const customer = req.body;
  console.log('👤 CUSTOMER UPDATED:', customer.email);
  
  try {
    // Update customer info
    await DatabaseQueries.updateCustomer({
      shop_domain: customer.shop_domain || req.get('X-Shopify-Shop-Domain'),
      customer_phone: customer.phone,
      customer_email: customer.email,
      first_name: customer.first_name,
      last_name: customer.last_name,
      total_spent: customer.total_spent,
      orders_count: customer.orders_count
    });
    
    // Check if they reached VIP status
    if (customer.total_spent > 500 && customer.phone) {
      const isNewVIP = await DatabaseQueries.checkNewVIPStatus(customer.id);
      
      if (isNewVIP) {
        const phone = customer.phone.replace(/\D/g, '');
        
        await NotificationManager.sendNotification(
          customer.shop_domain || req.get('X-Shopify-Shop-Domain'),
          phone,
          'vip_status_achieved',
          {
            customer_name: customer.first_name
          }
        );
        
        await DatabaseQueries.updateVIPStatus(customer.id, true);
      }
    }
  } catch (error) {
    console.error('Error processing customer update:', error);
  }
  
  res.status(200).send('OK');
});

// 15. CUSTOMER DISABLED
app.post('/webhooks/customer-disabled', async (req, res) => {
  const customer = req.body;
  console.log('👤 CUSTOMER DISABLED:', customer.email);
  
  try {
    // Mark customer as inactive
    await DatabaseQueries.disableCustomer(customer.id);
  } catch (error) {
    console.error('Error processing customer disabled:', error);
  }
  
  res.status(200).send('OK');
});

// ============= REFUND WEBHOOKS =============

// 16. REFUND CREATED
app.post('/webhooks/refund-created', async (req, res) => {
  const refund = req.body;
  console.log('💰 REFUND CREATED:', refund.id);
  
  try {
    // Get order details
    const order = await DatabaseQueries.getOrder(refund.order_id);
    
    if (order?.customer_phone) {
      const phone = order.customer_phone.replace(/\D/g, '');
      const refundAmount = refund.transactions?.[0]?.amount || refund.amount;
      
      await NotificationManager.sendNotification(
        order.shop_domain,
        phone,
        'order_refunded',
        {
          customer_name: order.customer_name?.split(' ')[0],
          order_number: order.order_number,
          currency: order.currency,
          refund_amount: refundAmount
        }
      );
      
      // Update order status
      await DatabaseQueries.updateOrderRefund(order.id, refundAmount);
    }
  } catch (error) {
    console.error('Error processing refund:', error);
  }
  
  res.status(200).send('OK');
});

// ============= CART WEBHOOKS (If you get access) =============

// 17. CART CREATED
app.post('/webhooks/cart-created', async (req, res) => {
  const cart = req.body;
  console.log('🛒 CART CREATED:', cart.id);
  
  try {
    // Track cart creation for analytics
    await DatabaseQueries.trackCartCreated({
      shop_domain: cart.shop_domain || req.get('X-Shopify-Shop-Domain'),
      cart_id: cart.id,
      customer_email: cart.customer?.email,
      customer_phone: cart.customer?.phone,
      created_at: new Date()
    });
  } catch (error) {
    console.error('Error processing cart created:', error);
  }
  
  res.status(200).send('OK');
});

// 18. CART UPDATED
app.post('/webhooks/cart-updated', async (req, res) => {
  const cart = req.body;
  console.log('🛒 CART UPDATED:', cart.id);
  
  try {
    // Update cart tracking
    await DatabaseQueries.updateCartTracking(cart.id, {
      items_count: cart.line_items?.length,
      total_value: cart.total_price,
      updated_at: new Date()
    });
    
    // Check if cart is abandoned (no update for 1 hour)
    // This is handled by the scheduler instead
    
  } catch (error) {
    console.error('Error processing cart update:', error);
  }
  
  res.status(200).send('OK');
});

// ============= PRODUCT WEBHOOKS =============

// 19. PRODUCT UPDATED (For back-in-stock notifications)
app.post('/webhooks/product-updated', async (req, res) => {
  const product = req.body;
  console.log('📦 PRODUCT UPDATED:', product.title);
  
  try {
    // Check each variant for stock changes
    for (const variant of product.variants) {
      const wasOutOfStock = await DatabaseQueries.checkVariantWasOutOfStock(variant.id);
      
      if (wasOutOfStock && variant.inventory_quantity > 0) {
        // Product is back in stock!
        console.log('🎉 Back in stock:', product.title, variant.title);
        
        // Get customers waiting for this product
        const waitingCustomers = await DatabaseQueries.getBackInStockSubscribers(variant.id);
        
        for (const customer of waitingCustomers) {
          await NotificationManager.sendNotification(
            customer.shop_domain,
            customer.customer_phone,
            'back_in_stock',
            {
              customer_name: customer.customer_name,
              product_name: product.title,
              product_description: variant.title || '',
              currency: product.currency || 'USD',
              price: variant.price,
              product_url: `https://${customer.shop_domain}/products/${product.handle}`
            }
          );
          
          // Remove from waiting list
          await DatabaseQueries.removeBackInStockSubscriber(customer.id);
        }
      }
      
      // Update variant stock status
      await DatabaseQueries.updateVariantStock(variant.id, variant.inventory_quantity);
    }
  } catch (error) {
    console.error('Error processing product update:', error);
  }
  
  res.status(200).send('OK');
});

// ============= SHOP WEBHOOKS =============

// 20. APP UNINSTALLED
app.post('/webhooks/app-uninstalled', async (req, res) => {
  const shop = req.get('X-Shopify-Shop-Domain');
  console.log('❌ APP UNINSTALLED:', shop);
  
  try {
    // Deactivate shop
    await DatabaseQueries.deactivateShop(shop);
    
    // Cancel any pending notifications
    await NotificationScheduler.cancelShopNotifications(shop);
    
    // Remove from memory
    if (global.shopData?.[shop]) {
      delete global.shopData[shop];
    }
    
    console.log('✅ Shop cleanup completed');
  } catch (error) {
    console.error('Error processing app uninstall:', error);
  }
  
  res.status(200).send('OK');
});

// ============= HELPER FUNCTIONS =============

// Schedule welcome series
function scheduleWelcomeSeries(shopDomain, phone, customerName) {
  // Day 2: Tips for using the store
  setTimeout(() => {
    NotificationManager.sendNotification(
      shopDomain,
      phone,
      'welcome_day2',
      { customer_name: customerName }
    );
  }, 2 * 24 * 60 * 60 * 1000);
  
  // Day 5: Special offer
  setTimeout(() => {
    NotificationManager.sendNotification(
      shopDomain,
      phone,
      'welcome_day5',
      { 
        customer_name: customerName,
        discount_code: 'WELCOME20'
      }
    );
  }, 5 * 24 * 60 * 60 * 1000);
  
  // Day 10: Feedback request
  setTimeout(() => {
    NotificationManager.sendNotification(
      shopDomain,
      phone,
      'welcome_day10',
      { customer_name: customerName }
    );
  }, 10 * 24 * 60 * 60 * 1000);
}

// Get order details helper
async function getOrderDetails(orderId) {
  return DatabaseQueries.getOrder(orderId);
}
// Add this debug endpoint
app.get('/debug/webhooks', async (req, res) => {
  const shop = process.env.DEFAULT_SHOP_DOMAIN || 'your-shop.myshopify.com';
  const accessToken = global.shopData?.[shop]?.accessToken;
  
  if (!accessToken) {
    return res.json({ error: 'Shop not found' });
  }
  
  const axios = require('axios');
  const response = await axios.get(
    `https://${shop}/admin/api/2024-01/webhooks.json`,
    {
      headers: { 'X-Shopify-Access-Token': accessToken }
    }
  );
  
  res.json({
    registered_webhooks: response.data.webhooks.map(w => ({
      topic: w.topic,
      address: w.address,
      created: w.created_at
    }))
  });
});

// Test order confirmation
// Test order confirmation - FIXED VERSION
app.get('/test-order-confirmation', async (req, res) => {
  const testOrder = {
    name: '#1001',
    currency: 'SAR',
    total_price: '299.00',
    customer: {
      first_name: 'Test',
      phone: process.env.TEST_PHONE_NUMBER || '+1234567890'
    },
    line_items: [
      { name: 'Amazing Product', quantity: 1, price: '299.00' }
    ],
    shipping_address: {
      address1: '123 Test Street',
      city: 'Riyadh',
      country: 'Saudi Arabia'
    },
    order_status_url: `https://${process.env.DEFAULT_SHOP_DOMAIN || 'your-shop.myshopify.com'}/order/1001`
  };
  
  console.log('📧 Sending test order confirmation...');
  
  try {
    // Directly send the WhatsApp message
    const phone = testOrder.customer.phone.replace(/\D/g, '');
    
    const message = `Thank you for your order, ${testOrder.customer.first_name}! 🎉

Order ${testOrder.name}
Total: ${testOrder.currency} ${testOrder.total_price}

📦 Items:
${testOrder.line_items.map(item => `• ${item.name} (${item.quantity}x)`).join('\n')}

📍 Shipping to:
${testOrder.shipping_address.address1}
${testOrder.shipping_address.city}, ${testOrder.shipping_address.country}

We'll notify you when your order ships!

Track anytime: ${testOrder.order_status_url}`;

    const result = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:+${phone}`
    });
    
    console.log('✅ Test order confirmation sent:', result.sid);
    
    // Track in database if it exists
    if (typeof trackMessage === 'function') {
      await trackMessage(
        process.env.DEFAULT_SHOP_DOMAIN || 'your-shop.myshopify.com',
        phone,
        'order_confirmation',
        message,
        result.sid
      );
    }
    
    res.send(`
      <html>
        <head>
          <style>
            body { font-family: Arial; padding: 40px; background: #f0f0f0; }
            .success { background: #10b981; color: white; padding: 20px; border-radius: 10px; }
          </style>
        </head>
        <body>
          <div class="success">
            <h1>✅ Test Order Confirmation Sent!</h1>
            <p>Check WhatsApp for order #1001</p>
            <p>Message ID: ${escapeHtml(result.sid)}</p>
            <p><a href="/admin" style="color: white;">← Back to Dashboard</a></p>
          </div>
        </body>
      </html>
    `);
    
  } catch (error) {
    console.error('❌ Error sending test order confirmation:', error);
    res.status(500).send(`
      <html>
        <body>
          <h1>❌ Error</h1>
          <p>${error.message}</p>
          <p><a href="/admin">← Back to Dashboard</a></p>
        </body>
      </html>
    `);
  }
});

// Add this test route
app.get('/test-abandoned-cart', async (req, res) => {
  const testCart = {
    id: 'test-' + Date.now(),
    email: 'test@example.com',
    customer: {
      first_name: 'Test',
      phone: process.env.TEST_PHONE_NUMBER || '+1234567890'
    },
    line_items: [
      { title: 'Test Product', price: '99.00' }
    ],
    total_price: '99.00',
    abandoned_checkout_url: `https://${process.env.DEFAULT_SHOP_DOMAIN || 'your-shop.myshopify.com'}/checkout/test`,
    currency: 'SAR'
  };
  
  await handleAbandonedCart(testCart);
  res.send('Test abandoned cart message sent! Check WhatsApp.');
});

app.post('/webhooks/order-fulfilled', (req, res) => {
  console.log('📦 Order fulfilled:', req.body);
  // Send shipping notification
  sendShippingNotification(req.body);
  res.status(200).send('OK');
});
// Webhook Endpoints
app.post('/webhooks/cart-update', (req, res) => {
  console.log('Cart updated:', req.body);
  // Handle abandoned cart logic here
  handleAbandonedCart(req.body);
  res.status(200).send('OK');
});

app.post('/webhooks/order-created', (req, res) => {
  console.log('Order created:', req.body);
  // Send order confirmation via WhatsApp
  sendOrderConfirmation(req.body);
  res.status(200).send('OK');
});


// WhatsApp Functions - Initialize conditionally
let legacyTwilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && 
    process.env.TWILIO_AUTH_TOKEN && 
    process.env.TWILIO_ACCOUNT_SID.startsWith('AC') &&
    process.env.TWILIO_ACCOUNT_SID !== 'your_twilio_account_sid_here') {
  try {
    const twilio = require('twilio');
    legacyTwilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  } catch (error) {
    console.error('❌ Failed to initialize legacy Twilio client:', error.message);
  }
}

async function sendWhatsAppMessage(to, message) {
  try {
    if (!legacyTwilioClient) {
      throw new Error('Twilio client not initialized');
    }
    const result = await legacyTwilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${to}`
    });
    console.log('Message sent:', result.sid);
    return result;
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    throw error;
  }
}

async function handleAbandonedCart(cartData) {
  // In production, you'd want to wait 1-2 hours before sending
  // For testing, we'll send immediately
  
  if (cartData.customer && cartData.customer.phone) {
    const message = `Hi ${cartData.customer.first_name}! You have items in your cart. Complete your purchase here: ${cartData.abandoned_checkout_url}`;
    
    // Format phone number (remove any non-numeric characters)
    const phone = cartData.customer.phone.replace(/\D/g, '');
    
    setTimeout(async () => {
      await sendWhatsAppMessage(phone, message);
    }, 5000); // Wait 5 seconds for testing
  }
}

async function sendOrderConfirmation(orderData) {
  if (orderData.customer && orderData.customer.phone) {
    const message = `Thank you for your order #${orderData.order_number}! Your total is ${orderData.total_price}. We'll notify you when it ships.`;
    const phone = orderData.customer.phone.replace(/\D/g, '');
    await sendWhatsAppMessage(phone, message);
  }
}

async function sendWelcomeMessage(customerData) {
  if (customerData.phone) {
    const message = `Welcome to our store, ${customerData.first_name}! 🎉 Reply with 'HELP' anytime for assistance.`;
    const phone = customerData.phone.replace(/\D/g, '');
    await sendWhatsAppMessage(phone, message);
  }
}

// WhatsApp Incoming Messages Webhook
app.post('/whatsapp/webhook', async (req, res) => {
  const message = req.body;
  
  if (message.Body) {
    console.log('Received WhatsApp message:', message.Body);
    console.log('From:', message.From);
    
    // Simple auto-response
    if (message.Body.toLowerCase() === 'help') {
      await twilioClient.messages.create({
        body: 'Here are the available commands:\n1. ORDER STATUS - Check your order\n2. TRACK - Track your shipment\n3. CONTACT - Speak with support',
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: message.From
      });
    }
  }
  
  res.status(200).send('OK');
});

// Add more debugging to your server.js
app.post('/api/test-message', async (req, res) => {
  const { phone, message } = req.body;
  
  console.log('=== TEST MESSAGE DEBUG ===');
  console.log('1. Request received:', { phone, message });
  console.log('2. Twilio Account SID:', process.env.TWILIO_ACCOUNT_SID);
  console.log('3. Twilio WhatsApp Number:', process.env.TWILIO_WHATSAPP_NUMBER);
  
  // Format phone
  const cleanPhone = phone.replace(/\D/g, '');
  const formattedNumber = `whatsapp:+${cleanPhone}`;
  
  console.log('4. Formatted number:', formattedNumber);
  
  try {
    console.log('5. Attempting to send message...');
    
    const result = await twilioClient.messages.create({
      body: message || 'Test message from Shopify!',
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: formattedNumber
    });
    
    console.log('6. ✅ Message sent successfully!');
    console.log('   Message SID:', result.sid);
    console.log('   Status:', result.status);
    console.log('   To:', result.to);
    
    res.json({ success: true, messageSid: result.sid });
    
  } catch (error) {
    console.error('7. ❌ ERROR sending message:');
    console.error('   Error Code:', error.code);
    console.error('   Error Message:', error.message);
    console.error('   More Info:', error.moreInfo);
    
    res.status(500).json({ 
      success: false, 
      error: error.message,
      code: error.code,
      moreInfo: error.moreInfo
    });
  }
});

// Add this test route to verify credentials
app.get('/test-twilio-auth', async (req, res) => {
  try {
    const account = await twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    res.json({ 
      success: true, 
      accountName: account.friendlyName,
      status: account.status 
    });
  } catch (error) {
    res.json({ 
      success: false, 
      error: 'Invalid Twilio credentials. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN' 
    });
  }
});

// Super simple test - add to server.js
app.get('/test-whatsapp-simple', [
  query('phone').optional().isMobilePhone(),
  handleValidationErrors
], async (req, res) => {
  console.log('Starting simple WhatsApp test...');
  
  // Use provided phone or default from env
  let phoneNumber = req.query.phone || process.env.TEST_PHONE_NUMBER || '+1234567890';
  
  // Validate and sanitize phone number
  const validPhone = ValidationUtils.validatePhone(phoneNumber);
  if (!validPhone) {
    return res.status(400).json({error: 'Invalid phone number provided'});
  }
  
  const YOUR_PHONE = validPhone;
  
  try {
    const message = await twilioClient.messages.create({
      body: 'If you see this, WhatsApp is working! 🎉',
      from: 'whatsapp:+14155238886',
      to: `whatsapp:${YOUR_PHONE}`
    });
    
    console.log('Success! Message SID:', message.sid);
    res.send(`Success! Check WhatsApp. Message ID: ${message.sid}`);
    
  } catch (error) {
    console.error('Failed:', error);
    res.send(`Failed: ${error.message}<br>Code: ${error.code}<br>Info: ${error.moreInfo}`);
  }
});
function sendTestMessage() {
    const phone = document.getElementById('testPhone').value;
    const message = document.getElementById('testMessage').value;
    const resultDiv = document.getElementById('testResult');
    
    if (!phone) {
        resultDiv.style.display = 'block';
        resultDiv.style.color = 'red';
        resultDiv.textContent = '❌ Please enter a phone number';
        return;
    }
    
    // Show loading
    resultDiv.style.display = 'block';
    resultDiv.style.color = '#666';
    resultDiv.innerHTML = '⏳ Sending message...';
    
    fetch('/api/test-message', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ phone, message })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            resultDiv.style.color = 'green';
            resultDiv.innerHTML = `✅ Message sent successfully!<br>
                                   Message ID: ${data.messageSid}<br>
                                   Sent to: ${data.to}`;
        } else {
            resultDiv.style.color = 'red';
            resultDiv.innerHTML = `❌ Failed: ${data.error}<br>
                                   ${data.details?.moreInfo ? `<a href="${data.details.moreInfo}" target="_blank">More info</a>` : ''}`;
        }
    })
    .catch(error => {
        resultDiv.style.color = 'red';
        resultDiv.innerHTML = `❌ Error: ${error.message}`;
    });
}

// WhatsApp Incoming Messages Webhook
app.post('/whatsapp/webhook', async (req, res) => {
  console.log('📱 Incoming WhatsApp message received');
  
  const { From, To, Body, ProfileName, MessageSid } = req.body;
  
  console.log({
    from: From,
    to: To,
    message: Body,
    senderName: ProfileName,
    messageSid: MessageSid
  });
  
  // Extract phone number (remove 'whatsapp:' prefix)
  const phoneNumber = From.replace('whatsapp:', '');
  
  // Handle different message types
  const messageBody = Body.toLowerCase().trim();
  
  try {
    let responseMessage = '';
    
    // Auto-response logic
    if (messageBody === 'help' || messageBody === 'hi' || messageBody === 'hello') {
      responseMessage = `Hi ${ProfileName}! 👋\n\nHere are the available commands:\n\n` +
                       `📦 ORDER - Check order status\n` +
                       `🛒 CART - View abandoned cart\n` +
                       `💬 SUPPORT - Chat with agent\n` +
                       `🔔 STOP - Unsubscribe from messages\n\n` +
                       `Just type any command to continue!`;
    } 
    else if (messageBody === 'order' || messageBody === 'status') {
      responseMessage = `To check your order status, please provide your order number or email address.`;
    }
    else if (messageBody === 'cart') {
      responseMessage = `Let me check if you have any items in your cart...`;
      // Here you would check their actual cart
    }
    else if (messageBody === 'support' || messageBody === 'agent') {
      responseMessage = `Connecting you with a support agent. Someone will respond within 5 minutes during business hours (Mon-Fri 9AM-6PM EST).`;
      // Here you could notify your support team
    }
    else if (messageBody === 'stop' || messageBody === 'unsubscribe') {
      responseMessage = `You've been unsubscribed from WhatsApp notifications. Reply START anytime to resubscribe.`;
      // Here you would update their preferences
    }
    else {
      // Default response for unrecognized commands
      responseMessage = `Thanks for your message! Type HELP to see available commands or SUPPORT to chat with an agent.`;
    }
    
    // Send auto-reply
    if (responseMessage) {
      await twilioClient.messages.create({
        body: responseMessage,
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: From  // Reply to the sender
      });
      
      console.log('✅ Auto-reply sent:', responseMessage.substring(0, 50) + '...');
    }
    
    // Store the conversation in your database (optional)
    // await storeMessage(phoneNumber, Body, 'inbound');
    
  } catch (error) {
    console.error('❌ Error processing WhatsApp message:', error);
  }
  
  // Always respond with 200 OK to acknowledge receipt
  res.status(200).send('OK');
});

// WhatsApp Status Callback Webhook
app.post('/whatsapp/status', (req, res) => {
  const { MessageSid, MessageStatus, To, ErrorCode, ErrorMessage } = req.body;
  
  console.log('📊 WhatsApp Status Update:', {
    messageSid: MessageSid,
    status: MessageStatus,
    to: To
  });
  
  // Handle different statuses
  switch(MessageStatus) {
    case 'sent':
      console.log('✅ Message sent successfully');
      break;
    case 'delivered':
      console.log('✅ Message delivered to recipient');
      break;
    case 'read':
      console.log('✅ Message read by recipient');
      break;
    case 'failed':
      console.error('❌ Message failed:', ErrorMessage, ErrorCode);
      // Here you could retry or notify admin
      break;
    case 'undelivered':
      console.error('⚠️ Message undelivered');
      break;
  }
  
  // Update message status in your database (optional)
  // await updateMessageStatus(MessageSid, MessageStatus);
  
  res.status(200).send('OK');
});

// Optional: Webhook for testing
app.get('/whatsapp/webhook', (req, res) => {
  res.send('WhatsApp webhook is configured correctly! ✅');
});
// Serve admin UI
app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/public/admin.html');
});

// Make sure to create the public folder and save the HTML as admin.html
// Initialize database and start server
async function startServer() {
  try {
    // Initialize database tables (only if needed)
    await initializeDatabase();
    
    // Start the server
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT} | WhatsApp ready | Use: ngrok http ${PORT}`);
    });
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();

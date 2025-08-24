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
      req.path === '/test-whatsapp-simple' ||
      req.path.startsWith('/api/whatsapp/public-')) {
    return next();
  }

  // Get session token from authorization header or query
  let sessionToken = req.headers.authorization?.replace('Bearer ', '') || req.query.id_token;
  
  if (!sessionToken) {
    console.log('❌ No session token provided for path:', req.path);
    return res.status(401).json({ error: 'No session token provided' });
  }

  try {
    // Validate session token using Shopify API
    const payload = await shopify.api.session.decodeSessionToken(sessionToken);
    
    console.log('✅ Session token validated for path:', req.path, {
      shop: payload.dest?.replace('https://', '').replace('/admin', ''),
      aud: payload.aud,
      exp: new Date(payload.exp * 1000).toISOString()
    });

    // Extract shop from token
    const shop = payload.dest?.replace('https://', '').replace('/admin', '');
    if (!shop) {
      console.error('❌ Invalid shop in token');
      return res.status(400).json({ error: 'Invalid shop in token' });
    }

    // Add to request for use in routes
    req.sessionToken = sessionToken;
    req.shop = shop;
    req.tokenPayload = payload;
    
    next();
    
  } catch (error) {
    console.error('❌ Session token validation failed for path:', req.path, error.message);
    return res.status(401).json({ error: 'Invalid session token: ' + error.message });
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

// WhatsApp Widget Settings API
app.get('/api/whatsapp/settings', async (req, res) => {
  const shop = req.shop;
  
  try {
    const settings = await new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM whatsapp_widget_settings WHERE shop_domain = ?',
        [shop],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
    
    if (settings) {
      // Parse JSON fields
      if (settings.business_hours_schedule) {
        settings.business_hours_schedule = JSON.parse(settings.business_hours_schedule);
      }
      if (settings.translations) {
        settings.translations = JSON.parse(settings.translations);
      }
      
      res.json(settings);
    } else {
      // Return default settings if none exist
      res.json({
        shop_domain: shop,
        phone_number: '',
        default_message: 'Hello! I\'m interested in your products.',
        button_text: 'Chat with us',
        language: 'en',
        position: 'bottom-right',
        background_color: '#25D366',
        text_color: '#ffffff',
        business_hours_enabled: false,
        popup_triggers_enabled: false
      });
    }
  } catch (error) {
    console.error('Error fetching WhatsApp settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.post('/api/whatsapp/settings', async (req, res) => {
  const shop = req.shop;
  const settings = req.body;
  
  console.log('Received settings for shop:', shop);
  console.log('Settings data:', JSON.stringify(settings, null, 2));
  
  try {
    // Validate required fields
    if (!settings.phoneNumber || settings.phoneNumber.trim() === '') {
      return res.status(400).json({ error: 'Phone number is required', success: false });
    }
    
    // Serialize JSON fields
    const businessHoursSchedule = settings.businessHours?.schedule ? 
      JSON.stringify(settings.businessHours.schedule) : null;
    const translations = settings.translations ? 
      JSON.stringify(settings.translations) : null;
    
    console.log('Serialized business hours schedule:', businessHoursSchedule);
    
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT OR REPLACE INTO whatsapp_widget_settings (
          shop_domain, phone_number, default_message, button_text, language,
          position, background_color, text_color, custom_css,
          business_hours_enabled, business_hours_schedule, business_hours_timezone,
          closed_message, popup_triggers_enabled, popup_delay, popup_exit_intent,
          popup_scroll_percentage, popup_message, translations, is_active,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          shop,
          settings.phoneNumber || '',
          settings.defaultMessage || 'Hello! I\'m interested in your products.',
          settings.buttonText || 'Chat with us',
          settings.language || 'en',
          settings.position || 'bottom-right',
          settings.backgroundColor || '#25D366',
          settings.textColor || '#ffffff',
          settings.customCSS || '',
          settings.businessHours?.enabled ? 1 : 0,
          businessHoursSchedule,
          settings.businessHours?.timezone || 'UTC',
          settings.businessHours?.closedMessage || '',
          settings.popupTriggers?.enabled ? 1 : 0,
          settings.popupTriggers?.delay || 5000,
          settings.popupTriggers?.exitIntent ? 1 : 0,
          settings.popupTriggers?.scrollPercentage || 50,
          settings.popupTriggers?.message || '',
          translations,
          1
        ],
        function(err) {
          if (err) {
            console.error('Database error:', err);
            reject(err);
          } else {
            console.log('Settings saved successfully for shop:', shop);
            resolve({ id: this.lastID, changes: this.changes });
          }
        }
      );
    });
    
    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (error) {
    console.error('Error saving WhatsApp settings:', error);
    res.status(500).json({ error: 'Failed to save settings: ' + error.message, success: false });
  }
});

// Get WhatsApp widget embed code
app.get('/api/whatsapp/embed-code', async (req, res) => {
  const shop = req.shop;
  const appUrl = process.env.SHOPIFY_APP_URL || `https://${req.get('host')}`;
  
  const embedCode = `<!-- WhatsApp Widget for Shopify -->
<script>
(function() {
  var script = document.createElement('script');
  script.src = '${appUrl}/public/whatsapp-widget.js';
  script.async = true;
  script.onload = function() {
    // Initialize WhatsApp widget
    fetch('${appUrl}/api/whatsapp/public-settings?shop=${encodeURIComponent(shop)}')
      .then(response => response.json())
      .then(settings => {
        new WhatsAppWidget({
          phoneNumber: settings.phone_number,
          defaultMessage: settings.default_message,
          buttonText: settings.button_text,
          language: settings.language,
          position: settings.position,
          backgroundColor: settings.background_color,
          textColor: settings.text_color,
          customCSS: settings.custom_css,
          businessHours: {
            enabled: settings.business_hours_enabled,
            schedule: settings.business_hours_schedule,
            timezone: settings.business_hours_timezone,
            closedMessage: settings.closed_message
          },
          popupTriggers: {
            enabled: settings.popup_triggers_enabled,
            delay: settings.popup_delay,
            exitIntent: settings.popup_exit_intent,
            scrollPercentage: settings.popup_scroll_percentage,
            message: settings.popup_message
          },
          translations: settings.translations
        });
      })
      .catch(error => console.error('Failed to load WhatsApp widget settings:', error));
  };
  document.head.appendChild(script);
})();
</script>`;
  
  res.json({ embedCode });
});

// Public endpoint to get widget settings (no auth required for storefront)
app.get('/api/whatsapp/public-settings', async (req, res) => {
  const shop = req.query.shop;
  
  if (!shop) {
    return res.status(400).json({ error: 'Shop parameter required' });
  }
  
  try {
    const settings = await new Promise((resolve, reject) => {
      db.get(
        `SELECT phone_number, default_message, button_text, language, position,
         background_color, text_color, custom_css, business_hours_enabled,
         business_hours_schedule, business_hours_timezone, closed_message,
         popup_triggers_enabled, popup_delay, popup_exit_intent,
         popup_scroll_percentage, popup_message, translations
         FROM whatsapp_widget_settings 
         WHERE shop_domain = ? AND is_active = 1`,
        [shop],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
    
    if (settings) {
      // Parse JSON fields
      if (settings.business_hours_schedule) {
        settings.business_hours_schedule = JSON.parse(settings.business_hours_schedule);
      }
      if (settings.translations) {
        settings.translations = JSON.parse(settings.translations);
      }
      
      res.json(settings);
    } else {
      res.status(404).json({ error: 'Widget not configured' });
    }
  } catch (error) {
    console.error('Error fetching public WhatsApp settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Check installation status
app.get('/api/whatsapp/installation-status', async (req, res) => {
  const shop = req.shop;
  
  try {
    // Check if there's an active script tag for this shop
    const scriptTags = await new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM script_tags WHERE shop_domain = ? AND is_active = 1',
        [shop],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
    
    const installed = scriptTags.length > 0;
    res.json({ installed, scriptTags: scriptTags.length });
  } catch (error) {
    console.error('Error checking installation status:', error);
    res.status(500).json({ error: 'Failed to check installation status' });
  }
});

// Install widget via Shopify Script Tag API
app.post('/api/whatsapp/install', async (req, res) => {
  const shop = req.shop;
  
  try {
    // First check if widget settings exist
    const settings = await new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM whatsapp_widget_settings WHERE shop_domain = ?',
        [shop],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
    
    if (!settings || !settings.phone_number) {
      return res.status(400).json({ error: 'Please configure widget settings first' });
    }
    
    // Get access token for this shop
    const shopData = await DatabaseQueries.getShop(shop);
    if (!shopData || !shopData.access_token) {
      return res.status(400).json({ error: 'Shop access token not found' });
    }
    
    // Create script tag using Shopify Admin API
    const appUrl = process.env.SHOPIFY_APP_URL || `https://${req.get('host')}`;
    const scriptSrc = `${appUrl}/public/whatsapp-widget.js`;
    
    try {
      // Use access token to make API request
      const response = await fetch(`https://${shop}/admin/api/2023-10/script_tags.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': shopData.access_token
        },
        body: JSON.stringify({
          script_tag: {
            event: 'onload',
            src: scriptSrc
          }
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        const scriptTag = data.script_tag;
        
        // Save script tag info to database
        await new Promise((resolve, reject) => {
          db.run(
            `INSERT INTO script_tags (shop_domain, script_tag_id, src, is_active, created_at) 
             VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)`,
            [shop, scriptTag.id, scriptTag.src],
            function(err) {
              if (err) reject(err);
              else resolve({ id: this.lastID });
            }
          );
        });
        
        console.log(`✅ Widget installed for ${shop} via Script Tag API`);
        res.json({ success: true, scriptTagId: scriptTag.id });
      } else {
        const errorData = await response.json();
        console.error('Failed to create script tag:', errorData);
        res.status(400).json({ error: 'Failed to install widget: ' + (errorData.errors || 'Unknown error') });
      }
    } catch (apiError) {
      console.error('Shopify API error:', apiError);
      res.status(500).json({ error: 'Failed to communicate with Shopify API' });
    }
  } catch (error) {
    console.error('Error installing widget:', error);
    res.status(500).json({ error: 'Failed to install widget' });
  }
});

// Uninstall widget (remove script tag)
app.post('/api/whatsapp/uninstall', async (req, res) => {
  const shop = req.shop;
  
  try {
    // Get access token for this shop
    const shopData = await DatabaseQueries.getShop(shop);
    if (!shopData || !shopData.access_token) {
      return res.status(400).json({ error: 'Shop access token not found' });
    }
    
    // Get active script tags for this shop
    const scriptTags = await new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM script_tags WHERE shop_domain = ? AND is_active = 1',
        [shop],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
    
    // Remove script tags from Shopify
    for (const tag of scriptTags) {
      try {
        const response = await fetch(`https://${shop}/admin/api/2023-10/script_tags/${tag.script_tag_id}.json`, {
          method: 'DELETE',
          headers: {
            'X-Shopify-Access-Token': shopData.access_token
          }
        });
        
        if (response.ok) {
          // Mark as inactive in database
          await new Promise((resolve, reject) => {
            db.run(
              'UPDATE script_tags SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
              [tag.id],
              function(err) {
                if (err) reject(err);
                else resolve();
              }
            );
          });
        }
      } catch (apiError) {
        console.error('Failed to remove script tag:', tag.script_tag_id, apiError);
      }
    }
    
    console.log(`✅ Widget uninstalled for ${shop}`);
    res.json({ success: true, removedTags: scriptTags.length });
  } catch (error) {
    console.error('Error uninstalling widget:', error);
    res.status(500).json({ error: 'Failed to uninstall widget' });
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
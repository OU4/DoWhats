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

// ✅ CREATE FLOW PAGE ROUTE  
app.get('/create-flow.html', async (req, res) => {
  const shop = req.shop; // From validated session token
  const sessionToken = req.sessionToken;
  
  if (!shop || !sessionToken) {
    console.log('❌ No session token provided for:', req.path);
    console.log('🔍 Available headers:', Object.keys(req.headers));
    console.log('🔍 Available query params:', Object.keys(req.query));
    console.log('🔍 Authorization header:', req.headers.authorization);
    console.log('🔍 id_token query:', req.query.id_token);
    return res.status(401).json({ error: 'No session token provided' });
  }

  try {
    // Get access token from database
    const shopData = await DatabaseQueries.getShop(shop);
    if (!shopData?.access_token) {
      console.error('❌ Shop not found or no access token:', shop);
      return res.status(401).json({ error: 'Shop not authenticated' });
    }

    const accessToken = shopData.access_token;
    
    // Create Shopify session object
    const { Session } = require('@shopify/shopify-api');
    const session = new Session({
      id: `${shop}_session`,
      shop: shop,
      state: '',
      isOnline: false,
      accessToken: accessToken,
      scope: process.env.SHOPIFY_SCOPES || 'read_orders,write_orders,read_customers,write_customers'
    });
    
    res.locals.shopify = { session };
    
    console.log('✅ Serving create flow page for shop:', shop);
    
    // Serve the create flow page
    res.sendFile(path.join(__dirname, 'public', 'create-flow.html'));
    
  } catch (error) {
    console.error('❌ Error in create flow route:', error);
    return res.status(500).json({ error: 'Failed to load create flow page' });
  }
});

// Helper function to ensure shop exists in database before processing webhooks
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

// Webhook handler with detailed logging
app.post('/webhooks', async (req, res) => {
  const shop = req.get('X-Shopify-Shop-Domain');
  const topic = req.get('X-Shopify-Topic');
  
  console.log(`📦 Webhook received: ${topic} from ${shop}`);
  console.log('📦 Webhook headers:', {
    'X-Shopify-Shop-Domain': req.get('X-Shopify-Shop-Domain'),
    'X-Shopify-Topic': req.get('X-Shopify-Topic'),
    'X-Shopify-Hmac-Sha256': req.get('X-Shopify-Hmac-Sha256'),
  });
  
  // The body should already be parsed by express.json() middleware
  const webhookData = req.body;
  
  if (!webhookData || typeof webhookData !== 'object') {
    console.error('❌ Invalid webhook body:', typeof webhookData, webhookData);
    return res.status(400).send('Invalid webhook body');
  }
  
  // Handle different webhook topics
  try {
    switch(topic) {
      case 'app/uninstalled':
        console.log('⚠️ App uninstall webhook received');
        const deletedRows = await DatabaseQueries.deleteShop(shop);
        console.log(`🗑️ Shop uninstalled and cleaned up: ${shop} (${deletedRows} rows affected)`);
        break;
        
      case 'orders/create':
        console.log('🛒 NEW ORDER CREATED:', webhookData.name);
        
        // Ensure shop exists before processing
        const shopExists = await ensureShopExists(shop, req);
        if (!shopExists) {
          console.error(`❌ Could not create/find shop: ${shop}`);
          return res.status(500).send('Shop validation failed');
        }
        
        // Check if we already sent a notification for this order (prevent duplicates)
        const existingOrder = await DatabaseQueries.getOrder(webhookData.id);
        if (existingOrder) {
          console.log(`⚠️ Order ${webhookData.name} already processed - skipping duplicate notification`);
          break;
        }
        
        // Save order to database to prevent duplicates
        await DatabaseQueries.saveOrder({
          shop_domain: shop,
          order_id: webhookData.id.toString(),
          order_number: webhookData.name,
          customer_email: webhookData.customer?.email,
          customer_phone: webhookData.customer?.phone,
          customer_name: `${webhookData.customer?.first_name || ''} ${webhookData.customer?.last_name || ''}`.trim(),
          total_price: parseFloat(webhookData.current_total_price || webhookData.total_price || '0.00').toFixed(2),
          currency: webhookData.currency,
          financial_status: webhookData.financial_status,
          fulfillment_status: webhookData.fulfillment_status,
          checkout_id: webhookData.checkout_id
        });
        
        // Send order confirmation WhatsApp (ONLY for orders/create)
        if (webhookData.customer?.phone) {
          const phone = webhookData.customer.phone.replace(/\D/g, '');
          await NotificationManager.sendNotification(
            shop,
            `+${phone}`,
            'order_placed',
            {
              customer_name: webhookData.customer.first_name || 'Customer',
              order_number: webhookData.name,
              currency: webhookData.currency || 'USD',
              total_price: parseFloat(webhookData.current_total_price || webhookData.total_price || '0.00').toFixed(2),
              items: webhookData.line_items?.map(item => ({
                name: item.name,
                quantity: item.quantity,
                price: item.price
              })),
              shipping_address: webhookData.shipping_address,
              delivery_estimate: '3-5 business days',
              order_status_url: webhookData.order_status_url || `https://${shop}/orders/${webhookData.id}`
            }
          );
          console.log('✅ Order confirmation WhatsApp sent to: +' + phone);
        }
        break;
        
      case 'orders/paid':
        console.log('💰 ORDER PAID:', webhookData.name, '- Payment confirmed (no notification sent)');
        // Don't send notification for orders/paid to avoid duplicates
        break;
        
      case 'orders/fulfilled':
        console.log('📦 ORDER FULFILLED:', webhookData.name);
        // Send shipping notification
        if (webhookData.customer?.phone) {
          const phone = webhookData.customer.phone.replace(/\D/g, '');
          const fulfillment = webhookData.fulfillments?.[0];
          
          await NotificationManager.sendNotification(
            shop,
            `+${phone}`,
            'order_fulfilled',
            {
              customer_name: webhookData.customer.first_name,
              order_number: webhookData.name,
              carrier: fulfillment?.tracking_company || 'Our shipping partner',
              tracking_number: fulfillment?.tracking_number || '',
              tracking_url: fulfillment?.tracking_urls?.[0] || '',
              delivery_date: '3-5 business days'
            }
          );
          console.log('✅ Shipping notification WhatsApp sent to:', phone);
        }
        break;
        
      case 'checkouts/create':
        console.log('🛒 CHECKOUT CREATED:', webhookData.id);
        // Track potential abandoned cart
        if (webhookData.phone) {
          await DatabaseQueries.saveAbandonedCart({
            shop_domain: shop,
            checkout_id: webhookData.id,
            checkout_token: webhookData.token,
            customer_email: webhookData.email,
            customer_phone: webhookData.phone,
            customer_name: webhookData.billing_address?.first_name,
            cart_value: parseFloat(webhookData.current_total_price || webhookData.total_price || '0.00'),
            currency: webhookData.currency,
            items_count: webhookData.line_items?.length || 0,
            line_items: webhookData.line_items,
            checkout_url: webhookData.abandoned_checkout_url
          });
          console.log('✅ Abandoned cart tracked for:', webhookData.phone);
        }
        break;
        
      case 'checkouts/update':
        console.log('🛒 CHECKOUT UPDATED:', webhookData.id);
        
        // Ensure shop exists before processing
        const shopExists2 = await ensureShopExists(shop, req);
        if (!shopExists2) {
          console.error(`❌ Could not create/find shop: ${shop}`);
          return res.status(500).send('Shop validation failed');
        }
        
        // If checkout is completed, only update database (NO WhatsApp notification)
        if (webhookData.completed_at && webhookData.phone) {
          // Mark cart as recovered in database only
          if (webhookData.id) {
            await DatabaseQueries.markCartRecovered(webhookData.id, webhookData.total_price);
          }
          console.log('✅ Checkout completed, cart marked as recovered (no notification sent)');
        }
        break;
        
      case 'customers/create':
        console.log('👤 NEW CUSTOMER:', webhookData.email);
        // Save customer and send welcome message
        await DatabaseQueries.createOrUpdateCustomer({
          shop_domain: shop,
          customer_phone: webhookData.phone,
          customer_email: webhookData.email,
          first_name: webhookData.first_name,
          last_name: webhookData.last_name
        });
        
        if (webhookData.phone) {
          const phone = webhookData.phone.replace(/\D/g, '');
          await NotificationManager.sendNotification(
            shop,
            `+${phone}`,
            'welcome_customer',
            {
              customer_name: webhookData.first_name,
              shop_name: shop.replace('.myshopify.com', ''),
              free_shipping_threshold: '$50',
              shop_url: `https://${shop}`
            }
          );
          console.log('✅ Welcome WhatsApp sent to new customer:', phone);
        }
        break;
        
      case 'orders/updated':
        console.log('📝 ORDER UPDATED:', webhookData.name, 'Status:', webhookData.fulfillment_status);
        
        // Ensure shop exists before processing
        const shopExists3 = await ensureShopExists(shop, req);
        if (!shopExists3) {
          console.error(`❌ Could not create/find shop: ${shop}`);
          return res.status(500).send('Shop validation failed');
        }
        
        // Only send notification if order status changed to fulfilled
        if (webhookData.fulfillment_status === 'fulfilled' && webhookData.customer?.phone) {
          const phone = webhookData.customer.phone.replace(/\D/g, '');
          await NotificationManager.sendNotification(
            shop,
            `+${phone}`,
            'order_processing',
            {
              customer_name: webhookData.customer.first_name,
              order_number: webhookData.name
            }
          );
          console.log('✅ Order status update sent to:', phone);
        }
        break;
        
      default:
        console.log(`📦 Unhandled webhook: ${topic}`);
    }
    
    res.status(200).send('OK');
    
  } catch (error) {
    console.error(`❌ Error processing ${topic} webhook:`, error);
    res.status(500).send('Webhook processing error');
  }
});

// API endpoint to get real store statistics
app.get('/api/stats', async (req, res) => {
  const shop = req.shop;
  
  try {
    // Get shop data from database
    const shopData = await DatabaseQueries.getShop(shop);
    if (!shopData?.access_token) {
      return res.status(401).json({ error: 'Shop not authenticated' });
    }

    // Create session for Shopify API calls
    const { Session } = require('@shopify/shopify-api');
    const session = new Session({
      id: `offline_${shop}`,
      shop: shop,
      state: '',
      isOnline: false,
      accessToken: shopData.access_token,
      scope: process.env.SHOPIFY_SCOPES
    });

    // Fetch real data from Shopify
    const client = new shopify.api.clients.Graphql({ session });
    
    // Get orders from last 30 days
    const ordersQuery = `
      query getRecentOrders($first: Int!) {
        orders(first: $first, query: "created_at:>'${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}'") {
          edges {
            node {
              id
              name
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              createdAt
              displayFulfillmentStatus
              customer {
                id
              }
            }
          }
        }
      }
    `;
    
    const ordersResponse = await client.request(ordersQuery, {
      variables: { first: 50 }
    });

    const orders = ordersResponse.data.orders.edges.map(edge => edge.node);
    
    // Calculate real statistics
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayOrders = orders.filter(order => 
      new Date(order.createdAt) >= today
    );
    
    const totalRevenue = orders.reduce((sum, order) => 
      sum + parseFloat(order.totalPriceSet.shopMoney.amount), 0
    );
    
    // Get customers with phone from database instead of GraphQL
    const customersWithPhone = await DatabaseQueries.getCustomersWithPhoneCount(shop);

    // Get WhatsApp messages from database
    const messages = await DatabaseQueries.getShopMessages(shop);
    const messagesToday = messages.filter(msg => 
      new Date(msg.created_at) >= today
    );

    // Calculate delivery rate from messages
    const deliveredMessages = messages.filter(msg => 
      msg.status === 'delivered' || msg.status === 'sent'
    );
    const deliveryRate = messages.length > 0 ? 
      ((deliveredMessages.length / messages.length) * 100).toFixed(1) : '0';

    // Calculate messages this week
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const messagesThisWeek = messages.filter(msg => 
      new Date(msg.created_at) >= weekAgo
    );

    // Calculate response rate (replies received / messages sent)
    const outboundMessages = messages.filter(msg => 
      msg.direction === 'outbound' || !msg.direction
    );
    const inboundMessages = messages.filter(msg => 
      msg.direction === 'inbound'
    );
    const responseRate = outboundMessages.length > 0 ? 
      ((inboundMessages.length / outboundMessages.length) * 100).toFixed(1) : '0';

    // Calculate WhatsApp attributed revenue (orders with phone numbers)
    const whatsappOrders = orders.filter(order => order.customer?.phone);
    const whatsappRevenue = whatsappOrders.reduce((sum, order) => 
      sum + parseFloat(order.totalPriceSet.shopMoney.amount), 0
    );

    // Calculate conversion rate (orders with phone / customers with phone)
    const whatsappConversionRate = customersWithPhone > 0 ? 
      ((whatsappOrders.length / customersWithPhone) * 100).toFixed(1) : '0';

    // Calculate ROAS (Return on Ad Spend) - simplified calculation
    const messagingCost = messages.length * 0.05; // Estimate $0.05 per message
    const roas = messagingCost > 0 ? (whatsappRevenue / messagingCost).toFixed(1) : '0';

    // Calculate abandoned cart recovery metrics
    const abandonedCartMessages = messages.filter(msg => 
      msg.message_type === 'abandoned_cart' || msg.campaign_type === 'abandoned_cart'
    );
    const abandonedCartRevenue = orders.filter(order => {
      // Find orders that came after abandoned cart messages
      const orderTime = new Date(order.createdAt);
      return abandonedCartMessages.some(msg => {
        const msgTime = new Date(msg.created_at);
        return orderTime > msgTime && (orderTime - msgTime) < 7 * 24 * 60 * 60 * 1000; // Within 7 days
      }) && order.customer?.phone;
    }).reduce((sum, order) => sum + parseFloat(order.totalPriceSet.shopMoney.amount), 0);

    const cartsRecovered = Math.floor(abandonedCartRevenue / (orders.length > 0 ? totalRevenue / orders.length : 100));
    const recoveryRate = abandonedCartMessages.length > 0 ? 
      ((cartsRecovered / abandonedCartMessages.length) * 100).toFixed(1) : '0';

    const stats = {
      // Main dashboard stats
      messagesToday: messagesToday.length,
      messagesTodayGrowth: 12, // Could calculate from historical data
      messagesThisWeek: messagesThisWeek.length,
      totalMessages: messages.length,
      ordersToday: todayOrders.length,
      totalOrders: orders.length,
      revenue30Days: totalRevenue.toFixed(2),
      revenueGrowth: 24, // Could calculate from historical data
      customersWithPhone: customersWithPhone,
      customersGrowth: 8, // Could calculate from historical data
      conversionRate: whatsappConversionRate,
      avgOrderValue: orders.length > 0 ? (totalRevenue / orders.length).toFixed(2) : '0',
      currencyCode: orders.length > 0 ? orders[0].totalPriceSet.shopMoney.currencyCode : 'USD',
      
      // Analytics tab stats
      deliveryRate: deliveryRate,
      deliveryRateGrowth: 2.1, // Could calculate from historical data
      responseRate: responseRate,
      openRate: 85.2, // Would need WhatsApp Business API for real data
      clickRate: 12.8, // Would need click tracking
      whatsappRevenue: whatsappRevenue.toFixed(2),
      whatsappRevenueGrowth: 18, // Could calculate from historical data
      analyticsConversionRate: whatsappConversionRate,
      roas: roas,

      // Cart recovery stats
      cartsRecovered: cartsRecovered,
      cartsRecoveredGrowth: 23, // Could calculate from historical data
      recoveryRate: recoveryRate,
      recoveredValue: abandonedCartRevenue.toFixed(2),

      // Campaign performance data
      campaigns: [
        {
          name: 'Abandoned Cart Recovery',
          messages: abandonedCartMessages.length,
          deliveryRate: abandonedCartMessages.length > 0 ? 
            ((abandonedCartMessages.filter(m => m.status === 'delivered' || m.status === 'sent').length / abandonedCartMessages.length) * 100).toFixed(1) : '0',
          clickRate: '15.3', // Would need click tracking
          revenue: abandonedCartRevenue.toFixed(0),
          roi: abandonedCartRevenue > 0 ? ((abandonedCartRevenue / (abandonedCartMessages.length * 0.05)) * 100 - 100).toFixed(0) : '0',
          color: 'var(--success)'
        },
        {
          name: 'Order Confirmations',
          messages: messages.filter(msg => msg.message_type === 'order_confirmation' || msg.campaign_type === 'order_confirmation').length,
          deliveryRate: '99.1',
          clickRate: '8.7',
          revenue: (whatsappRevenue * 0.3).toFixed(0), // Estimate 30% of revenue from order confirmations
          roi: '180',
          color: 'var(--info)'
        },
        {
          name: 'Welcome Messages',
          messages: messages.filter(msg => msg.message_type === 'welcome' || msg.campaign_type === 'welcome').length,
          deliveryRate: '97.8',
          clickRate: '12.4',
          revenue: (whatsappRevenue * 0.25).toFixed(0), // Estimate 25% of revenue from welcome messages
          roi: '240',
          color: 'var(--warning)'
        }
      ]
    };

    res.json(stats);
    
  } catch (error) {
    console.error('Error fetching stats:', error);
    // Return fallback data if API fails
    res.json({
      messagesToday: 0,
      totalMessages: 0,
      ordersToday: 0,
      totalOrders: 0,
      revenue30Days: '0.00',
      customersWithPhone: 0,
      conversionRate: '0',
      avgOrderValue: '0.00',
      currencyCode: 'USD',
      error: 'Failed to fetch real data'
    });
  }
});

// API endpoint to send WhatsApp to specific customer
app.post('/api/send-whatsapp', async (req, res) => {
  const shop = req.shop;
  const { phone, message, orderNumber } = req.body;
  
  if (!twilioClient) {
    return res.status(400).json({ error: 'WhatsApp not configured' });
  }
  
  if (!phone || !message) {
    return res.status(400).json({ error: 'Phone and message required' });
  }
  
  try {
    // Format phone number for WhatsApp
    let whatsappPhone = phone.replace(/\D/g, ''); // Remove non-digits
    if (!whatsappPhone.startsWith('+')) {
      whatsappPhone = '+' + whatsappPhone;
    }
    
    // Ensure proper WhatsApp format for both numbers
    const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER.startsWith('whatsapp:') 
      ? process.env.TWILIO_WHATSAPP_NUMBER 
      : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
      
    const toNumber = `whatsapp:${whatsappPhone}`;
    
    console.log('📱 API sending WhatsApp from:', fromNumber, 'to:', toNumber);
    
    const whatsappMessage = await twilioClient.messages.create({
      body: message,
      from: fromNumber,
      to: toNumber
    });
    
    // Save message to database
    await DatabaseQueries.createMessage(
      shop,
      whatsappPhone,
      message,
      'outbound',
      orderNumber || null,
      whatsappMessage.sid
    );
    
    res.json({ 
      success: true, 
      messageSid: whatsappMessage.sid,
      phone: whatsappPhone
    });
    
  } catch (error) {
    console.error('Error sending WhatsApp:', error);
    res.status(500).json({ error: error.message });
  }
});

// Import notification manager
const NotificationManager = require('./services/notificationManager');

// ============= COMPREHENSIVE SHOPIFY WEBHOOKS =============

// 1. CHECKOUT CREATED (Track potential abandoned carts)
app.post('/webhooks/checkout-created', async (req, res) => {
  const checkout = req.body;
  console.log('🛒 CHECKOUT CREATED:', checkout.id);
  
  try {
    if (checkout.phone) {
      // Save potential abandoned cart for tracking
      await DatabaseQueries.saveAbandonedCart({
        shop_domain: req.get('X-Shopify-Shop-Domain'),
        checkout_id: checkout.id,
        checkout_token: checkout.token,
        customer_email: checkout.email,
        customer_phone: checkout.phone,
        customer_name: checkout.billing_address?.first_name,
        cart_value: parseFloat(checkout.current_total_price || checkout.total_price || '0.00'),
        currency: checkout.currency,
        items_count: checkout.line_items?.length || 0,
        line_items: checkout.line_items,
        checkout_url: checkout.abandoned_checkout_url
      });
    }
  } catch (error) {
    console.error('Error processing checkout created:', error);
  }
  
  res.status(200).send('OK');
});

// 2. CHECKOUT UPDATED (Order completions) - NOTIFICATION DISABLED
app.post('/webhooks/checkout-updated', async (req, res) => {
  const checkout = req.body;
  console.log('🛒 CHECKOUT UPDATED:', checkout.id);
  
  try {
    if (checkout.completed_at && checkout.phone) {
      // Order completed - only update database (NO NOTIFICATION)
      console.log('✅ Order completed, updating database only (notification disabled)');
      
      // Mark cart as recovered in database only
      if (checkout.id) {
        await DatabaseQueries.markCartRecovered(checkout.id, checkout.total_price);
      }
    }
  } catch (error) {
    console.error('Error processing checkout update:', error);
  }
  
  res.status(200).send('OK');
});

// 3. ORDER FULFILLED (Shipping notifications)
app.post('/webhooks/order-fulfilled', async (req, res) => {
  const order = req.body;
  console.log('📦 ORDER FULFILLED:', order.name);
  
  try {
    if (order.customer?.phone) {
      const phone = order.customer.phone.replace(/\D/g, '');
      const fulfillment = order.fulfillments?.[0];
      
      await NotificationManager.sendNotification(
        req.get('X-Shopify-Shop-Domain'),
        `+${phone}`,
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
      
      // Update database
      await DatabaseQueries.updateOrderShipping(order.id, true);
    }
  } catch (error) {
    console.error('Error processing order fulfilled:', error);
  }
  
  res.status(200).send('OK');
});

// 4. CUSTOMER CREATED (Welcome messages)
app.post('/webhooks/customer-created', async (req, res) => {
  const customer = req.body;
  console.log('👤 NEW CUSTOMER:', customer.email);
  
  try {
    const shopDomain = req.get('X-Shopify-Shop-Domain');
    
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
        `+${phone}`,
        'welcome_customer',
        {
          customer_name: customer.first_name,
          shop_name: shopDomain.replace('.myshopify.com', ''),
          free_shipping_threshold: '$50',
          shop_url: `https://${shopDomain}`
        }
      );
    }
  } catch (error) {
    console.error('Error processing customer created:', error);
  }
  
  res.status(200).send('OK');
});

// ============= WHATSAPP INCOMING MESSAGES =============

// WhatsApp Incoming Messages Handler
app.post('/whatsapp/webhook', async (req, res) => {
  console.log('📱 Incoming WhatsApp message');
  
  const { From, To, Body, ProfileName, MessageSid } = req.body;
  
  // Extract phone number (remove 'whatsapp:' prefix)
  const phoneNumber = From.replace('whatsapp:', '');
  const messageBody = Body.toLowerCase().trim();
  
  try {
    // Get shop domain from customer phone number
    let shopDomain = null;
    let shopData = null;
    
    try {
      // This gets the most recently interacted shop for the customer
      shopData = await DatabaseQueries.getShopByCustomerPhone(phoneNumber);
      if (shopData) {
        shopDomain = shopData.shop_domain;
        console.log('🏪 Found shop for customer:', shopDomain);
      } else {
        console.log('⚠️ No shop found for customer phone:', phoneNumber);
        // Use a default shop domain as fallback (for testing/demo purposes)
        // In production, you might want to handle this differently
        shopDomain = 'dowhatss1.myshopify.com';
        
        // Note: For multi-shop scenarios where a customer might belong to multiple shops,
        // you could use DatabaseQueries.getAllShopsForCustomerPhone(phoneNumber) 
        // and implement logic to:
        // 1. Ask the customer which shop they're inquiring about
        // 2. Parse the message for shop-specific keywords
        // 3. Use context from previous messages
      }
    } catch (error) {
      console.error('❌ Error getting shop for customer:', error);
      shopDomain = 'dowhatss1.myshopify.com'; // Fallback
    }
    
    let responseMessage = '';
    
    // Auto-response logic
    if (messageBody === 'help' || messageBody === 'hi' || messageBody === 'hello') {
      responseMessage = `Hi ${ProfileName}! 👋\n\nHere are the available commands:\n\n` +
                       `📦 ORDER - Check order status\n` +
                       `🛒 CART - View abandoned cart\n` +
                       `💬 SUPPORT - Chat with agent\n` +
                       `🔔 STOP - Unsubscribe\n\n` +
                       `Just type any command to continue!`;
    } 
    else if (messageBody === 'order' || messageBody === 'status') {
      responseMessage = `To check your order status, please provide your order number or email address.`;
    }
    else if (messageBody === 'support' || messageBody === 'agent') {
      responseMessage = `Connecting you with support. Someone will respond within 5 minutes during business hours (Mon-Fri 9AM-6PM EST).`;
    }
    else if (messageBody === 'stop' || messageBody === 'unsubscribe') {
      // Update customer opt-out status in database
      try {
        if (shopDomain) {
          await DatabaseQueries.updateCustomerOptOut(shopDomain, phoneNumber);
          responseMessage = `You've been unsubscribed from WhatsApp notifications. Reply START anytime to resubscribe.`;
        } else {
          responseMessage = `Unable to process unsubscribe request. Please try again.`;
        }
      } catch (error) {
        responseMessage = `Unable to process unsubscribe request. Please try again.`;
      }
    }
    else {
      // Default response
      responseMessage = `Thanks for your message! Type HELP to see available commands or SUPPORT to chat with an agent.`;
    }
    
    // Send auto-reply
    if (responseMessage && twilioClient) {
      await twilioClient.messages.create({
        body: responseMessage,
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: From
      });
      
      console.log('✅ Auto-reply sent');
    }
    
    // Save incoming message to database and update last interaction
    if (shopDomain) {
      try {
        await DatabaseQueries.createMessage(
          shopDomain,
          phoneNumber,
          Body,
          'inbound',
          null,
          MessageSid
        );
        console.log('💾 Incoming message saved for shop:', shopDomain);
        
        // Update customer's last interaction time
        await DatabaseQueries.updateCustomerLastInteraction(shopDomain, phoneNumber);
      } catch (error) {
        console.warn('⚠️ Failed to save incoming message:', error.message);
      }
    }
    
  } catch (error) {
    console.error('❌ Error processing WhatsApp message:', error);
  }
  
  res.status(200).send('OK');
});

// WhatsApp Status Updates
app.post('/whatsapp/status', async (req, res) => {
  const { MessageSid, MessageStatus, To, ErrorCode, ErrorMessage } = req.body;
  
  console.log('📊 WhatsApp Status Update:', {
    messageSid: MessageSid,
    status: MessageStatus,
    to: To
  });
  
  // Update message status in database
  try {
    await DatabaseQueries.updateMessageStatus(MessageSid, MessageStatus);
  } catch (error) {
    console.warn('⚠️ Failed to update message status:', error.message);
  }
  
  res.status(200).send('OK');
});

// ============= ABANDONED CART RECOVERY =============

// Manual trigger for abandoned cart recovery
app.post('/api/trigger-abandoned-cart', async (req, res) => {
  const shop = req.get('X-Shopify-Shop-Domain');
  
  try {
    // Get abandoned carts (older than 1 hour)
    const abandonedCarts = await DatabaseQueries.getAbandonedCarts(shop, 1);
    
    for (const cart of abandonedCarts) {
      if (cart.customer_phone) {
        await NotificationManager.sendNotification(
          shop,
          cart.customer_phone,
          'abandoned_cart_1h',
          {
            customer_name: cart.customer_name || 'Customer',
            items: JSON.parse(cart.line_items || '[]'),
            currency: cart.currency,
            cart_value: cart.cart_value,
            checkout_url: cart.checkout_url
          }
        );
        
        // Increment reminder count
        await DatabaseQueries.incrementReminderCount(cart.id);
      }
    }
    
    res.json({ success: true, processed: abandonedCarts.length });
  } catch (error) {
    console.error('Error processing abandoned carts:', error);
    res.status(500).json({ error: 'Failed to process abandoned carts' });
  }
});

// Test endpoint
app.get('/test-whatsapp-simple', async (req, res) => {
  if (!twilioClient) {
    return res.send('⚠️ Twilio not configured. Check your .env.local file.');
  }
  
  try {
    // Ensure proper WhatsApp format for both from and to numbers
    let cleanFromNumber = process.env.TWILIO_WHATSAPP_NUMBER;
    if (cleanFromNumber.startsWith('whatsapp:')) {
      cleanFromNumber = cleanFromNumber.replace('whatsapp:', '');
    }
    const fromNumber = `whatsapp:${cleanFromNumber}`;
      
    const testPhone = process.env.TEST_PHONE_NUMBER || '+966592000903';
    let cleanToNumber = testPhone;
    if (cleanToNumber.startsWith('whatsapp:')) {
      cleanToNumber = cleanToNumber.replace('whatsapp:', '');
    }
    const toNumber = `whatsapp:${cleanToNumber}`;
    
    console.log('📱 Sending WhatsApp from:', fromNumber, 'to:', toNumber);
    
    const message = await twilioClient.messages.create({
      body: 'Hello from your Shopify WhatsApp app! 🛍️',
      from: fromNumber,
      to: toNumber
    });
    
    res.send(`✅ Success! WhatsApp message sent. SID: ${message.sid}`);
  } catch (error) {
    console.error('WhatsApp send error:', error);
    res.send(`❌ Error: ${error.message}`);
  }
});

// ============= ADDITIONAL WHATSAPP UTILITIES =============

// Send custom WhatsApp message endpoint
app.post('/api/send-custom-whatsapp', async (req, res) => {
  const shop = req.shop;
  const { phone, message, orderNumber } = req.body;
  
  try {
    const result = await NotificationManager.sendCustomMessage(
      shop,
      phone,
      message,
      orderNumber
    );
    
    if (result.success) {
      res.json({ 
        success: true, 
        messageSid: result.messageSid,
        phone: result.phone
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error 
      });
    }
  } catch (error) {
    console.error('Error sending custom WhatsApp:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test notification templates
app.get('/api/test-notifications/:template', async (req, res) => {
  const shop = req.shop;
  const template = req.params.template;
  const testPhone = process.env.TEST_PHONE_NUMBER;
  
  if (!testPhone) {
    return res.status(400).json({ error: 'TEST_PHONE_NUMBER not configured' });
  }

  // Sample data for different templates
  const testData = {
    order_placed: {
      customer_name: 'John Doe',
      order_number: '#1001',
      currency: 'USD',
      total_price: '99.99',
      items: [{ name: 'Test Product', quantity: 1, price: '99.99' }],
      shipping_address: { address1: '123 Test St', city: 'Test City', country: 'USA' },
      delivery_estimate: '3-5 business days',
      order_status_url: 'https://example.com/order/1001'
    },
    abandoned_cart_1h: {
      customer_name: 'Jane Smith',
      items: [{ name: 'Abandoned Product', price: '49.99' }],
      currency: 'USD',
      cart_value: '49.99',
      checkout_url: 'https://example.com/checkout'
    },
    welcome_customer: {
      customer_name: 'New Customer',
      shop_name: 'Test Shop',
      free_shipping_threshold: '$50',
      shop_url: 'https://example.com'
    }
  };

  try {
    const data = testData[template];
    if (!data) {
      return res.status(400).json({ error: 'Unknown template type' });
    }

    const result = await NotificationManager.sendNotification(
      shop,
      testPhone,
      template,
      data
    );

    if (result) {
      res.json({ 
        success: true, 
        messageSid: result.sid,
        template: template,
        testPhone: testPhone
      });
    } else {
      res.json({ 
        success: false, 
        error: 'Failed to send test notification'
      });
    }
  } catch (error) {
    console.error('Error sending test notification:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get WhatsApp conversation history
app.get('/api/whatsapp-history/:phone', async (req, res) => {
  const shop = req.shop;
  const phone = req.params.phone;
  
  try {
    const messages = await DatabaseQueries.getCustomerMessages(shop, phone);
    res.json({ success: true, messages });
  } catch (error) {
    console.error('Error fetching WhatsApp history:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== AUTOMATION SETTINGS API ==========

// Get automation settings
app.get('/api/automation-settings', async (req, res) => {
  const shop = req.shop;
  
  try {
    const settings = await DatabaseQueries.getAutomationSettings(shop);
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Error fetching automation settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save automation settings
app.post('/api/automation-settings', async (req, res) => {
  const shop = req.shop;
  const settings = req.body;
  
  try {
    await DatabaseQueries.saveAutomationSettings(shop, settings);
    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (error) {
    console.error('Error saving automation settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== WHATSAPP FLOWS API ==========

// Get all flows for shop
app.get('/api/whatsapp-flows', async (req, res) => {
  const shop = req.shop;
  
  try {
    const flows = await DatabaseQueries.getWhatsAppFlows(shop);
    res.json({ success: true, flows });
  } catch (error) {
    console.error('Error fetching WhatsApp flows:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create new WhatsApp flow
app.post('/api/whatsapp-flows', async (req, res) => {
  const shop = req.shop;
  const flowData = req.body;
  
  try {
    const result = await DatabaseQueries.createWhatsAppFlow(shop, flowData);
    res.json({ success: true, flowId: result.id, message: 'Flow created successfully' });
  } catch (error) {
    console.error('Error creating WhatsApp flow:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update existing WhatsApp flow
app.put('/api/whatsapp-flows/:id', async (req, res) => {
  const shop = req.shop;
  const flowId = req.params.id;
  const flowData = req.body;
  
  try {
    const result = await DatabaseQueries.updateWhatsAppFlow(flowId, shop, flowData);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    res.json({ success: true, message: 'Flow updated successfully' });
  } catch (error) {
    console.error('Error updating WhatsApp flow:', error);
    res.status(500).json({ error: error.message });
  }
});

// Toggle flow active status
app.patch('/api/whatsapp-flows/:id/toggle', async (req, res) => {
  const shop = req.shop;
  const flowId = req.params.id;
  
  try {
    const result = await DatabaseQueries.toggleWhatsAppFlow(flowId, shop);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    res.json({ success: true, message: 'Flow status updated successfully' });
  } catch (error) {
    console.error('Error toggling WhatsApp flow:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete WhatsApp flow
app.delete('/api/whatsapp-flows/:id', async (req, res) => {
  const shop = req.shop;
  const flowId = req.params.id;
  
  try {
    const result = await DatabaseQueries.deleteWhatsAppFlow(flowId, shop);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    res.json({ success: true, message: 'Flow deleted successfully' });
  } catch (error) {
    console.error('Error deleting WhatsApp flow:', error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to get real customer data from Shopify
app.get('/api/customers', async (req, res) => {
  const shop = req.shop;
  
  try {
    const shopData = await DatabaseQueries.getShop(shop);
    if (!shopData?.access_token) {
      return res.status(401).json({ error: 'Shop not authenticated' });
    }

    // Create session for Shopify API calls
    const { Session } = require('@shopify/shopify-api');
    const session = new Session({
      id: `offline_${shop}`,
      shop: shop,
      state: '',
      isOnline: false,
      accessToken: shopData.access_token,
      scope: process.env.SHOPIFY_SCOPES
    });

    const client = new shopify.api.clients.Graphql({ session });
    
    // Get customers with their order history and phone numbers
    const customersQuery = `
      query getCustomers($first: Int!) {
        customers(first: $first) {
          edges {
            node {
              id
              firstName
              lastName
              phone
              createdAt
              updatedAt
              tags
              numberOfOrders
              amountSpent {
                amount
                currencyCode
              }
              addresses {
                phone
              }
            }
          }
        }
      }
    `;
    
    const customersResponse = await client.request(customersQuery, {
      variables: { first: 100 }
    });

    const customers = customersResponse.data.customers.edges.map(edge => {
      const customer = edge.node;
      // Get phone from customer or their addresses
      const phone = customer.phone || customer.addresses.find(addr => addr.phone)?.phone;
      
      return {
        id: customer.id,
        name: `${customer.firstName || ''} ${customer.lastName || ''}`.trim(),
        email: null, // Not accessible without approval
        phone: phone,
        hasWhatsApp: !!phone,
        status: customer.numberOfOrders > 0 ? 'Active' : 'Inactive',
        ordersCount: customer.numberOfOrders,
        totalSpent: customer.amountSpent ? parseFloat(customer.amountSpent.amount) : 0,
        lastOrder: customer.lastOrderId ? new Date().toISOString().split('T')[0] : null,
        createdAt: customer.createdAt,
        tags: customer.tags
      };
    });

    // Get additional WhatsApp status from our database
    const customersWithWhatsAppData = await Promise.all(
      customers.map(async (customer) => {
        if (customer.phone) {
          const messages = await DatabaseQueries.getCustomerMessages(shop, customer.phone);
          customer.messagesCount = messages.length;
          customer.lastMessageDate = messages.length > 0 ? messages[0].created_at : null;
        } else {
          customer.messagesCount = 0;
          customer.lastMessageDate = null;
        }
        return customer;
      })
    );

    res.json({
      success: true,
      customers: customersWithWhatsAppData,
      stats: {
        totalCustomers: customers.length,
        withWhatsApp: customers.filter(c => c.hasWhatsApp).length,
        activeCustomers: customers.filter(c => c.status === 'Active').length,
        inactiveCustomers: customers.filter(c => c.status === 'Inactive').length
      }
    });
    
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ 
      error: 'Failed to fetch customer data',
      message: error.message 
    });
  }
});

// API endpoint to get real order data for analytics
app.get('/api/orders', async (req, res) => {
  const shop = req.shop;
  const { days = 30 } = req.query;
  
  try {
    const shopData = await DatabaseQueries.getShop(shop);
    if (!shopData?.access_token) {
      return res.status(401).json({ error: 'Shop not authenticated' });
    }

    const { Session } = require('@shopify/shopify-api');
    const session = new Session({
      id: `offline_${shop}`,
      shop: shop,
      state: '',
      isOnline: false,
      accessToken: shopData.access_token,
      scope: process.env.SHOPIFY_SCOPES
    });

    const client = new shopify.api.clients.Graphql({ session });
    
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    
    // Get orders for analytics
    const ordersQuery = `
      query getOrdersForAnalytics($first: Int!) {
        orders(first: $first, query: "created_at:>'${startDate}'") {
          edges {
            node {
              id
              name
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              createdAt
              displayFulfillmentStatus
              displayFinancialStatus
              customer {
                id
                firstName
                phone
              }
              lineItems(first: 5) {
                edges {
                  node {
                    name
                    quantity
                    variant {
                      product {
                        title
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    const ordersResponse = await client.request(ordersQuery, {
      variables: { first: 250 }
    });

    const orders = ordersResponse.data.orders.edges.map(edge => {
      const order = edge.node;
      return {
        id: order.id,
        name: order.name,
        amount: parseFloat(order.totalPriceSet.shopMoney.amount),
        currency: order.totalPriceSet.shopMoney.currencyCode,
        createdAt: order.createdAt,
        fulfillmentStatus: order.displayFulfillmentStatus,
        financialStatus: order.displayFinancialStatus,
        customer: {
          id: order.customer?.id,
          name: order.customer?.firstName,
          phone: order.customer?.phone
        },
        items: order.lineItems.edges.map(item => ({
          name: item.node.name,
          quantity: item.node.quantity,
          product: item.node.variant?.product?.title
        }))
      };
    });

    // Calculate analytics
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayOrders = orders.filter(order => 
      new Date(order.createdAt) >= today
    );
    
    const totalRevenue = orders.reduce((sum, order) => sum + order.amount, 0);
    const avgOrderValue = orders.length > 0 ? totalRevenue / orders.length : 0;
    
    // Get WhatsApp message correlation
    const ordersWithWhatsApp = await Promise.all(
      orders.map(async (order) => {
        if (order.customer.phone) {
          const messages = await DatabaseQueries.getCustomerMessages(shop, order.customer.phone);
          order.whatsappMessages = messages.length;
        } else {
          order.whatsappMessages = 0;
        }
        return order;
      })
    );

    res.json({
      success: true,
      orders: ordersWithWhatsApp,
      analytics: {
        totalOrders: orders.length,
        todayOrders: todayOrders.length,
        totalRevenue: totalRevenue.toFixed(2),
        avgOrderValue: avgOrderValue.toFixed(2),
        currency: orders.length > 0 ? orders[0].currency : 'USD',
        ordersWithWhatsApp: ordersWithWhatsApp.filter(o => o.whatsappMessages > 0).length,
        whatsappConversionRate: orders.length > 0 ? 
          ((ordersWithWhatsApp.filter(o => o.whatsappMessages > 0).length / orders.length) * 100).toFixed(1) : '0'
      }
    });
    
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ 
      error: 'Failed to fetch order data',
      message: error.message 
    });
  }
});

// API endpoint to get abandoned cart data
app.get('/api/abandoned-carts', async (req, res) => {
  const shop = req.shop;
  
  try {
    const shopData = await DatabaseQueries.getShop(shop);
    if (!shopData?.access_token) {
      return res.status(401).json({ error: 'Shop not authenticated' });
    }

    // Get abandoned carts from database
    const abandonedCarts = await DatabaseQueries.getAbandonedCarts(shop);
    
    // Get recovery statistics
    const recoveredCarts = await DatabaseQueries.getRecoveredCarts(shop);
    
    const totalAbandoned = abandonedCarts.length;
    const totalRecovered = recoveredCarts.length;
    const recoveryRate = totalAbandoned > 0 ? ((totalRecovered / totalAbandoned) * 100).toFixed(1) : '0';
    
    const totalRecoveredValue = recoveredCarts.reduce((sum, cart) => 
      sum + (parseFloat(cart.recovered_amount) || 0), 0
    );

    res.json({
      success: true,
      abandonedCarts: abandonedCarts,
      recoveredCarts: recoveredCarts,
      stats: {
        totalAbandoned,
        totalRecovered,
        recoveryRate,
        recoveredValue: totalRecoveredValue.toFixed(2),
        avgCartValue: totalAbandoned > 0 ? 
          (abandonedCarts.reduce((sum, cart) => sum + parseFloat(cart.total_price || 0), 0) / totalAbandoned).toFixed(2) : '0'
      }
    });
    
  } catch (error) {
    console.error('Error fetching abandoned carts:', error);
    res.status(500).json({ 
      error: 'Failed to fetch abandoned cart data',
      message: error.message 
    });
  }
});

// API endpoint to get campaign performance data
app.get('/api/campaign-analytics', async (req, res) => {
  const shop = req.shop;
  
  try {
    // Get all messages sent from database grouped by type
    const messages = await DatabaseQueries.getShopMessages(shop);
    
    // Group messages by template type for campaign analysis
    const campaignStats = {};
    
    messages.forEach(message => {
      const template = message.template_id || 'custom';
      if (!campaignStats[template]) {
        campaignStats[template] = {
          name: template.replace('_', ' ').toUpperCase(),
          messagesSent: 0,
          delivered: 0,
          clicked: 0, // This would need tracking implementation
          revenue: 0  // This would need attribution tracking
        };
      }
      
      campaignStats[template].messagesSent++;
      if (message.status === 'delivered' || message.status === 'sent') {
        campaignStats[template].delivered++;
      }
    });

    // Convert to array and calculate rates
    const campaigns = Object.keys(campaignStats).map(key => {
      const stats = campaignStats[key];
      return {
        ...stats,
        deliveryRate: stats.messagesSent > 0 ? 
          ((stats.delivered / stats.messagesSent) * 100).toFixed(1) : '0',
        clickRate: '12.8', // Mock for now - would need click tracking
        roi: '+320%' // Mock for now - would need revenue attribution
      };
    });

    res.json({
      success: true,
      campaigns: campaigns,
      totalMessages: messages.length,
      totalDelivered: messages.filter(m => m.status === 'delivered' || m.status === 'sent').length
    });
    
  } catch (error) {
    console.error('Error fetching campaign analytics:', error);
    res.status(500).json({ 
      error: 'Failed to fetch campaign analytics',
      message: error.message 
    });
  }
});

// Get recent conversations
app.get('/api/recent-conversations', async (req, res) => {
  const shop = req.shop;
  
  try {
    // Get recent WhatsApp messages from database
    const messages = await DatabaseQueries.getRecentConversations(shop);
    
    // Group messages by customer phone number
    const conversationsMap = new Map();
    
    messages.forEach(message => {
      const phone = message.customer_phone;
      if (!conversationsMap.has(phone)) {
        conversationsMap.set(phone, {
          name: message.customer_name || 'Unknown Customer',
          phone: phone,
          lastMessage: message.message_body || 'No message',
          time: message.created_at,
          unread: 0,
          messageCount: 0
        });
      }
      
      const conv = conversationsMap.get(phone);
      conv.messageCount++;
      
      // Keep the most recent message
      if (new Date(message.created_at) > new Date(conv.time)) {
        conv.lastMessage = message.message_body || 'No message';
        conv.time = message.created_at;
      }
    });

    const conversations = Array.from(conversationsMap.values())
      .sort((a, b) => new Date(b.time) - new Date(a.time))
      .slice(0, 20); // Limit to 20 recent conversations

    res.json({
      success: true,
      conversations: conversations
    });
    
  } catch (error) {
    console.error('Error fetching recent conversations:', error);
    
    // Fallback: return empty conversations
    res.json({ 
      success: true,
      conversations: []
    });
  }
});

// Send WhatsApp message to customer
app.post('/api/send-message', async (req, res) => {
  const shop = req.shop;
  const { phone, message, customerName } = req.body;
  
  if (!phone || !message) {
    return res.status(400).json({ 
      error: 'Phone number and message are required' 
    });
  }

  try {
    // Format phone number
    let formattedPhone = phone.replace(/\D/g, '');
    if (!formattedPhone.startsWith('1') && formattedPhone.length === 10) {
      formattedPhone = '1' + formattedPhone;
    }
    formattedPhone = '+' + formattedPhone;

    // Send message using Twilio
    if (twilioClient) {
      const twilioMessage = await twilioClient.messages.create({
        body: message,
        from: 'whatsapp:+14155238886', // Twilio Sandbox number
        to: `whatsapp:${formattedPhone}`
      });

      // Save message to database
      await DatabaseQueries.saveWhatsAppMessage({
        shop_domain: shop,
        customer_phone: formattedPhone,
        customer_name: customerName || 'Unknown',
        message_body: message,
        direction: 'outbound',
        message_sid: twilioMessage.sid,
        status: 'sent',
        template_id: 'manual_message'
      });

      res.json({
        success: true,
        message: 'Message sent successfully',
        messageSid: twilioMessage.sid
      });
    } else {
      // Mock response if Twilio not configured
      console.log('📱 MOCK: Would send WhatsApp message:', {
        to: formattedPhone,
        message: message,
        shop: shop
      });
      
      res.json({
        success: true,
        message: 'Message sent successfully (mock mode)',
        messageSid: 'mock-' + Date.now()
      });
    }
    
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    res.status(500).json({ 
      error: 'Failed to send message',
      details: error.message 
    });
  }
});

// Debug endpoint to check webhook status
app.get('/debug/webhook-status', async (req, res) => {
  const shop = req.query.shop || process.env.DEFAULT_SHOP_DOMAIN || 'dowhatss1.myshopify.com';
  
  res.json({
    webhook_endpoints: {
      main_handler: `${process.env.SHOPIFY_APP_URL}/webhooks`,
      test_order: `${process.env.SHOPIFY_APP_URL}/test-order-webhook`,
      test_notification: `${process.env.SHOPIFY_APP_URL}/api/test-notification`
    },
    configured_topics: [
      'orders/create',
      'orders/updated', 
      'orders/paid',
      'orders/fulfilled',
      'checkouts/create',
      'checkouts/update',
      'customers/create',
      'app/uninstalled'
    ],
    twilio_status: {
      configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
      test_phone: process.env.TEST_PHONE_NUMBER || 'Not configured'
    },
    shop_info: {
      default_shop: shop,
      app_url: process.env.SHOPIFY_APP_URL
    },
    test_commands: [
      `curl -X POST ${process.env.SHOPIFY_APP_URL}/test-order-webhook`,
      `curl -X POST ${process.env.SHOPIFY_APP_URL}/api/test-notification -H "Content-Type: application/json" -d '{"shop":"${shop}","template":"order_placed"}'`
    ]
  });
});

// Test endpoint to simulate order webhook
app.post('/test-order-webhook', async (req, res) => {
  console.log('🧪 Testing order webhook simulation');
  
  const testOrderData = {
    id: 'test-order-' + Date.now(),
    name: '#TEST-' + Math.floor(Math.random() * 1000),
    customer: {
      phone: process.env.TEST_PHONE_NUMBER || '+1234567890',
      first_name: 'Test',
      last_name: 'Customer'
    },
    currency: 'USD',
    current_total_price: '99.99',
    total_price: '99.99',
    line_items: [
      {
        name: 'Test Product',
        quantity: 2,
        price: '49.99'
      }
    ],
    shipping_address: {
      address1: '123 Test Street',
      city: 'Test City',
      province: 'TC',
      country: 'Test Country'
    },
    order_status_url: 'https://example.com/order/test'
  };
  
  // Simulate webhook headers
  req.headers['x-shopify-shop-domain'] = process.env.DEFAULT_SHOP_DOMAIN || 'dowhatss1.myshopify.com';
  req.headers['x-shopify-topic'] = 'orders/create';
  
  // Call the webhook handler directly
  try {
    const shop = req.headers['x-shopify-shop-domain'];
    const topic = req.headers['x-shopify-topic'];
    
    console.log(`📦 Simulating webhook: ${topic} from ${shop}`);
    
    // Send order confirmation WhatsApp
    if (testOrderData.customer?.phone) {
      const phone = testOrderData.customer.phone.replace(/\D/g, '');
      const result = await NotificationManager.sendNotification(
        shop,
        `+${phone}`,
        'order_placed',
        {
          customer_name: testOrderData.customer.first_name || 'Customer',
          order_number: testOrderData.name,
          currency: testOrderData.currency || 'USD',
          total_price: testOrderData.current_total_price || testOrderData.total_price,
          items: testOrderData.line_items?.map(item => ({
            name: item.name,
            quantity: item.quantity,
            price: item.price
          })),
          shipping_address: testOrderData.shipping_address,
          delivery_estimate: '3-5 business days',
          order_status_url: testOrderData.order_status_url
        }
      );
      
      console.log('✅ Test order confirmation WhatsApp sent to:', phone);
      
      res.json({
        success: true,
        message: 'Test order webhook processed successfully',
        order_number: testOrderData.name,
        phone: phone,
        messageSid: result?.sid
      });
    } else {
      res.json({
        success: false,
        error: 'No phone number provided in test data'
      });
    }
  } catch (error) {
    console.error('❌ Error processing test webhook:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
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
      console.log(`\n🧪 Test endpoints:`);
      console.log(`   - POST ${process.env.SHOPIFY_APP_URL}/test-order-webhook`);
      console.log(`   - POST ${process.env.SHOPIFY_APP_URL}/api/test-notification`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
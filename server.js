const express = require('express');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const crypto = require('crypto');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Basic route
app.get('/', (req, res) => {
  res.send('WhatsApp Shopify App is running!');
});



// Shopify App Installation Route
app.get('/shopify', (req, res) => {
  const shop = req.query.shop;
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${process.env.SHOPIFY_APP_URL}/shopify/callback`;
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=${process.env.SHOPIFY_SCOPES}&state=${state}&redirect_uri=${redirectUri}`;

  res.cookie('state', state);
  res.redirect(installUrl);
});

// Shopify OAuth Callback
app.get('/shopify/callback', async (req, res) => {
  const { shop, hmac, code, state } = req.query;
  
  // In production, verify the state parameter
  // For now, we'll skip this for simplicity
  
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
    console.log('Access Token:', accessToken);
    console.log('Shop:', shop);
    
    // For now, we'll store in memory (use a database in production)
    global.shopData = global.shopData || {};
    global.shopData[shop] = { accessToken };
    
    // Register webhooks
    await registerWebhooks(shop, accessToken);
    
    res.redirect(`https://${shop}/admin/apps`);
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
      console.log(`✅ Webhook registered: ${webhook.topic}`);
      results.successful.push(webhook.topic);
    } catch (error) {
      const errorMsg = error.response?.data?.errors || error.message;
      console.error(`❌ Failed ${webhook.topic}:`, errorMsg);
      results.failed.push({ topic: webhook.topic, error: errorMsg });
    }
  }
  
  console.log('\n📊 WEBHOOK REGISTRATION SUMMARY:');
  console.log(`✅ Successful: ${results.successful.length}`);
  console.log(`❌ Failed: ${results.failed.length}`);
  
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
  const shop = 'dowhatss1.myshopify.com';
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

// 3. FULFILLMENT CREATED (Shipping started)
app.post('/webhooks/fulfillment-created', async (req, res) => {
  const fulfillment = req.body;
  console.log('📦 FULFILLMENT CREATED:', fulfillment.id);
  
  // Get order details to find phone number
  const orderId = fulfillment.order_id;
  const trackingNumber = fulfillment.tracking_number;
  const trackingCompany = fulfillment.tracking_company;
  const trackingUrls = fulfillment.tracking_urls;
  
  // Send shipping notification
  if (fulfillment.destination?.phone || fulfillment.phone) {
    const phone = (fulfillment.destination?.phone || fulfillment.phone).replace(/\D/g, '');
    
    const message = `🚚 Great news! Your order has shipped!

📦 Tracking Number: ${trackingNumber || 'Will be provided soon'}
🏢 Carrier: ${trackingCompany || 'Our shipping partner'}
${trackingUrls?.length > 0 ? `🔗 Track here: ${trackingUrls[0]}` : ''}

Estimated delivery: 3-5 business days

Reply with 'TRACK' anytime for updates!`;

    try {
      await twilioClient.messages.create({
        body: message,
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: `whatsapp:+${phone}`
      });
      console.log('✅ Shipping notification sent!');
    } catch (error) {
      console.error('Error sending shipping notification:', error);
    }
  }
  
  res.status(200).send('OK');
});

// 4. FULFILLMENT UPDATED (Tracking info updated)
app.post('/webhooks/fulfillment-updated', async (req, res) => {
  const fulfillment = req.body;
  console.log('📦 Fulfillment updated:', fulfillment.id);
  
  // Send update if tracking changed
  if (fulfillment.tracking_number && fulfillment.shipment_status) {
    // Send status update via WhatsApp
    const message = `📦 Shipping Update!
    
Your package status: ${fulfillment.shipment_status}
${fulfillment.estimated_delivery_at ? `Expected delivery: ${new Date(fulfillment.estimated_delivery_at).toLocaleDateString()}` : ''}`;
    
    // Send message (need to get phone from order)
  }
  
  res.status(200).send('OK');
});

// 5. ORDER FULFILLED (All items shipped)
app.post('/webhooks/order-fulfilled', async (req, res) => {
  const order = req.body;
  console.log('✅ ORDER FULLY FULFILLED:', order.name);
  
  if (order.customer?.phone) {
    const phone = order.customer.phone.replace(/\D/g, '');
    
    const message = `🎉 Your entire order ${order.name} has been shipped!

All items are on their way to you.
Expected delivery: 3-5 business days

Thank you for your patience!`;

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:+${phone}`
    });
  }
  
  res.status(200).send('OK');
});

// 6. ORDER PARTIALLY FULFILLED (Some items shipped)
app.post('/webhooks/order-partial-fulfilled', async (req, res) => {
  const order = req.body;
  console.log('📦 Order partially fulfilled:', order.name);
  
  if (order.customer?.phone) {
    const phone = order.customer.phone.replace(/\D/g, '');
    
    // Check which items shipped
    const shippedItems = order.fulfillments?.map(f => f.line_items).flat() || [];
    
    const message = `📦 Part of your order ${order.name} has shipped!

Shipped items:
${shippedItems.map(item => `• ${item.name}`).join('\n')}

Remaining items will ship soon!`;

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:+${phone}`
    });
  }
  
  res.status(200).send('OK');
});

// 7. ORDER CANCELLED
app.post('/webhooks/order-cancelled', async (req, res) => {
  const order = req.body;
  console.log('❌ ORDER CANCELLED:', order.name);
  
  if (order.customer?.phone) {
    const phone = order.customer.phone.replace(/\D/g, '');
    
    const message = `Your order ${order.name} has been cancelled.

Refund amount: ${order.currency} ${order.total_price}
Refund will be processed in 3-5 business days.

If you didn't request this, please contact us immediately!`;

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:+${phone}`
    });
  }
  
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

// 9. REFUND CREATED
app.post('/webhooks/refund-created', async (req, res) => {
  const refund = req.body;
  console.log('💰 REFUND CREATED:', refund.id);
  
  // Note: refund object doesn't have phone directly
  // You need to fetch the order to get customer phone
  
  const message = `💰 Refund Processed!

Amount: ${refund.transactions?.[0]?.amount}
Reason: ${refund.note || 'N/A'}

Expect to see the refund in 3-5 business days.`;
  
  // Send if you can get phone from order
  
  res.status(200).send('OK');
});

// 10. ORDER UPDATED (Any change)
app.post('/webhooks/order-updated', async (req, res) => {
  const order = req.body;
  console.log('📝 Order updated:', order.name, 'Status:', order.fulfillment_status);
  
  // This fires for ANY order change
  // Check what specifically changed before sending WhatsApp
  
  res.status(200).send('OK');
});


// Add this debug endpoint
app.get('/debug/webhooks', async (req, res) => {
  const shop = 'dowhatss1.myshopify.com';
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
      phone: '+966592000903'
    },
    line_items: [
      { name: 'Amazing Product', quantity: 1, price: '299.00' }
    ],
    shipping_address: {
      address1: '123 Test Street',
      city: 'Riyadh',
      country: 'Saudi Arabia'
    },
    order_status_url: 'https://dowhatss1.myshopify.com/order/1001'
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
        'dowhatss1.myshopify.com',
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
            <p>Message ID: ${result.sid}</p>
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
app.post('/webhooks/checkout-updated', (req, res) => {
  console.log('🛒 Checkout updated:', req.body);
  
  // Check if it's abandoned (no completed_at)
  if (!req.body.completed_at && req.body.abandoned_checkout_url) {
    console.log('⚠️ Potential abandoned cart detected');
    handleAbandonedCart(req.body);
  }
  
  res.status(200).send('OK');
});

// Add this test route
app.get('/test-abandoned-cart', async (req, res) => {
  const testCart = {
    id: 'test-' + Date.now(),
    email: 'test@example.com',
    customer: {
      first_name: 'Test',
      phone: '+966592000903'
    },
    line_items: [
      { title: 'Test Product', price: '99.00' }
    ],
    total_price: '99.00',
    abandoned_checkout_url: 'https://dowhatss1.myshopify.com/checkout/test',
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

app.post('/webhooks/customer-created', (req, res) => {
  console.log('New customer:', req.body);
  // Send welcome message via WhatsApp
  sendWelcomeMessage(req.body);
  res.status(200).send('OK');
});

// WhatsApp Functions
const twilio = require('twilio');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function sendWhatsAppMessage(to, message) {
  try {
    const result = await twilioClient.messages.create({
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
app.get('/test-whatsapp-simple', async (req, res) => {
  console.log('Starting simple WhatsApp test...');
  
  // CHANGE THIS TO YOUR PHONE NUMBER
  const YOUR_PHONE = '+966592000903';  // <-- PUT YOUR NUMBER HERE
  
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

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Make sure to run ngrok: ngrok http ${PORT}`);
});
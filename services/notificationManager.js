// services/notificationManager.js
const DatabaseQueries = require('../database/queries');
const { db } = require('../database');

// Initialize Twilio client only if credentials are valid
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

class NotificationManager {
  constructor() {
    this.templates = this.loadTemplates();
    this.enabled = true;
  }

  // Load message templates with multi-language support
  loadTemplates() {
    return {
      en: {
        // ORDER NOTIFICATIONS
        order_placed: `🎉 Order Confirmed!\n\nThank you {{customer_name}}!\n\nOrder #{{order_number}}\nTotal: {{currency}} {{total_price}}\n\n📦 Items:\n{{items}}\n\n📍 Delivery to:\n{{shipping_address}}\n\nEstimated delivery: {{delivery_estimate}}\n\nTrack your order: {{order_status_url}}\n\nQuestions? Reply to this message!`,
        
        order_paid: `💳 Payment Confirmed!\n\nHi {{customer_name}}, we've received your payment for Order #{{order_number}}.\n\nAmount: {{currency}} {{total_price}}\n\nYour order is now being prepared for shipping! 📦`,
        
        order_processing: `⚙️ Order Update\n\nHi {{customer_name}}! Your order #{{order_number}} is being processed.\n\nWe're preparing your items for shipping. You'll receive tracking info soon!`,
        
        order_fulfilled: `📦 Shipped!\n\nGreat news {{customer_name}}! Your order #{{order_number}} has been shipped!\n\n🚚 Carrier: {{carrier}}\n📍 Tracking: {{tracking_number}}\n🔗 Track here: {{tracking_url}}\n\nEstimated delivery: {{delivery_date}}`,
        
        order_out_for_delivery: `🚚 Out for Delivery!\n\n{{customer_name}}, your order #{{order_number}} is out for delivery today!\n\nPlease ensure someone is available to receive the package.\n\nTracking: {{tracking_url}}`,
        
        order_delivered: `✅ Delivered!\n\nHi {{customer_name}}, your order #{{order_number}} has been delivered!\n\nWe hope you love your purchase! 💙\n\nRate your experience: {{review_url}}\n\nHave issues? Reply to this message.`,
        
        order_cancelled: `❌ Order Cancelled\n\n{{customer_name}}, your order #{{order_number}} has been cancelled.\n\nRefund amount: {{currency}} {{refund_amount}}\nRefund will be processed in 3-5 business days.\n\nQuestions? Reply here or call {{support_phone}}`,
        
        order_refunded: `💰 Refund Processed\n\nHi {{customer_name}}, your refund has been processed.\n\nOrder: #{{order_number}}\nAmount: {{currency}} {{refund_amount}}\n\nPlease allow 3-5 business days for the refund to appear in your account.`,
        
        // CHECKOUT NOTIFICATIONS
        checkout_started: `🛒 Complete Your Purchase!\n\nHi {{customer_name}}! You started a checkout but didn't complete it.\n\n📦 Your items:\n{{items}}\n\nTotal: {{currency}} {{total_price}}\n\n🎁 Complete now and get FREE shipping!\n{{checkout_url}}\n\nNeed help? Reply to this message!`,
        
        abandoned_cart_1h: `🛒 You left something behind!\n\nHi {{customer_name}}, you have items in your cart:\n\n{{items}}\n\nTotal: {{currency}} {{total_price}}\n\nComplete your purchase: {{checkout_url}}\n\nYour cart will be saved for 24 hours.`,
        
        abandoned_cart_24h: `⏰ Last Chance!\n\n{{customer_name}}, your cart is about to expire!\n\n{{items}}\n\n💰 Get 10% OFF with code: SAVE10\n\nComplete purchase: {{checkout_url}}\n\nThis offer expires in 2 hours!`,
        
        abandoned_cart_final: `😢 We're holding your items!\n\n{{customer_name}}, don't miss out!\n\n{{items}}\n\n🎁 Special offer: 15% OFF with code: COMEBACK15\n\n{{checkout_url}}\n\nThis is our final reminder.`,
        
        // CUSTOMER ACCOUNT NOTIFICATIONS
        welcome_customer: `🎉 Welcome to {{shop_name}}!\n\nHi {{customer_name}}, thanks for joining our family!\n\n🎁 Here's your welcome gift:\n• 15% off your first order with code: WELCOME15\n• Free shipping on orders over {{free_shipping_threshold}}\n• Early access to sales\n\n📱 Save this number for:\n• Order updates\n• Exclusive deals\n• Quick support\n\nShop now: {{shop_url}}\n\nReply STOP to unsubscribe.`,
        
        customer_birthday: `🎂 Happy Birthday {{customer_name}}!\n\n{{shop_name}} wishes you a wonderful day!\n\n🎁 Here's your birthday gift:\n30% OFF everything with code: BDAY30\n\nValid for 7 days. Treat yourself!\n\n{{shop_url}}`,
        
        vip_status_achieved: `⭐ VIP Status Unlocked!\n\nCongratulations {{customer_name}}!\n\nYou're now a VIP member! Enjoy:\n• 20% off all orders\n• Free shipping always\n• Early access to new products\n• Priority support\n\nThank you for being amazing! 💙`,
        
        // SHIPPING NOTIFICATIONS
        shipping_label_created: `📋 Shipping Label Created\n\n{{customer_name}}, we're preparing your order #{{order_number}} for shipment!\n\nYou'll receive tracking info once the carrier picks it up.`,
        
        shipping_delayed: `⚠️ Shipping Delay\n\nHi {{customer_name}}, your order #{{order_number}} is delayed.\n\nNew estimated delivery: {{new_delivery_date}}\n\nWe apologize for the inconvenience. Track updates: {{tracking_url}}`,
        
        shipping_exception: `⚠️ Delivery Issue\n\n{{customer_name}}, there's an issue delivering your order #{{order_number}}.\n\nIssue: {{exception_reason}}\n\nPlease contact us to resolve: {{support_phone}}`,
        
        // PRODUCT NOTIFICATIONS
        back_in_stock: `🎉 Back in Stock!\n\nHi {{customer_name}}, great news!\n\n"{{product_name}}" is back in stock!\n\n{{product_description}}\nPrice: {{currency}} {{price}}\n\n🛒 Buy now: {{product_url}}\n\nLimited quantity available!`,
        
        price_drop: `💰 Price Drop Alert!\n\n{{customer_name}}, an item you viewed is now on sale!\n\n"{{product_name}}"\nWas: {{currency}} {{original_price}}\nNow: {{currency}} {{sale_price}}\nYou save: {{savings}}%\n\n🛒 Get it now: {{product_url}}`,
        
        // REVIEW & FEEDBACK
        review_request: `⭐ How was your purchase?\n\nHi {{customer_name}}, how do you like your {{product_name}}?\n\nShare your experience and get 10% off your next order!\n\n✍️ Leave a review: {{review_url}}\n\nYour feedback helps us improve!`,
        
        review_reminder: `🌟 We'd love your feedback!\n\n{{customer_name}}, don't forget to review your recent purchase!\n\nLeave a review and get 15% OFF your next order.\n\n{{review_url}}`,
        
        // PROMOTIONAL
        flash_sale: `⚡ FLASH SALE - {{hours}} Hours Only!\n\nHi {{customer_name}}, exclusive offer for you!\n\n{{discount}}% OFF everything!\nCode: {{promo_code}}\n\nShop now: {{shop_url}}\n\nEnds at {{end_time}}!`,
        
        exclusive_offer: `🎁 Exclusive Offer for You!\n\n{{customer_name}}, as a valued customer, enjoy:\n\n{{offer_details}}\n\nUse code: {{promo_code}}\nValid until: {{expiry_date}}\n\n{{shop_url}}`,
        
        // SUPPORT
        support_ticket_created: `🎫 Support Ticket #{{ticket_number}}\n\nHi {{customer_name}}, we've received your inquiry.\n\nSubject: {{subject}}\n\nOur team will respond within {{response_time}}.\n\nNeed urgent help? Call {{support_phone}}`,
        
        support_ticket_resolved: `✅ Ticket Resolved\n\n{{customer_name}}, your support ticket #{{ticket_number}} has been resolved.\n\nIf you need further assistance, just reply to this message.\n\nRate our support: {{feedback_url}}`
      },
      
      // Arabic templates
      ar: {
        order_placed: `🎉 تم تأكيد الطلب!\n\nشكراً لك {{customer_name}}!\n\nرقم الطلب #{{order_number}}\nالإجمالي: {{currency}} {{total_price}}\n\nالتوصيل إلى:\n{{shipping_address}}\n\nتتبع طلبك: {{order_status_url}}`,
        // ... add more Arabic translations
      },
      
      // Spanish templates  
      es: {
        order_placed: `🎉 ¡Pedido Confirmado!\n\n¡Gracias {{customer_name}}!\n\nPedido #{{order_number}}\nTotal: {{currency}} {{total_price}}\n\nEntrega a:\n{{shipping_address}}\n\nRastrear pedido: {{order_status_url}}`,
        // ... add more Spanish translations
      }
    };
  }

  // Main notification sender
  async sendNotification(shopDomain, customerPhone, notificationType, data, language = 'en') {
    try {
      // Validate shop domain exists
      if (!shopDomain) {
        console.error('❌ Shop domain is required for notifications');
        return null;
      }

      const shop = await this.getShop(shopDomain);
      if (!shop) {
        console.error(`❌ Shop not found: ${shopDomain}`);
        return null;
      }

      // Check if customer exists, create if not
      let customer = await this.getCustomer(shopDomain, customerPhone);
      if (!customer) {
        console.log(`📝 Creating new customer: ${customerPhone}`);
        await this.createCustomer(shopDomain, customerPhone, data.customer_name);
        customer = await this.getCustomer(shopDomain, customerPhone);
      }

      // Check if customer has opted in
      if (customer && !customer.opted_in) {
        console.log(`⚠️ Customer ${customerPhone} has opted out`);
        return null;
      }

      // Get template
      const template = this.templates[language]?.[notificationType];
      if (!template) {
        console.error(`❌ Template not found: ${notificationType} in ${language}`);
        return null;
      }

      // Replace variables in template
      let message = this.replaceVariables(template, data);

      // Check if Twilio is configured
      if (!twilioClient) {
        console.warn(`⚠️ Twilio not configured. Would send message to ${customerPhone}: ${message.substring(0, 100)}...`);
        return {
          sid: 'mock_' + Date.now(),
          status: 'mock',
          to: `whatsapp:${customerPhone}`,
          body: message
        };
      }

      // Ensure proper WhatsApp format for both numbers
      const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER.startsWith('whatsapp:') 
        ? process.env.TWILIO_WHATSAPP_NUMBER 
        : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
        
      const toNumber = customerPhone.startsWith('whatsapp:') 
        ? customerPhone 
        : `whatsapp:${customerPhone}`;

      console.log('📱 NotificationManager sending from:', fromNumber, 'to:', toNumber);

      // Send WhatsApp message
      const result = await twilioClient.messages.create({
        from: fromNumber,
        to: toNumber,
        body: message
      });

      // Track in database
      await DatabaseQueries.saveMessage({
        shop_domain: shopDomain,
        customer_phone: customerPhone,
        customer_name: data.customer_name || null,
        message_type: notificationType,
        message_body: message,
        twilio_sid: result.sid,
        twilio_status: result.status,
        cost: this.calculateCost(notificationType)
      });

      // Update customer interaction
      await this.updateCustomerInteraction(shopDomain, customerPhone);

      console.log(`✅ ${notificationType} notification sent to ${customerPhone}`);
      return result;

    } catch (error) {
      console.error(`❌ Failed to send ${notificationType}:`, error);
      throw error;
    }
  }

  // Replace template variables
  replaceVariables(template, data) {
    let message = template;
    
    // Handle special variables
    if (data.items && Array.isArray(data.items)) {
      data.items = data.items.map(item => `• ${item.name} (${item.quantity}x) - ${data.currency} ${item.price}`).join('\n');
    }
    
    if (data.shipping_address && typeof data.shipping_address === 'object') {
      data.shipping_address = `${data.shipping_address.name}\n${data.shipping_address.address1}\n${data.shipping_address.city}, ${data.shipping_address.country}`;
    }

    // Replace all variables
    Object.keys(data).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      message = message.replace(regex, data[key] || '');
    });

    return message;
  }

  // Calculate message cost
  calculateCost(notificationType) {
    const marketingTypes = ['flash_sale', 'exclusive_offer', 'price_drop'];
    if (marketingTypes.includes(notificationType)) {
      return 0.05; // Marketing message cost
    }
    return 0.02; // Utility message cost
  }

  // Get customer from database
  async getCustomer(shopDomain, customerPhone) {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM customers WHERE shop_domain = ? AND customer_phone = ?',
        [shopDomain, customerPhone],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  // Get shop from database
  async getShop(shopDomain) {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM shops WHERE shop_domain = ?',
        [shopDomain],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  // Create customer in database
  async createCustomer(shopDomain, customerPhone, customerName) {
    return new Promise((resolve, reject) => {
      // Split customer name into first_name and last_name to match database schema
      const names = (customerName || '').split(' ');
      const firstName = names[0] || null;
      const lastName = names.slice(1).join(' ') || null;
      
      db.run(
        `INSERT OR IGNORE INTO customers (
          shop_domain, customer_phone, first_name, last_name, opted_in, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [shopDomain, customerPhone, firstName, lastName],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  // Update customer interaction
  async updateCustomerInteraction(shopDomain, customerPhone) {
    return new Promise((resolve, reject) => {
      db.run(
        'UPDATE customers SET last_interaction = CURRENT_TIMESTAMP WHERE shop_domain = ? AND customer_phone = ?',
        [shopDomain, customerPhone],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // Send custom message (for manual messages from dashboard)
  async sendCustomMessage(shopDomain, customerPhone, messageBody, orderNumber = null) {
    try {
      // Check if Twilio is configured
      if (!twilioClient) {
        console.warn(`⚠️ Twilio not configured. Would send custom message to ${customerPhone}`);
        return {
          success: false,
          error: 'Twilio not configured'
        };
      }

      // Ensure proper WhatsApp format for both numbers
      const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER.startsWith('whatsapp:') 
        ? process.env.TWILIO_WHATSAPP_NUMBER 
        : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
        
      const toNumber = customerPhone.startsWith('whatsapp:') 
        ? customerPhone 
        : `whatsapp:${customerPhone}`;

      console.log('📱 Sending custom message from:', fromNumber, 'to:', toNumber);

      // Send WhatsApp message
      const result = await twilioClient.messages.create({
        from: fromNumber,
        to: toNumber,
        body: messageBody
      });

      // Save to database
      await DatabaseQueries.createMessage(
        shopDomain,
        customerPhone.replace('whatsapp:', ''),
        messageBody,
        'outbound',
        orderNumber,
        result.sid
      );

      return {
        success: true,
        messageSid: result.sid,
        phone: customerPhone
      };

    } catch (error) {
      console.error(`❌ Failed to send custom message:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Batch send notifications
  async sendBatchNotifications(shopDomain, notifications) {
    const results = {
      sent: 0,
      failed: 0,
      errors: []
    };

    for (const notification of notifications) {
      try {
        await this.sendNotification(
          shopDomain,
          notification.customerPhone,
          notification.type,
          notification.data,
          notification.language || 'en'
        );
        results.sent++;
        
        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        results.failed++;
        results.errors.push({
          phone: notification.customerPhone,
          error: error.message
        });
      }
    }

    return results;
  }
}

module.exports = new NotificationManager();
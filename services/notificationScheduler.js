// services/notificationScheduler.js
const NotificationManager = require('./notificationManager');
const DatabaseQueries = require('../database/queries');
const { db } = require('../database');

class NotificationScheduler {
  constructor() {
    this.scheduledJobs = new Map();
    this.initializeSchedulers();
  }

  initializeSchedulers() {
    // Check for abandoned carts every 30 minutes
    setInterval(() => this.checkAbandonedCarts(), 30 * 60 * 1000);
    
    // Check for review requests daily
    setInterval(() => this.checkReviewRequests(), 24 * 60 * 60 * 1000);
    
    // Check for scheduled campaigns every 5 minutes
    setInterval(() => this.checkScheduledCampaigns(), 5 * 60 * 1000);
    
    console.log('✅ Notification schedulers initialized');
  }

  // Abandoned Cart Reminders (3-step sequence)
  async checkAbandonedCarts() {
    console.log('🔍 Checking for abandoned carts...');
    
    const shops = await this.getAllActiveShops();
    
    for (const shop of shops) {
      // 1-hour reminder
      const oneHourCarts = await this.getAbandonedCarts(shop.shop_domain, 1, 0);
      for (const cart of oneHourCarts) {
        await this.sendAbandonedCartReminder(shop.shop_domain, cart, 'abandoned_cart_1h', 1);
      }
      
      // 24-hour reminder with discount
      const oneDayCarts = await this.getAbandonedCarts(shop.shop_domain, 24, 1);
      for (const cart of oneDayCarts) {
        await this.sendAbandonedCartReminder(shop.shop_domain, cart, 'abandoned_cart_24h', 2);
      }
      
      // 48-hour final reminder with bigger discount
      const twoDayCarts = await this.getAbandonedCarts(shop.shop_domain, 48, 2);
      for (const cart of twoDayCarts) {
        await this.sendAbandonedCartReminder(shop.shop_domain, cart, 'abandoned_cart_final', 3);
      }
    }
  }

  async sendAbandonedCartReminder(shopDomain, cart, templateType, reminderNumber) {
    try {
      const items = JSON.parse(cart.line_items || '[]');
      
      await NotificationManager.sendNotification(
        shopDomain,
        cart.customer_phone,
        templateType,
        {
          customer_name: cart.customer_name || 'there',
          items: items,
          currency: cart.currency,
          total_price: cart.cart_value,
          checkout_url: cart.checkout_url,
          shop_name: shopDomain.replace('.myshopify.com', '')
        }
      );
      
      // Update reminder count
      await this.updateReminderCount(cart.id, reminderNumber);
      
    } catch (error) {
      console.error('Error sending abandoned cart reminder:', error);
    }
  }

  // Review Requests (3 days after delivery)
  async checkReviewRequests() {
    console.log('🔍 Checking for review requests...');
    
    const ordersForReview = await this.getOrdersForReview();
    
    for (const order of ordersForReview) {
      await NotificationManager.sendNotification(
        order.shop_domain,
        order.customer_phone,
        'review_request',
        {
          customer_name: order.customer_name,
          product_name: order.main_product,
          order_number: order.order_number,
          review_url: `${order.shop_url}/reviews/new?order=${order.order_id}`
        }
      );
      
      // Mark review as requested
      await this.markReviewRequested(order.id);
    }
  }

  // Database queries
  async getAbandonedCarts(shopDomain, hoursOld, reminderCount) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM abandoned_carts 
         WHERE shop_domain = ? 
         AND recovered = 0 
         AND reminder_count = ?
         AND created_at < datetime('now', '-' || ? || ' hours')
         AND created_at > datetime('now', '-' || ? || ' hours')
         AND customer_phone IS NOT NULL`,
        [shopDomain, reminderCount, hoursOld, hoursOld + 1],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  async updateReminderCount(cartId, count) {
    return new Promise((resolve, reject) => {
      db.run(
        'UPDATE abandoned_carts SET reminder_count = ?, last_reminder_at = CURRENT_TIMESTAMP WHERE id = ?',
        [count, cartId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async getOrdersForReview() {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM orders 
         WHERE delivered_sent = 1 
         AND review_requested = 0
         AND updated_at < datetime('now', '-3 days')
         AND customer_phone IS NOT NULL`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  async markReviewRequested(orderId) {
    return new Promise((resolve, reject) => {
      db.run(
        'UPDATE orders SET review_requested = 1 WHERE id = ?',
        [orderId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async getAllActiveShops() {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM shops WHERE is_active = 1',
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }
}

module.exports = new NotificationScheduler();
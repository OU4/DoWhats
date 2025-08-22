// database/queries.js
const { db } = require('./index');

class DatabaseQueries {
  // ========== SHOP OPERATIONS ==========

  // Additional database queries needed

static saveOrder(orderData) {
  return new Promise((resolve, reject) => {
    const query = `
      INSERT OR REPLACE INTO orders (
        shop_domain, order_id, order_number, customer_email,
        customer_phone, customer_name, total_price, currency,
        financial_status, fulfillment_status, checkout_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    db.run(query, [
      orderData.shop_domain,
      orderData.order_id,
      orderData.order_number,
      orderData.customer_email,
      orderData.customer_phone,
      orderData.customer_name,
      orderData.total_price,
      orderData.currency,
      orderData.financial_status,
      orderData.fulfillment_status,
      orderData.checkout_id
    ], function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });
  });
}

static getOrder(orderId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM orders WHERE order_id = ?',
      [orderId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

static updateOrderStatus(orderId, status, financialStatus) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE orders 
       SET fulfillment_status = ?, financial_status = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE order_id = ?`,
      [status, financialStatus, orderId],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

static updateOrderShipping(orderId, shipped) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE orders 
       SET shipping_sent = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE order_id = ?`,
      [shipped ? 1 : 0, orderId],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

static updateOrderDelivered(orderId) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE orders 
       SET delivered_sent = 1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [orderId],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

static updateOrderRefund(orderId, refundAmount) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE orders 
       SET financial_status = 'refunded', refund_amount = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [refundAmount, orderId],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

static deleteAbandonedCart(checkoutId) {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM abandoned_carts WHERE checkout_id = ?',
      [checkoutId],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

static updateAbandonedCart(checkoutId, data) {
  return new Promise((resolve, reject) => {
    const updates = [];
    const values = [];
    
    Object.keys(data).forEach(key => {
      updates.push(`${key} = ?`);
      values.push(data[key]);
    });
    
    values.push(checkoutId);
    
    db.run(
      `UPDATE abandoned_carts SET ${updates.join(', ')} WHERE checkout_id = ?`,
      values,
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

static checkVariantWasOutOfStock(variantId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT inventory_quantity FROM product_variants WHERE variant_id = ?',
      [variantId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row?.inventory_quantity === 0);
      }
    );
  });
}

static getBackInStockSubscribers(variantId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM back_in_stock_subscriptions 
       WHERE variant_id = ? AND notified = 0`,
      [variantId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

static removeBackInStockSubscriber(id) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE back_in_stock_subscriptions SET notified = 1 WHERE id = ?',
      [id],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

static updateVariantStock(variantId, quantity) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO product_variants (variant_id, inventory_quantity, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [variantId, quantity],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

static deactivateShop(shopDomain) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE shops SET is_active = 0 WHERE shop_domain = ?',
      [shopDomain],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

static checkNewVIPStatus(customerId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT vip_status FROM customers WHERE id = ?',
      [customerId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row?.vip_status === 0);
      }
    );
  });
}

static updateVIPStatus(customerId, status) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE customers SET vip_status = ? WHERE id = ?',
      [status ? 1 : 0, customerId],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Add this to database/queries.js

static updateOrder(orderId, updates) {
  return new Promise((resolve, reject) => {
    const fields = [];
    const values = [];
    
    // Build dynamic UPDATE query
    Object.keys(updates).forEach(key => {
      if (key !== 'order_id') {
        fields.push(`${key} = ?`);
        values.push(updates[key]);
      }
    });
    
    // Add order_id at the end for WHERE clause
    values.push(orderId);
    
    const query = `UPDATE orders SET ${fields.join(', ')} WHERE order_id = ?`;
    
    db.run(query, values, function(err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

static updateCustomer(customerData) {
  return new Promise((resolve, reject) => {
    const query = `
      UPDATE customers 
      SET customer_email = ?, 
          first_name = ?, 
          last_name = ?,
          total_spent = ?,
          total_orders = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE shop_domain = ? AND customer_phone = ?
    `;
    
    db.run(query, [
      customerData.customer_email,
      customerData.first_name,
      customerData.last_name,
      customerData.total_spent || 0,
      customerData.orders_count || 0,
      customerData.shop_domain,
      customerData.customer_phone
    ], function(err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

static trackCartCreated(cartData) {
  return new Promise((resolve, reject) => {
    // You might want to create a separate cart_tracking table
    // For now, we can use the abandoned_carts table
    const query = `
      INSERT OR IGNORE INTO abandoned_carts (
        shop_domain, checkout_id, customer_email, customer_phone, created_at
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;
    
    db.run(query, [
      cartData.shop_domain,
      cartData.cart_id,
      cartData.customer_email,
      cartData.customer_phone
    ], function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });
  });
}

static updateCartTracking(cartId, updates) {
  return new Promise((resolve, reject) => {
    const query = `
      UPDATE abandoned_carts 
      SET items_count = ?, cart_value = ?, updated_at = ? 
      WHERE checkout_id = ?
    `;
    
    db.run(query, [
      updates.items_count,
      updates.total_value,
      updates.updated_at,
      cartId
    ], function(err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

static disableCustomer(customerId) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE customers SET opted_in = 0, opt_out_date = CURRENT_TIMESTAMP WHERE id = ?',
      [customerId],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}
  
  static createOrUpdateShop(shopDomain, accessToken, shopData = {}) {
    return new Promise((resolve, reject) => {
      // First, let's try INSERT OR REPLACE which is more reliable in SQLite
      const query = `
        INSERT OR REPLACE INTO shops (
          shop_domain, 
          access_token, 
          shop_name, 
          email, 
          phone,
          is_active,
          plan,
          monthly_message_count,
          message_limit,
          total_revenue_generated,
          created_at,
          updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, 1, 'free', 0, 50, 0,
          COALESCE((SELECT created_at FROM shops WHERE shop_domain = ?), CURRENT_TIMESTAMP),
          CURRENT_TIMESTAMP
        )
      `;
      
      console.log('💾 Executing shop upsert query for:', shopDomain);
      db.run(query, [
        shopDomain,
        accessToken,
        shopData.shop_name || null,
        shopData.email || null,
        shopData.phone || null,
        shopDomain  // For the COALESCE subquery
      ], function(err) {
        if (err) {
          console.error('❌ Database error in createOrUpdateShop:', err);
          reject(err);
        } else {
          console.log(`✅ Shop saved successfully: ${shopDomain} (lastID: ${this.lastID}, changes: ${this.changes})`);
          resolve(this.lastID || this.changes);
        }
      });
    });
  }

  static getShop(shopDomain) {
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

  static updateShopPlan(shopDomain, plan, messageLimit) {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE shops 
         SET plan = ?, message_limit = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE shop_domain = ?`,
        [plan, messageLimit, shopDomain],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // ========== MESSAGE OPERATIONS ==========
  
  static saveMessage(messageData) {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT INTO messages (
          shop_domain, customer_phone, customer_name, message_type,
          message_body, twilio_sid, twilio_status, direction, cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      
      db.run(query, [
        messageData.shop_domain,
        messageData.customer_phone,
        messageData.customer_name || null,
        messageData.message_type,
        messageData.message_body,
        messageData.twilio_sid || null,
        messageData.twilio_status || 'pending',
        messageData.direction || 'outbound',
        messageData.cost || 0
      ], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  }

  static updateMessageStatus(twilioSid, status, deliveredAt = null) {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE messages 
         SET twilio_status = ?, delivered_at = ? 
         WHERE twilio_sid = ?`,
        [status, deliveredAt, twilioSid],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  static getMessageStats(shopDomain, days = 30) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT 
          COUNT(*) as total_messages,
          COUNT(DISTINCT customer_phone) as unique_customers,
          SUM(CASE WHEN twilio_status = 'delivered' THEN 1 ELSE 0 END) as delivered,
          SUM(CASE WHEN twilio_status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN message_type = 'abandoned_cart' THEN 1 ELSE 0 END) as cart_messages,
          SUM(CASE WHEN message_type = 'order_confirmation' THEN 1 ELSE 0 END) as order_messages,
          SUM(cost) as total_cost
        FROM messages
        WHERE shop_domain = ?
        AND created_at > datetime('now', '-' || ? || ' days')
      `;
      
      db.get(query, [shopDomain, days], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  // ========== ABANDONED CART OPERATIONS ==========
  
  static saveAbandonedCart(cartData) {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT OR REPLACE INTO abandoned_carts (
          shop_domain, checkout_id, checkout_token, customer_email,
          customer_phone, customer_name, cart_value, currency,
          items_count, line_items, checkout_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      
      db.run(query, [
        cartData.shop_domain,
        cartData.checkout_id,
        cartData.checkout_token || null,
        cartData.customer_email || null,
        cartData.customer_phone || null,
        cartData.customer_name || null,
        cartData.cart_value || 0,
        cartData.currency || 'USD',
        cartData.items_count || 0,
        JSON.stringify(cartData.line_items || []),
        cartData.checkout_url || null
      ], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  }

  static getAbandonedCarts(shopDomain, hoursOld = 1) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT * FROM abandoned_carts
        WHERE shop_domain = ?
        AND recovered = 0
        AND reminder_count < 3
        AND created_at < datetime('now', '-' || ? || ' hours')
        AND customer_phone IS NOT NULL
      `;
      
      db.all(query, [shopDomain, hoursOld], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  static markCartRecovered(checkoutId, recoveryValue) {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE abandoned_carts 
         SET recovered = 1, recovered_at = CURRENT_TIMESTAMP, recovery_value = ? 
         WHERE checkout_id = ?`,
        [recoveryValue, checkoutId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  static incrementReminderCount(cartId) {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE abandoned_carts 
         SET reminder_count = reminder_count + 1, last_reminder_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [cartId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // ========== CUSTOMER OPERATIONS ==========
  
  static createOrUpdateCustomer(customerData) {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT INTO customers (
          shop_domain, customer_phone, customer_email, first_name, last_name
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(shop_domain, customer_phone) 
        DO UPDATE SET 
          customer_email = ?,
          first_name = ?,
          last_name = ?,
          last_interaction = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      `;
      
      db.run(query, [
        customerData.shop_domain,
        customerData.customer_phone,
        customerData.customer_email || null,
        customerData.first_name || null,
        customerData.last_name || null,
        customerData.customer_email || null,
        customerData.first_name || null,
        customerData.last_name || null
      ], function(err) {
        if (err) reject(err);
        else resolve(this.lastID || this.changes);
      });
    });
  }

  static updateCustomerOptOut(shopDomain, customerPhone) {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE customers 
         SET opted_in = 0, opt_out_date = CURRENT_TIMESTAMP 
         WHERE shop_domain = ? AND customer_phone = ?`,
        [shopDomain, customerPhone],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  static getCustomerSegments(shopDomain) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT 
          COUNT(CASE WHEN total_spent > 500 THEN 1 END) as vip_customers,
          COUNT(CASE WHEN total_orders >= 2 THEN 1 END) as repeat_customers,
          COUNT(CASE WHEN total_orders = 1 THEN 1 END) as one_time_customers,
          COUNT(CASE WHEN last_order_date < datetime('now', '-60 days') THEN 1 END) as at_risk,
          COUNT(*) as total_customers
        FROM customers
        WHERE shop_domain = ?
      `;
      
      db.get(query, [shopDomain], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  // ========== ANALYTICS OPERATIONS ==========
  
  static updateDailyAnalytics(shopDomain, date, metrics) {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT INTO analytics (
          shop_domain, date, messages_sent, messages_delivered,
          carts_abandoned, carts_recovered, revenue_generated, total_cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(shop_domain, date) 
        DO UPDATE SET 
          messages_sent = messages_sent + ?,
          messages_delivered = messages_delivered + ?,
          carts_abandoned = carts_abandoned + ?,
          carts_recovered = carts_recovered + ?,
          revenue_generated = revenue_generated + ?,
          total_cost = total_cost + ?
      `;
      
      db.run(query, [
        shopDomain,
        date,
        metrics.messages_sent || 0,
        metrics.messages_delivered || 0,
        metrics.carts_abandoned || 0,
        metrics.carts_recovered || 0,
        metrics.revenue_generated || 0,
        metrics.total_cost || 0,
        metrics.messages_sent || 0,
        metrics.messages_delivered || 0,
        metrics.carts_abandoned || 0,
        metrics.carts_recovered || 0,
        metrics.revenue_generated || 0,
        metrics.total_cost || 0
      ], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  static getAnalyticsSummary(shopDomain, days = 30) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT 
          SUM(messages_sent) as total_messages,
          SUM(messages_delivered) as total_delivered,
          SUM(carts_abandoned) as total_abandoned,
          SUM(carts_recovered) as total_recovered,
          SUM(revenue_generated) as total_revenue,
          SUM(total_cost) as total_cost,
          AVG(CASE WHEN carts_abandoned > 0 
              THEN (carts_recovered * 100.0 / carts_abandoned) 
              ELSE 0 END) as avg_recovery_rate
        FROM analytics
        WHERE shop_domain = ?
        AND date > date('now', '-' || ? || ' days')
      `;
      
      db.get(query, [shopDomain, days], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  // ========== CAMPAIGN OPERATIONS ==========
  
  static createCampaign(campaignData) {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT INTO campaigns (
          shop_domain, campaign_name, campaign_type, message_template,
          target_audience, scheduled_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      
      db.run(query, [
        campaignData.shop_domain,
        campaignData.campaign_name,
        campaignData.campaign_type || 'manual',
        campaignData.message_template,
        campaignData.target_audience || 'all',
        campaignData.scheduled_at || null,
        campaignData.status || 'draft'
      ], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  }

  static updateCampaignStats(campaignId, stats) {
    return new Promise((resolve, reject) => {
      const query = `
        UPDATE campaigns 
        SET sent_count = ?, delivered_count = ?, response_count = ?,
            revenue_generated = ?, status = ?
        WHERE id = ?
      `;
      
      db.run(query, [
        stats.sent_count || 0,
        stats.delivered_count || 0,
        stats.response_count || 0,
        stats.revenue_generated || 0,
        stats.status || 'completed',
        campaignId
      ], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ========== UNINSTALL CLEANUP METHODS ==========

  static deleteShop(shopDomain) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM shops WHERE shop_domain = ?',
        [shopDomain],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`🗑️ Deleted shop: ${shopDomain} (${this.changes} rows affected)`);
            resolve(this.changes);
          }
        }
      );
    });
  }

  static deleteShopOrders(shopDomain) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM orders WHERE shop_domain = ?',
        [shopDomain],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`🗑️ Deleted orders for shop: ${shopDomain} (${this.changes} rows affected)`);
            resolve(this.changes);
          }
        }
      );
    });
  }

  static deleteShopCustomers(shopDomain) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM customers WHERE shop_domain = ?',
        [shopDomain],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`🗑️ Deleted customers for shop: ${shopDomain} (${this.changes} rows affected)`);
            resolve(this.changes);
          }
        }
      );
    });
  }

  static deleteShopMessages(shopDomain) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM messages WHERE shop_domain = ?',
        [shopDomain],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`🗑️ Deleted messages for shop: ${shopDomain} (${this.changes} rows affected)`);
            resolve(this.changes);
          }
        }
      );
    });
  }

  static deleteShopAbandonedCarts(shopDomain) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM abandoned_carts WHERE shop_domain = ?',
        [shopDomain],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`🗑️ Deleted abandoned carts for shop: ${shopDomain} (${this.changes} rows affected)`);
            resolve(this.changes);
          }
        }
      );
    });
  }

  static deleteShopAnalytics(shopDomain) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM analytics WHERE shop_domain = ?',
        [shopDomain],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`🗑️ Deleted analytics for shop: ${shopDomain} (${this.changes} rows affected)`);
            resolve(this.changes);
          }
        }
      );
    });
  }

  static deleteShopCampaigns(shopDomain) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM campaigns WHERE shop_domain = ?',
        [shopDomain],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`🗑️ Deleted campaigns for shop: ${shopDomain} (${this.changes} rows affected)`);
            resolve(this.changes);
          }
        }
      );
    });
  }

  static deleteShopBackInStockSubscriptions(shopDomain) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM back_in_stock_subscriptions WHERE shop_domain = ?',
        [shopDomain],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`🗑️ Deleted back in stock subscriptions for shop: ${shopDomain} (${this.changes} rows affected)`);
            resolve(this.changes);
          }
        }
      );
    });
  }

  static deleteShopProductVariants(shopDomain) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM product_variants WHERE shop_domain = ?',
        [shopDomain],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`🗑️ Deleted product variants for shop: ${shopDomain} (${this.changes} rows affected)`);
            resolve(this.changes);
          }
        }
      );
    });
  }

  static deleteShopTemplates(shopDomain) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM templates WHERE shop_domain = ?',
        [shopDomain],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`🗑️ Deleted templates for shop: ${shopDomain} (${this.changes} rows affected)`);
            resolve(this.changes);
          }
        }
      );
    });
  }

  static deleteShopAutomations(shopDomain) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM automations WHERE shop_domain = ?',
        [shopDomain],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`🗑️ Deleted automations for shop: ${shopDomain} (${this.changes} rows affected)`);
            resolve(this.changes);
          }
        }
      );
    });
  }

  static deleteShopWebhooks(shopDomain) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM webhooks WHERE shop_domain = ?',
        [shopDomain],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`🗑️ Deleted webhooks for shop: ${shopDomain} (${this.changes} rows affected)`);
            resolve(this.changes);
          }
        }
      );
    });
  }

  static deleteShopBilling(shopDomain) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM billing WHERE shop_domain = ?',
        [shopDomain],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`🗑️ Deleted billing records for shop: ${shopDomain} (${this.changes} rows affected)`);
            resolve(this.changes);
          }
        }
      );
    });
  }

  static deleteShopConversations(shopDomain) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM conversations WHERE shop_domain = ?',
        [shopDomain],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`🗑️ Deleted conversations for shop: ${shopDomain} (${this.changes} rows affected)`);
            resolve(this.changes);
          }
        }
      );
    });
  }

  // COMPLETE DATABASE WIPE METHODS (for testing)
  
  static wipeAllData() {
    return new Promise((resolve, reject) => {
      console.log('🔥 WIPING ALL DATABASE DATA - THIS IS DESTRUCTIVE!');
      
      const tables = [
        'messages', 'orders', 'customers', 'abandoned_carts', 'analytics',
        'campaigns', 'templates', 'automations', 'webhooks', 'billing',
        'conversations', 'shops'
      ];
      
      const results = {};
      let completedTables = 0;
      
      tables.forEach(table => {
        db.run(`DELETE FROM ${table}`, function(err) {
          if (err) {
            console.error(`❌ Failed to wipe table ${table}:`, err.message);
            results[table] = { success: false, error: err.message };
          } else {
            console.log(`🗑️ Wiped table ${table} (${this.changes} rows deleted)`);
            results[table] = { success: true, rowsDeleted: this.changes };
          }
          
          completedTables++;
          if (completedTables === tables.length) {
            resolve(results);
          }
        });
      });
    });
  }

  static resetAutoIncrement() {
    return new Promise((resolve, reject) => {
      console.log('🔄 Resetting auto increment counters...');
      
      const tables = [
        'shops', 'messages', 'orders', 'customers', 'abandoned_carts',
        'analytics', 'campaigns', 'templates', 'automations', 'webhooks',
        'billing', 'conversations'
      ];
      
      let completedTables = 0;
      
      tables.forEach(table => {
        db.run(`DELETE FROM sqlite_sequence WHERE name='${table}'`, function(err) {
          if (err) {
            console.log(`⚠️ Could not reset auto increment for ${table}: ${err.message}`);
          } else {
            console.log(`✅ Reset auto increment for ${table}`);
          }
          
          completedTables++;
          if (completedTables === tables.length) {
            resolve();
          }
        });
      });
    });
  }

  static getDatabaseStats() {
    return new Promise((resolve, reject) => {
      const tables = [
        'shops', 'messages', 'orders', 'customers', 'abandoned_carts',
        'analytics', 'campaigns', 'templates', 'automations', 'webhooks',
        'billing', 'conversations'
      ];
      
      const stats = {};
      let completedTables = 0;
      
      tables.forEach(table => {
        db.get(`SELECT COUNT(*) as count FROM ${table}`, (err, row) => {
          if (err) {
            stats[table] = { error: err.message };
          } else {
            stats[table] = { count: row.count };
          }
          
          completedTables++;
          if (completedTables === tables.length) {
            resolve(stats);
          }
        });
      });
    });
  }
}



module.exports = DatabaseQueries;
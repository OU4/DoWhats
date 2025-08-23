// database/index.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Create database directory if it doesn't exist
const dbDir = path.join(__dirname, '../data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Create or open database
const dbPath = path.join(dbDir, 'whatsapp_shopify.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Error opening database:', err);
  }
});

// Enable foreign keys
db.run('PRAGMA foreign_keys = ON');

// Initialize all tables (only if needed)
function initializeDatabase() {
  return new Promise((resolve, reject) => {
    // Check if all required tables exist
    db.all(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name IN ('shops', 'automation_settings', 'whatsapp_flows')
    `, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      
      // Get list of existing tables
      const existingTables = rows.map(row => row.name);
      const requiredTables = ['shops', 'automation_settings', 'whatsapp_flows'];
      const missingTables = requiredTables.filter(table => !existingTables.includes(table));
      
      // If all tables exist, skip initialization
      if (missingTables.length === 0) {
        console.log('✅ All database tables already exist');
        resolve();
        return;
      }
      
      console.log('🔄 Creating missing tables:', missingTables.join(', '));
      
      // Only initialize if tables don't exist
      const initStart = Date.now();
      db.serialize(() => {
      
      // 1. SHOPS TABLE - Stores Shopify store information
      db.run(`
        CREATE TABLE IF NOT EXISTS shops (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_domain TEXT UNIQUE NOT NULL,
          access_token TEXT NOT NULL,
          shop_name TEXT,
          email TEXT,
          phone TEXT,
          plan TEXT DEFAULT 'free',
          is_active BOOLEAN DEFAULT 1,
          monthly_message_count INTEGER DEFAULT 0,
          message_limit INTEGER DEFAULT 50,
          total_revenue_generated REAL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) console.error('Error creating shops table:', err);
        // Table created silently
      });

      // 2. MESSAGES TABLE - Tracks all WhatsApp messages
      db.run(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_domain TEXT NOT NULL,
          customer_phone TEXT NOT NULL,
          customer_name TEXT,
          message_type TEXT NOT NULL,
          message_body TEXT,
          twilio_sid TEXT UNIQUE,
          twilio_status TEXT DEFAULT 'pending',
          direction TEXT DEFAULT 'outbound',
          cost REAL DEFAULT 0,
          error_message TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          delivered_at DATETIME,
          read_at DATETIME,
          FOREIGN KEY (shop_domain) REFERENCES shops(shop_domain) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) console.error('Error creating messages table:', err);
        // Table created
      });

      // 3. ABANDONED CARTS TABLE
      db.run(`
        CREATE TABLE IF NOT EXISTS abandoned_carts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_domain TEXT NOT NULL,
          checkout_id TEXT UNIQUE NOT NULL,
          checkout_token TEXT,
          customer_email TEXT,
          customer_phone TEXT,
          customer_name TEXT,
          cart_value REAL DEFAULT 0,
          currency TEXT DEFAULT 'USD',
          items_count INTEGER DEFAULT 0,
          line_items TEXT,
          checkout_url TEXT,
          reminder_count INTEGER DEFAULT 0,
          last_reminder_at DATETIME,
          recovered BOOLEAN DEFAULT 0,
          recovered_at DATETIME,
          recovery_value REAL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (shop_domain) REFERENCES shops(shop_domain) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) console.error('Error creating abandoned_carts table:', err);
        
      });

      // 4. ORDERS TABLE - Track orders and their WhatsApp notifications
      db.run(`
        CREATE TABLE IF NOT EXISTS orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_domain TEXT NOT NULL,
          order_id TEXT UNIQUE NOT NULL,
          order_number TEXT,
          customer_email TEXT,
          customer_phone TEXT,
          customer_name TEXT,
          total_price REAL,
          currency TEXT,
          financial_status TEXT,
          fulfillment_status TEXT,
          confirmation_sent BOOLEAN DEFAULT 0,
          shipping_sent BOOLEAN DEFAULT 0,
          delivered_sent BOOLEAN DEFAULT 0,
          review_requested BOOLEAN DEFAULT 0,
          checkout_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (shop_domain) REFERENCES shops(shop_domain) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) console.error('Error creating orders table:', err);
        
      });

      // 5. CUSTOMERS TABLE - Customer preferences and history
      db.run(`
        CREATE TABLE IF NOT EXISTS customers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_domain TEXT NOT NULL,
          customer_phone TEXT NOT NULL,
          customer_email TEXT,
          first_name TEXT,
          last_name TEXT,
          opted_in BOOLEAN DEFAULT 1,
          opt_in_date DATETIME DEFAULT CURRENT_TIMESTAMP,
          opt_out_date DATETIME,
          language TEXT DEFAULT 'en',
          timezone TEXT DEFAULT 'UTC',
          total_orders INTEGER DEFAULT 0,
          total_spent REAL DEFAULT 0,
          last_order_date DATETIME,
          last_interaction DATETIME,
          tags TEXT,
          vip_status BOOLEAN DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(shop_domain, customer_phone),
          FOREIGN KEY (shop_domain) REFERENCES shops(shop_domain) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) console.error('Error creating customers table:', err);
        
      });

      // 6. CAMPAIGNS TABLE
      db.run(`
        CREATE TABLE IF NOT EXISTS campaigns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_domain TEXT NOT NULL,
          campaign_name TEXT NOT NULL,
          campaign_type TEXT,
          message_template TEXT,
          target_audience TEXT,
          scheduled_at DATETIME,
          started_at DATETIME,
          completed_at DATETIME,
          status TEXT DEFAULT 'draft',
          total_recipients INTEGER DEFAULT 0,
          sent_count INTEGER DEFAULT 0,
          delivered_count INTEGER DEFAULT 0,
          read_count INTEGER DEFAULT 0,
          response_count INTEGER DEFAULT 0,
          conversion_count INTEGER DEFAULT 0,
          revenue_generated REAL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (shop_domain) REFERENCES shops(shop_domain) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) console.error('Error creating campaigns table:', err);
        
      });

      // 7. TEMPLATES TABLE
      db.run(`
        CREATE TABLE IF NOT EXISTS templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_domain TEXT NOT NULL,
          template_name TEXT NOT NULL,
          template_type TEXT NOT NULL,
          language TEXT DEFAULT 'en',
          content TEXT NOT NULL,
          variables TEXT,
          is_active BOOLEAN DEFAULT 1,
          is_approved BOOLEAN DEFAULT 0,
          usage_count INTEGER DEFAULT 0,
          last_used_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (shop_domain) REFERENCES shops(shop_domain) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) console.error('Error creating templates table:', err);
        
      });

      // 8. AUTOMATIONS TABLE
      db.run(`
        CREATE TABLE IF NOT EXISTS automations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_domain TEXT NOT NULL,
          automation_name TEXT NOT NULL,
          trigger_type TEXT NOT NULL,
          trigger_conditions TEXT,
          actions TEXT,
          is_active BOOLEAN DEFAULT 1,
          execution_count INTEGER DEFAULT 0,
          last_executed_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (shop_domain) REFERENCES shops(shop_domain) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) console.error('Error creating automations table:', err);
        
      });

      // 9. ANALYTICS TABLE - Daily aggregated stats
      db.run(`
        CREATE TABLE IF NOT EXISTS analytics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_domain TEXT NOT NULL,
          date DATE NOT NULL,
          messages_sent INTEGER DEFAULT 0,
          messages_delivered INTEGER DEFAULT 0,
          messages_read INTEGER DEFAULT 0,
          messages_replied INTEGER DEFAULT 0,
          carts_abandoned INTEGER DEFAULT 0,
          carts_recovered INTEGER DEFAULT 0,
          orders_created INTEGER DEFAULT 0,
          revenue_generated REAL DEFAULT 0,
          total_cost REAL DEFAULT 0,
          new_customers INTEGER DEFAULT 0,
          active_customers INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(shop_domain, date),
          FOREIGN KEY (shop_domain) REFERENCES shops(shop_domain) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) console.error('Error creating analytics table:', err);
        
      });

      // 10. WEBHOOKS TABLE - Track webhook deliveries
      db.run(`
        CREATE TABLE IF NOT EXISTS webhooks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_domain TEXT NOT NULL,
          webhook_id TEXT,
          topic TEXT NOT NULL,
          address TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          last_error TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (shop_domain) REFERENCES shops(shop_domain) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) console.error('Error creating webhooks table:', err);
        
      });

      // 11. BILLING TABLE
      db.run(`
        CREATE TABLE IF NOT EXISTS billing (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_domain TEXT NOT NULL,
          charge_id TEXT UNIQUE,
          plan TEXT NOT NULL,
          amount REAL NOT NULL,
          currency TEXT DEFAULT 'USD',
          billing_on DATE,
          status TEXT DEFAULT 'pending',
          trial_ends_on DATE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (shop_domain) REFERENCES shops(shop_domain) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) console.error('Error creating billing table:', err);
        
      });

      // 12. CONVERSATION THREADS TABLE
      db.run(`
        CREATE TABLE IF NOT EXISTS conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_domain TEXT NOT NULL,
          customer_phone TEXT NOT NULL,
          status TEXT DEFAULT 'open',
          assigned_to TEXT,
          last_message_at DATETIME,
          messages_count INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          closed_at DATETIME,
          FOREIGN KEY (shop_domain) REFERENCES shops(shop_domain) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) console.error('Error creating conversations table:', err);
        
      });

      // 13. AUTOMATION SETTINGS TABLE
      db.run(`
        CREATE TABLE IF NOT EXISTS automation_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_domain TEXT UNIQUE NOT NULL,
          abandoned_cart_enabled BOOLEAN DEFAULT 1,
          order_confirmation_enabled BOOLEAN DEFAULT 1,
          shipping_updates_enabled BOOLEAN DEFAULT 1,
          welcome_message_enabled BOOLEAN DEFAULT 1,
          review_request_enabled BOOLEAN DEFAULT 0,
          birthday_messages_enabled BOOLEAN DEFAULT 0,
          back_in_stock_enabled BOOLEAN DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (shop_domain) REFERENCES shops(shop_domain) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) console.error('Error creating automation_settings table:', err);
        
      });

      // 14. WHATSAPP FLOWS TABLE
      db.run(`
        CREATE TABLE IF NOT EXISTS whatsapp_flows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_domain TEXT NOT NULL,
          flow_name TEXT NOT NULL,
          flow_type TEXT NOT NULL,
          flow_example TEXT,
          language TEXT DEFAULT 'en',
          trigger_delay_minutes INTEGER DEFAULT 15,
          message_content TEXT NOT NULL,
          footer_text TEXT,
          discount_code TEXT,
          image_type TEXT DEFAULT 'dynamic',
          image_url TEXT,
          button_text TEXT DEFAULT 'Complete Your Order',
          quick_replies TEXT,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (shop_domain) REFERENCES shops(shop_domain) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) console.error('Error creating whatsapp_flows table:', err);
        
      });

      // Create indexes for better performance
      db.run('CREATE INDEX IF NOT EXISTS idx_messages_shop ON messages(shop_domain)');
      db.run('CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(customer_phone)');
      db.run('CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)');
      db.run('CREATE INDEX IF NOT EXISTS idx_abandoned_carts_shop ON abandoned_carts(shop_domain)');
      db.run('CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_domain)');
      db.run('CREATE INDEX IF NOT EXISTS idx_customers_shop_phone ON customers(shop_domain, customer_phone)');
      db.run('CREATE INDEX IF NOT EXISTS idx_analytics_shop_date ON analytics(shop_domain, date)');

        console.log(`✅ Database initialized (${Date.now() - initStart}ms)`);
        resolve();
      });
    });
  });
}

// Export database and initialization
module.exports = {
  db,
  initializeDatabase
};
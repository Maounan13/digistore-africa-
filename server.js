require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// ─── Data helpers ─────────────────────────────────────────
const PRODUCTS_FILE = path.join(__dirname, 'data/products.json');
const ORDERS_FILE   = path.join(__dirname, 'data/orders.json');

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ─── Email transporter ────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendDeliveryEmail(order, product) {
  const template = fs.readFileSync(
    path.join(__dirname, 'emails/delivery.html'), 'utf8'
  );

  const includesList = product.includes
    .map(item => `<div style="color:#9896C8;font-size:0.82rem;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05)">✅ ${item}</div>`)
    .join('');

  const html = template
    .replace(/{{PRODUCT_EMOJI}}/g,    product.emoji)
    .replace(/{{PRODUCT_CATEGORY}}/g, product.category)
    .replace(/{{PRODUCT_TITLE}}/g,    product.title)
    .replace(/{{PRODUCT_PRICE}}/g,    product.price.toLocaleString('fr-FR'))
    .replace(/{{ORDER_ID}}/g,         order.id)
    .replace(/{{DOWNLOAD_URL}}/g,     product.downloadUrl)
    .replace(/{{INCLUDES_LIST}}/g,    includesList);

  await transporter.sendMail({
    from: `"${process.env.EMAIL_FROM_NAME || 'DigiStore Africa'}" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
    to: order.email,
    subject: `✅ Votre produit : ${product.title}`,
    html,
  });
}

// ─── API ROUTES ───────────────────────────────────────────

// GET all products
app.get('/api/products', (req, res) => {
  const products = readJSON(PRODUCTS_FILE);
  const { category, featured } = req.query;
  let result = products;
  if (category) result = result.filter(p => p.category.toLowerCase().includes(category.toLowerCase()));
  if (featured === 'true') result = result.filter(p => p.featured);
  res.json({ success: true, data: result });
});

// GET single product
app.get('/api/products/:id', (req, res) => {
  const products = readJSON(PRODUCTS_FILE);
  const product = products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ success: false, message: 'Produit introuvable' });
  res.json({ success: true, data: product });
});

// POST initiate payment via CinetPay
app.post('/api/orders/initiate', async (req, res) => {
  const { productId, email, phone, paymentMethod } = req.body;

  if (!productId || !email || !phone) {
    return res.status(400).json({ success: false, message: 'Données manquantes' });
  }

  const products = readJSON(PRODUCTS_FILE);
  const product = products.find(p => p.id === productId);
  if (!product) return res.status(404).json({ success: false, message: 'Produit introuvable' });

  const orderId = 'DS-' + uuidv4().substring(0, 8).toUpperCase();

  // Save order with PENDING status
  const orders = readJSON(ORDERS_FILE);
  const order = {
    id: orderId,
    productId,
    email,
    phone,
    paymentMethod: paymentMethod || 'cinetpay',
    amount: product.price,
    currency: product.currency || 'XOF',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  orders.push(order);
  writeJSON(ORDERS_FILE, orders);

  // ── CinetPay integration ──
  // Si CINETPAY_APIKEY est configuré, on appelle leur API
  if (process.env.CINETPAY_APIKEY && process.env.CINETPAY_SITE_ID) {
    try {
      const cpRes = await axios.post('https://api-checkout.cinetpay.com/v2/payment', {
        apikey: process.env.CINETPAY_APIKEY,
        site_id: process.env.CINETPAY_SITE_ID,
        transaction_id: orderId,
        amount: product.price,
        currency: product.currency || 'XOF',
        description: product.title,
        return_url: `${process.env.SITE_URL}/success.html?order=${orderId}`,
        notify_url: `${process.env.SITE_URL}/api/orders/webhook`,
        customer_name: email.split('@')[0],
        customer_email: email,
        customer_phone_number: phone,
        channels: 'ALL', // Wave, MTN, Orange, etc.
        lang: 'fr',
      });

      if (cpRes.data && cpRes.data.code === '201') {
        return res.json({
          success: true,
          orderId,
          paymentUrl: cpRes.data.data.payment_url,
          message: 'Redirection vers le paiement',
        });
      }
    } catch (err) {
      console.error('CinetPay error:', err.message);
    }
  }

  // Mode démo (sans clé API configurée)
  res.json({
    success: true,
    orderId,
    demoMode: true,
    message: 'Mode démo — Configurez CINETPAY_APIKEY dans .env pour activer le vrai paiement',
    simulateUrl: `/api/orders/simulate-success?order=${orderId}`,
  });
});

// GET simulate payment success (DEMO only)
app.get('/api/orders/simulate-success', async (req, res) => {
  const { order: orderId } = req.query;
  await processSuccessfulPayment(orderId);
  res.redirect(`/success.html?order=${orderId}`);
});

// POST CinetPay webhook (called after real payment)
app.post('/api/orders/webhook', async (req, res) => {
  const { cpm_trans_id, cpm_result } = req.body;
  if (cpm_result === '00') {
    await processSuccessfulPayment(cpm_trans_id);
  }
  res.json({ success: true });
});

// Process payment + send email
async function processSuccessfulPayment(orderId) {
  const orders  = readJSON(ORDERS_FILE);
  const products = readJSON(PRODUCTS_FILE);
  const idx   = orders.findIndex(o => o.id === orderId);
  if (idx === -1) return;

  const order   = orders[idx];
  const product = products.find(p => p.id === order.productId);
  if (!product) return;

  // Update order status
  orders[idx].status = 'completed';
  orders[idx].paidAt = new Date().toISOString();
  writeJSON(ORDERS_FILE, orders);

  // Send delivery email
  try {
    await sendDeliveryEmail(order, product);
    console.log(`✅ Email envoyé à ${order.email} pour commande ${orderId}`);
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

// GET order status
app.get('/api/orders/:id', (req, res) => {
  const orders = readJSON(ORDERS_FILE);
  const order  = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Commande introuvable' });
  res.json({ success: true, data: { id: order.id, status: order.status, paidAt: order.paidAt } });
});

// ─── SPA fallback ─────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 DigiStore Africa running on port ${PORT}`);
  console.log(`🌍 http://localhost:${PORT}`);
});

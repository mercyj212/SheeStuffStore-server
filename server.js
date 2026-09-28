const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');
const Stripe = require('stripe');

dotenv.config();

const app = express();
let PORT = parseInt(process.env.PORT || '5001', 10);
const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// Middleware
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3000', credentials: true }));

// Raw body parser for Stripe Webhook before express.json()
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (webhookSecret && webhookSecret !== 'whsec_placeholder') {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      if (session.id) {
        await prisma.order.update({
          where: { stripeSessionId: session.id },
          data: { paymentStatus: 'PAID', status: 'PAID' },
        });
        console.log(`[Express Backend] Order for session ${session.id} marked as PAID.`);
      }
    } catch (e) {
      console.error('[Express Backend] Error updating order status:', e);
    }
  }

  res.json({ received: true });
});

// JSON body parser for standard endpoints
app.use(express.json());

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', service: 'SheeStuff Store Express API', port: PORT, timestamp: new Date() });
});

// 1. Products API Endpoints
app.get('/api/products', async (req, res) => {
  try {
    const { category, search, featured } = req.query;
    let products = await prisma.product.findMany({
      include: { reviews: true },
      orderBy: { createdAt: 'desc' },
    });

    if (category && category !== 'All') {
      products = products.filter((p) => p.category.toLowerCase() === category.toLowerCase());
    }

    if (search) {
      const term = search.toLowerCase();
      products = products.filter(
        (p) =>
          p.name.toLowerCase().includes(term) ||
          p.category.toLowerCase().includes(term) ||
          p.description.toLowerCase().includes(term)
      );
    }

    if (featured === 'true') {
      products = products.filter((p) => p.isFeatured);
    }

    res.json({ success: true, count: products.length, products });
  } catch (error) {
    console.error('[Express Backend] Products fetch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const body = req.body;
    const newProduct = await prisma.product.create({
      data: {
        name: body.name,
        tagline: body.tagline || 'Luxe Beauty Formula',
        category: body.category || 'Skincare',
        price: parseFloat(body.price),
        originalPrice: body.originalPrice ? parseFloat(body.originalPrice) : null,
        image: body.image,
        secondaryImage: body.secondaryImage || null,
        description: body.description,
        volume: body.volume || '50ml',
        badges: JSON.stringify(body.badges || ['NEW']),
        benefits: JSON.stringify(body.benefits || []),
        ingredients: JSON.stringify(body.ingredients || []),
        howToUse: body.howToUse || 'Apply as desired.',
        skinTypes: JSON.stringify(body.skinTypes || ['All Skin Types']),
        inStock: body.inStock ?? true,
        isFeatured: body.isFeatured ?? false,
      },
    });

    res.status(201).json({ success: true, product: newProduct });
  } catch (error) {
    console.error('[Express Backend] Product create error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Stripe Checkout Session Endpoint
app.post('/api/checkout', async (req, res) => {
  try {
    const { items, customer, shippingSpeed } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const appUrl = process.env.CLIENT_URL || 'http://localhost:3000';
    const orderNumber = `SS-${Math.floor(100000 + Math.random() * 900000)}`;

    const lineItems = items.map((item) => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.product.name,
          images: [item.product.image],
          description: item.selectedShade ? `Shade: ${item.selectedShade.name}` : item.product.tagline,
        },
        unit_amount: Math.round(item.product.price * 100),
      },
      quantity: item.quantity,
    }));

    const subtotal = items.reduce((sum, i) => sum + i.product.price * i.quantity, 0);
    const shippingFee = shippingSpeed === 'express' ? 9.99 : (subtotal >= 50 ? 0 : 4.99);

    const order = await prisma.order.create({
      data: {
        orderNumber,
        customerName: customer?.fullName || 'Valued Customer',
        email: customer?.email || 'customer@example.com',
        address: customer?.address || 'Standard Shipping Address',
        city: customer?.city || 'City',
        state: customer?.state || 'State',
        zip: customer?.zip || '00000',
        total: subtotal + shippingFee,
        status: 'PENDING',
        paymentStatus: 'UNPAID',
      },
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      customer_email: customer?.email || undefined,
      success_url: `${appUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}&order_id=${orderNumber}`,
      cancel_url: `${appUrl}/cart`,
      metadata: {
        orderId: order.id,
        orderNumber: orderNumber,
      },
    });

    await prisma.order.update({
      where: { id: order.id },
      data: { stripeSessionId: session.id },
    });

    res.json({ success: true, sessionId: session.id, url: session.url, orderNumber });
  } catch (error) {
    console.error('[Express Backend] Checkout Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Customer Reviews API
app.post('/api/reviews', async (req, res) => {
  try {
    const { productId, author, rating, title, comment } = req.body;
    const review = await prisma.review.create({
      data: {
        productId: productId || 'shee-radiance-serum',
        author: author || 'Anonymous Customer',
        rating: Number(rating) || 5,
        title: title || 'Verified Customer Review',
        comment: comment || 'Loved this formula!',
        verified: true,
      },
    });
    res.status(201).json({ success: true, review });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start Express Server with EADDRINUSE Port Fallback
function startServer(portToTry) {
  const server = app.listen(portToTry, () => {
    console.log(`🚀 SheeStuff Express Backend API running on http://localhost:${portToTry}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️ Port ${portToTry} is already in use. Trying port ${portToTry + 1}...`);
      startServer(portToTry + 1);
    } else {
      console.error('Server error:', err);
    }
  });
}

startServer(PORT);

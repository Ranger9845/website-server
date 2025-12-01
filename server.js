const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const axios = require('axios');
const { Client, Environment } = require('square');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Square Client Setup
const squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production
});

// Store location coordinates for distance-based shipping
const STORE_LOCATION = {
    address: process.env.STORE_ADDRESS || '339873 E US 62 Meeker OK 74855',
    lat: parseFloat(process.env.STORE_LAT || 35.8456),
    lng: parseFloat(process.env.STORE_LNG || -103.3181)
};

// Shipping rates per mile
const SHIPPING_RATES = {
    baseRate: 5.00,
    costPerMile: 0.50,
    maxRate: 50.00,
    freeShippingThreshold: 150.00 // Free shipping for orders over $150
};

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// Helper function to calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3959; // Earth's radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Helper function to geocode address and get coordinates
async function geocodeAddress(address) {
    try {
        if (!process.env.GOOGLE_MAPS_API_KEY) {
            console.warn('Google Maps API Key not set, using estimated coordinates');
            return { lat: 35.0, lng: -97.0 };
        }
        const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
            params: {
                address: address,
                key: process.env.GOOGLE_MAPS_API_KEY
            }
        });
        if (response.data.results.length > 0) {
            const { lat, lng } = response.data.results[0].geometry.location;
            return { lat, lng };
        }
    } catch (error) {
        console.error('Geocoding error:', error.message);
    }
    return null;
}

// Helper function to calculate shipping cost
function calculateShippingCost(distance, subtotal) {
    // Free shipping for orders over threshold
    if (subtotal >= SHIPPING_RATES.freeShippingThreshold) {
        return 0;
    }

    // Base rate + cost per mile
    let cost = SHIPPING_RATES.baseRate + (distance * SHIPPING_RATES.costPerMile);

    // Cap at max rate
    if (cost > SHIPPING_RATES.maxRate) {
        cost = SHIPPING_RATES.maxRate;
    }

    return Math.round(cost * 100) / 100;
}

// MongoDB connection string
const MONGODB_URI = 'mongodb+srv://NeoLayer:NeoLayer12@neolayer.bmr6cuu.mongodb.net/neolayer-store?retryWrites=true&w=majority';

let db;
let productsCollection;
let ordersCollection;
let settingsCollection;

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'Server is running',
        db: db ? 'Connected' : 'Not Connected',
        timestamp: new Date()
    });
});

// GET all products
app.get('/api/products', async (req, res) => {
    try {
        if (!productsCollection) {
            console.error('Products collection not initialized');
            return res.status(503).json({ error: 'Database not connected' });
        }
        const products = await productsCollection.find({}).toArray();
        console.log(`Fetched ${products.length} products`);
        res.json(products || []);
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ error: error.message });
    }
});

// POST create new product
app.post('/api/products', async (req, res) => {
    try {
        if (!productsCollection) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        const { name, description, price, emoji } = req.body;

        if (!name || !description || price === undefined) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const newProduct = {
            name,
            description,
            price: parseFloat(price),
            emoji: emoji || '🎨',
            createdAt: new Date()
        };

        const result = await productsCollection.insertOne(newProduct);
        res.status(201).json({ _id: result.insertedId, ...newProduct });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE product by ID
app.delete('/api/products/:id', async (req, res) => {
    try {
        if (!productsCollection) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: 'Invalid product ID' });
        }

        const result = await productsCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        res.json({ message: 'Product deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// UPDATE product by ID
app.put('/api/products/:id', async (req, res) => {
    try {
        if (!productsCollection) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        const { id } = req.params;
        const { name, description, price, emoji } = req.body;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: 'Invalid product ID' });
        }

        const updateData = {};
        if (name) updateData.name = name;
        if (description) updateData.description = description;
        if (price !== undefined) updateData.price = parseFloat(price);
        if (emoji) updateData.emoji = emoji;

        const result = await productsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateData }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        res.json({ message: 'Product updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST create order
app.post('/api/orders', async (req, res) => {
    try {
        if (!ordersCollection) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        const order = req.body;
        
        // Generate a unique order number if not provided
        if (!order.orderNumber) {
            order.orderNumber = 'ORD-' + Date.now();
        }
        
        console.log('Received order:', JSON.stringify(order, null, 2));
        const result = await ordersCollection.insertOne(order);
        console.log('New order received:', order.customerName, '- Order ID:', result.insertedId);
        res.status(201).json({ _id: result.insertedId, ...order });
    } catch (error) {
        console.error('Order creation error:', error);
        res.status(500).json({ error: error.message });
    }
});

// GET all orders
app.get('/api/orders', async (req, res) => {
    try {
        if (!ordersCollection) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        const orders = await ordersCollection.find({}).sort({ createdAt: -1 }).toArray();
        res.json(orders || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET orders by status
app.get('/api/orders/status/:status', async (req, res) => {
    try {
        if (!ordersCollection) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        const { status } = req.params;
        const orders = await ordersCollection.find({ status }).sort({ createdAt: -1 }).toArray();
        res.json(orders || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// UPDATE order status
app.put('/api/orders/:id/status', async (req, res) => {
    try {
        if (!ordersCollection) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        const { id } = req.params;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: 'Invalid order ID' });
        }

        const result = await ordersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status, updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        res.json({ message: 'Order status updated' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE order
app.delete('/api/orders/:id', async (req, res) => {
    try {
        if (!ordersCollection) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: 'Invalid order ID' });
        }

        const result = await ordersCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        res.json({ message: 'Order deleted' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET store settings
app.get('/api/settings', async (req, res) => {
    try {
        if (!settingsCollection) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        const settings = await settingsCollection.findOne({ _id: 'store' });
        res.json(settings || { _id: 'store', theme: 'default' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PUT update store theme
app.put('/api/settings/theme', async (req, res) => {
    try {
        if (!settingsCollection) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        const { theme } = req.body;

        if (!theme) {
            return res.status(400).json({ error: 'Theme is required' });
        }

        const result = await settingsCollection.updateOne(
            { _id: 'store' },
            { $set: { theme, updatedAt: new Date() } },
            { upsert: true }
        );

        res.json({ message: 'Theme updated successfully', theme });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST calculate shipping cost
app.post('/api/shipping/calculate', async (req, res) => {
    try {
        const { address, city, state, zipCode, country, subtotal } = req.body;

        if (!address || !city || !state || !zipCode) {
            return res.status(400).json({ error: 'Incomplete shipping address' });
        }

        // Geocode the destination address
        const fullAddress = `${address}, ${city}, ${state} ${zipCode}, ${country || 'USA'}`;
        const coords = await geocodeAddress(fullAddress);

        if (!coords) {
            return res.status(400).json({ error: 'Unable to validate address' });
        }

        // Calculate distance from store
        const distance = calculateDistance(
            STORE_LOCATION.lat,
            STORE_LOCATION.lng,
            coords.lat,
            coords.lng
        );

        // Calculate shipping cost
        const shippingCost = calculateShippingCost(distance, subtotal);

        res.json({
            distance: Math.round(distance * 10) / 10,
            shippingCost: shippingCost,
            message: shippingCost === 0 ? 'Free shipping!' : `Shipping for ${Math.round(distance)} miles`
        });
    } catch (error) {
        console.error('Shipping calculation error:', error);
        res.status(500).json({ error: error.message });
    }
});

// POST process Square payment
app.post('/api/payments/square', async (req, res) => {
    try {
        const { sourceId, amount, currency, orderId, customerEmail, customerName } = req.body;

        if (!sourceId || !amount || !orderId) {
            return res.status(400).json({ error: 'Missing required payment fields' });
        }

        const paymentsApi = squareClient.paymentsApi;

        const payment = await paymentsApi.createPayment({
            sourceId: sourceId,
            idempotencyKey: orderId,
            amountMoney: {
                amount: Math.round(amount * 100), // Convert to cents
                currency: currency || 'USD'
            },
            customerId: customerEmail, // Use email as customer ID
            receiptUrl: true,
            statementDescriptionIdentifier: 'LayerMonster'
        });

        if (payment.result.payment.status === 'COMPLETED' || payment.result.payment.status === 'APPROVED') {
            // Update order with payment info
            if (ordersCollection) {
                const updateResult = await ordersCollection.updateOne(
                    { _id: new ObjectId(orderId) },
                    {
                        $set: {
                            paymentStatus: 'completed',
                            paymentId: payment.result.payment.id,
                            paymentMethod: 'square',
                            updatedAt: new Date()
                        }
                    }
                );
            }

            res.json({
                success: true,
                paymentId: payment.result.payment.id,
                status: payment.result.payment.status,
                message: 'Payment processed successfully'
            });
        } else {
            res.status(400).json({
                success: false,
                message: `Payment ${payment.result.payment.status}`
            });
        }
    } catch (error) {
        console.error('Payment error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Payment processing failed'
        });
    }
});

// GET Square payment form configuration
app.get('/api/payments/config', (req, res) => {
    res.json({
        squareApplicationId: process.env.SQUARE_APPLICATION_ID || 'YOUR_APP_ID',
        locationId: 'YOUR_LOCATION_ID'
    });
});

// Serve static files AFTER API routes
app.use(express.static(__dirname));

// Serve index.html for root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 404 handler for undefined API routes (BEFORE static files catch them)
app.use((req, res) => {
    // If it's an API request, return JSON 404
    if (req.path.startsWith('/api')) {
        console.warn(`API Route not found: ${req.method} ${req.path}`);
        return res.status(404).json({ error: 'API endpoint not found', path: req.path, method: req.method });
    }
    // Otherwise try to serve as static file or 404
    res.status(404).sendFile(path.join(__dirname, 'index.html'));
});

// Connect to MongoDB
async function connectMongoDB() {
    try {
        console.log('Attempting to connect to MongoDB...');
        const client = await MongoClient.connect(MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });

        db = client.db('neolayer-store');
        productsCollection = db.collection('products');
        ordersCollection = db.collection('orders');
        settingsCollection = db.collection('settings');

        // Test collections
        try {
            await productsCollection.findOne({});
            await ordersCollection.findOne({});
            await settingsCollection.findOne({});
            console.log('✓ Connected to MongoDB');
            console.log('✓ Database collections verified');
        } catch (error) {
            console.error('Error verifying collections:', error.message);
        }

        // Initialize settings if not exists
        const existingSettings = await settingsCollection.findOne({ _id: 'store' });
        if (!existingSettings) {
            await settingsCollection.insertOne({ _id: 'store', theme: 'default' });
            console.log('✓ Initialized store settings');
        }
    } catch (error) {
        console.error('⚠️  MongoDB connection failed:', error.message);
        console.log('Server will continue without database - API calls will return 503');
    }
}

// Start server
const server = app.listen(PORT, () => {
    console.log(`\n✓ Server running on http://localhost:${PORT}`);
    console.log(`  Store: http://localhost:${PORT}`);
    console.log(`  Admin: http://localhost:${PORT}/admin.html`);
    console.log(`  Health: http://localhost:${PORT}/api/health\n`);

    // Connect to MongoDB in background
    connectMongoDB();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

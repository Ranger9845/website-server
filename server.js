const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// MongoDB connection string
const MONGODB_URI = 'mongodb+srv://NeoLayer:NeoLayer12@neolayer.bmr6cuu.mongodb.net/neolayer-store?retryWrites=true&w=majority';

let db;
let productsCollection;
let ordersCollection;
let settingsCollection;

// Connect to MongoDB and start server
async function startServer() {
    try {
        console.log('Attempting to connect to MongoDB...');
        console.log('URI:', MONGODB_URI.substring(0, 50) + '...');
        
        const client = await MongoClient.connect(MONGODB_URI, { 
            useNewUrlParser: true, 
            useUnifiedTopology: true 
        });
        
        console.log('✓ Connected to MongoDB');
        db = client.db('neolayer-store');
        productsCollection = db.collection('products');
        ordersCollection = db.collection('orders');
        settingsCollection = db.collection('settings');
        
        // Initialize settings if not exists
        const existingSettings = await settingsCollection.findOne({ _id: 'store' });
        if (!existingSettings) {
            await settingsCollection.insertOne({ _id: 'store', theme: 'default' });
        }
        
        // Routes
        
        // Health check
        app.get('/api/health', (req, res) => {
            res.json({ status: 'Server is running', timestamp: new Date() });
        });
        
        // GET all products
        app.get('/api/products', async (req, res) => {
            try {
                if (!productsCollection) {
                    return res.status(500).json({ error: 'Database not connected' });
                }
                const products = await productsCollection.find({}).toArray();
                res.json(products || []);
            } catch (error) {
                console.error('Error fetching products:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // POST create new product
        app.post('/api/products', async (req, res) => {
            try {
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
                const order = req.body;
                const result = await ordersCollection.insertOne(order);
                console.log('New order received:', order.customerName, '- Order ID:', result.insertedId);
                res.status(201).json({ _id: result.insertedId, ...order });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // GET all orders
        app.get('/api/orders', async (req, res) => {
            try {
                const orders = await ordersCollection.find({}).sort({ createdAt: -1 }).toArray();
                res.json(orders || []);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // GET orders by status
        app.get('/api/orders/status/:status', async (req, res) => {
            try {
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
                const settings = await settingsCollection.findOne({ _id: 'store' });
                res.json(settings || { _id: 'store', theme: 'default' });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // PUT update store theme
        app.put('/api/settings/theme', async (req, res) => {
            try {
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

        // Start server
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
            console.log('Access admin panel at: http://localhost:5000/admin.html');
            console.log('Main store at: http://localhost:5000/index.html');
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

startServer();

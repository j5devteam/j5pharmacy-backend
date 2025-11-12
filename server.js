const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createServer } = require('http');
require('dotenv').config();
const { testConnection } = require('./config/database');
const InventoryRoutes = require('./routes/InventoryRoutes');
const authRoutes = require('./routes/auth.routes');
const cashReconciliationRoutes = require('./routes/cashReconciliation.routes');
const transactionRoutes = require('./routes/transaction.routes');
const branchRoutes = require('./routes/branchRoutes');
const customerRoutes = require('./routes/customer.routes');
const staffRoutes = require('./routes/staff.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const resourcesRoutes = require('./routes/resources.routes');
const posRoutes = require('./routes/pos.routes');
const logsRoutes = require('./routes/logs.routes');
const { initializeSocket } = require('./socket');
const settingsRoutes = require('./routes/settings.route');
// Import dev routes
const devRoutes = require('./routes/dev.routes');
const ecommerceRoutes = require('./routes/ecommerce.routes');

const app = express();
const httpServer = createServer(app);

// CORS configuration
const corsOptions = {
  origin: [process.env.FRONTEND_URL, 'http://localhost:3000', 'http://localhost:5000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

// Middleware
app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Test route
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to J5 Pharmacy Management System API' });
});

// Test database connection
testConnection();

// POS routes FIRST!
app.use('/api/pos', posRoutes);

// Then the rest
app.use('/api/auth', authRoutes);
app.use('/', InventoryRoutes);
app.use('/api/cash-reconciliation', cashReconciliationRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/admin', branchRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/resources', resourcesRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/ecommerce', ecommerceRoutes);


// Register dev routes
if (process.env.NODE_ENV === 'development') {
  app.use('/api/dev', devRoutes);
  console.log('[DEV] Development routes enabled');
}

// Initialize Socket.io
initializeSocket(httpServer);

// Start server
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});


// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});


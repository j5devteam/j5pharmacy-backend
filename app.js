const prescriptionRoutes = require('./routes/prescription.routes');
const rfidRoutes = require('./routes/rfid.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const posRoutes = require('./routes/pos.routes');

// Routes
app.use('/api/prescriptions', prescriptionRoutes);
app.use('/api/rfid', rfidRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/pos', posRoutes);

// Body parser middleware
app.use(express.json({ limit: '50mb' })); // Increased from default 1mb to 50mb
app.use(express.urlencoded({ extended: true, limit: '50mb' })); // Increased from default 1mb to 50mb 
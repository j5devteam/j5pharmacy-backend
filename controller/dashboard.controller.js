const db = require('../config/database');
const { getConvertTZString } = require('../utils/timeZoneUtil');
const { getIo } = require('../socket');

// Get dashboard overview data
const getDashboardOverview = async (req, res) => {
    try {
        const [results] = await db.pool.query(`
            SELECT 
                CAST(COALESCE(SUM(CASE 
                    WHEN DATE(created_at) = DATE(NOW())
                    AND payment_status = 'paid' 
                    THEN total_amount 
                    ELSE 0 
                END), 0) AS DECIMAL(10,2)) as todaySales,
                (SELECT COUNT(*) FROM products WHERE is_active = TRUE) as totalProducts,
                (SELECT COUNT(*) FROM sales) as totalOrders,
                (SELECT COUNT(*) FROM customers WHERE is_archived = FALSE) as totalCustomers
            FROM sales
        `);

        console.log('Dashboard Overview Data:', results[0]);

        // Try to emit the update, but don't fail if socket isn't ready
        try {
            const io = getIo();
            io.emit('dashboard_update', results[0]);
        } catch (socketError) {
            console.log('Socket not ready for dashboard update');
        }

        res.json(results[0]);
    } catch (error) {
        console.error('Error fetching dashboard overview:', error);
        res.status(500).json({ message: 'Error fetching dashboard data', error: error.message });
    }
};

const getDashboardOverviewByBranch = async (req, res) => {
    const { branch_id } = req.query;
    try {
        const [results] = await db.pool.query(`
            SELECT 
                CAST(COALESCE(SUM(CASE 
                    WHEN DATE(created_at) = DATE(NOW())
                    AND payment_status = 'paid' 
                    AND branch_id = ? 
                    THEN total_amount 
                    ELSE 0 
                END), 0) AS DECIMAL(10,2)) as todaySales,
                (SELECT COUNT(*) FROM products WHERE is_active = TRUE) as totalProducts,
                (SELECT COUNT(*) FROM sales WHERE branch_id = ?) as totalOrders,
                (SELECT COUNT(*) FROM customers WHERE is_archived = FALSE AND branch_id = ?) as totalCustomers
            FROM sales
            WHERE branch_id = ?
        `, [branch_id, branch_id, branch_id, branch_id, branch_id]);

        console.log('Dashboard Overview Data:', results[0]);

        // Try to emit the update, but don't fail if socket isn't ready
        try {
            const io = getIo();
            io.emit('dashboard_update', results[0]);
        } catch (socketError) {
            console.log('Socket not ready for dashboard update');
        }

        res.json(results[0]);
    } catch (error) {
        console.error('Error fetching dashboard overview:', error);
        res.status(500).json({ message: 'Error fetching dashboard data', error: error.message });
    }
};

// Helper function to emit dashboard updates
const emitDashboardUpdate = async () => {
    try {
        const [results] = await db.pool.query(`
            SELECT 
                CAST(COALESCE(SUM(CASE 
                    WHEN DATE(created_at) = DATE(NOW())
                    AND payment_status = 'paid' 
                    THEN total_amount 
                    ELSE 0 
                END), 0) AS DECIMAL(10,2)) as todaySales,
                (SELECT COUNT(*) FROM products WHERE is_active = TRUE) as totalProducts,
                (SELECT COUNT(*) FROM sales) as totalOrders,
                (SELECT COUNT(*) FROM customers WHERE is_archived = FALSE) as totalCustomers
            FROM sales
        `);

        try {
            const io = getIo();
            io.emit('dashboard_update', results[0]);
        } catch (socketError) {
            console.log('Socket not ready for dashboard update');
        }
    } catch (error) {
        console.error('Error emitting dashboard update:', error);
    }
};

// Helper function to emit expired products updates
const emitExpiredProductsUpdate = async () => {
    try {
        const [products] = await db.pool.query(`
            SELECT 
                p.name,
                p.barcode,
                bi.batch_id,
                p.brand_name,
                c.name AS category_name,
                b.branch_name,
                DATE_FORMAT(bi.expiryDate, '%Y-%m-%d') AS expiryDate
            FROM branch_inventory bi
            JOIN products p ON bi.product_id = p.id
            JOIN category c ON p.category = c.category_id
            JOIN branches b ON bi.branch_id = b.branch_id
            WHERE bi.is_active = TRUE AND bi.expiryDate < CURDATE()
            ORDER BY bi.expiryDate ASC
            LIMIT 5
        `);

        try {
            const io = getIo();
            io.emit('expired_products_update', products);
        } catch (socketError) {
            console.log('Socket not ready for expired products update');
        }
    } catch (error) {
        console.error('Error emitting expired products update:', error);
    }
};

const emitExpiredProductsUpdateByBranch = async (branch_id) => {
    try {
        const [products] = await db.pool.query(`
            SELECT 
                p.name,
                p.barcode,
                bi.batch_id,
                p.brand_name,
                c.name AS category_name,
                b.branch_name,
                DATE_FORMAT(bi.expiryDate, '%Y-%m-%d') AS expiryDate
            FROM branch_inventory bi
            JOIN products p ON bi.product_id = p.id
            JOIN category c ON p.category = c.category_id
            JOIN branches b ON bi.branch_id = b.branch_id
            WHERE bi.is_active = TRUE AND bi.expiryDate < CURDATE()
            AND bi.branch_id = ?
            ORDER BY bi.expiryDate ASC
            LIMIT 5;
        `, [branch_id]);

        try {
            const io = getIo();
            io.emit('expired_products_update_by_branch', products);
        } catch (socketError) {
            console.log('Socket not ready for expired products update');
        }
    } catch (error) {
        console.error('Error emitting expired products update:', error);
    }
};


// Get recent transactions with enhanced details
const getRecentTransactions = async (req, res) => {
    try {
        const [transactions] = await db.pool.query(`
            SELECT 
                s.id as transaction_id,
                s.invoice_number,
                s.created_at as created_at,
                CAST(s.total_amount AS DECIMAL(10,2)) as total_amount,
                s.payment_method,
                s.payment_status,
                b.branch_name
            FROM sales s
            LEFT JOIN branches b ON s.branch_id = b.branch_id
            ORDER BY s.created_at DESC
            LIMIT 5
        `);

        res.json({ transactions });
    } catch (error) {
        console.error('Error fetching recent transactions:', error);
        res.status(500).json({ message: 'Error fetching recent transactions', error: error.message });
    }
};

const getRecentTransactionsByBranch = async (req, res) => {
    try {
        const { branch_id } = req.query; // Get branch_id from request query

        if (!branch_id) {
            return res.status(400).json({ message: "Branch ID is required" });
        }

        const [transactions] = await db.pool.query(`
            SELECT 
                s.id as transaction_id,
                s.invoice_number,
                s.created_at as created_at,
                CAST(s.total_amount AS DECIMAL(10,2)) as total_amount,
                s.payment_method,
                s.payment_status,
                b.branch_name
            FROM sales s
            LEFT JOIN branches b ON s.branch_id = b.branch_id
            WHERE s.branch_id = ?
            ORDER BY s.created_at DESC
            LIMIT 5
        `, [branch_id]); // Pass branch_id as parameter to prevent SQL injection

        res.json({ transactions });
    } catch (error) {
        console.error('Error fetching recent transactions:', error);
        res.status(500).json({ message: 'Error fetching recent transactions', error: error.message });
    }
};


// Get low stock items with enhanced metrics
const getLowStockItems = async (req, res) => {
    try {
        const [items] = await db.pool.query(`
            SELECT 
                p.id,
                p.name,
                p.brand_name,
                p.barcode,
                p.critical,
                c.name AS category_name,
                bi.stock,
                b.branch_name,
                CONCAT(b.branch_name, ': ', bi.stock) AS critical_branches
            FROM products p
            LEFT JOIN category c ON p.category = c.category_id
            JOIN branch_inventory bi ON p.id = bi.product_id
            JOIN branches b ON bi.branch_id = b.branch_id
            WHERE bi.stock <= p.critical
                AND p.is_active = 1
                AND bi.is_active = 1
            ORDER BY bi.stock ASC, p.name ASC
            LIMIT 5;
        `);

        const formattedItems = items.map(item => ({
            id: item.id,
            name: item.brand_name ? `${item.name} (${item.brand_name})` : item.name,
            barcode: item.barcode,
            category_name: item.category_name,
            critical: item.critical,
            stock: item.stock,
            critical_branches: item.critical_branches,
            branch_name: item.branch_name
        }));

        res.json({ items: formattedItems });
    } catch (error) {
        console.error('Error fetching low stock items:', error);
        res.status(500).json({ message: 'Error fetching low stock items', error: error.message });
    }
};


const getLowStockItemsByBranch = async (req, res) => {
    try {
        const { branch_id } = req.query;

        if (!branch_id) {
            return res.status(400).json({ message: "Branch ID is required" });
        }

        const [items] = await db.pool.query(`
            SELECT DISTINCT
                p.id,
                p.name,
                p.barcode,
                p.critical,  -- 🔥 Ensure critical level is selected
                c.name as category_name,
                bi.stock as stock,
                b.branch_name,
                CONCAT(b.branch_name, ': ', bi.stock) AS critical_branches  -- 🔥 Ensure critical_branches is properly formatted
            FROM products p
            LEFT JOIN category c ON p.category = c.category_id
            JOIN branch_inventory bi ON p.id = bi.product_id
            JOIN branches b ON bi.branch_id = b.branch_id
            WHERE bi.stock <= p.critical
                AND p.is_active = 1
                AND bi.is_active = 1
                AND bi.branch_id = ?  
            ORDER BY bi.stock ASC, p.name ASC
            LIMIT 5
        `, [branch_id]);

        res.json({ items });
    } catch (error) {
        console.error('Error fetching low stock items:', error);
        res.status(500).json({ message: 'Error fetching low stock items', error: error.message });
    }
};

const getExpiredProducts = async (req, res) => {
    try {
        const [products] = await db.pool.query(`
            SELECT 
                p.name,
                p.barcode,
                bi.batch_id,
                p.brand_name,
                c.name AS category_name,
                b.branch_name,
                DATE_FORMAT(bi.expiryDate, '%Y-%m-%d') AS expiryDate,
                bi.expiryThreshold,
                CASE 
                    WHEN bi.expiryDate IS NULL OR bi.expiryDate = '0000-00-00' THEN NULL
                    ELSE DATEDIFF(bi.expiryDate, CURDATE())
                END as daysUntilExpiry,
                CASE
                    WHEN bi.expiryDate IS NULL OR bi.expiryDate = '0000-00-00' THEN 'no_date'
                    WHEN bi.expiryDate <= CURDATE() THEN 'expired'
                    WHEN DATEDIFF(bi.expiryDate, CURDATE()) <= bi.expiryThreshold THEN 'near_expiry'
                    ELSE 'valid'
                END as expiry_status
            FROM branch_inventory bi
            JOIN products p ON bi.product_id = p.id
            JOIN category c ON p.category = c.category_id
            JOIN branches b ON bi.branch_id = b.branch_id
            WHERE bi.is_active = TRUE
            AND bi.expiryDate IS NOT NULL
            AND bi.expiryDate != '0000-00-00'
            AND bi.expiryDate <= CURDATE()
            ORDER BY bi.expiryDate ASC
            LIMIT 5;
        `);

        console.log('Expired Products Data:', products);

        // Try to emit the update, but don't fail if socket isn't ready
        try {
            const io = getIo();
            io.emit('expired_products_update', products);
        } catch (socketError) {
            console.log('Socket not ready for expired products update');
        }

        res.json({ products });
    } catch (error) {
        console.error('Error fetching dashboard expired products:', error);
        res.status(500).json({ message: 'Error fetching dashboard expired products', error: error.message });
    }
};



const getExpiredProductsByBranch = async (req, res) => {
    try {
        const { branch_id } = req.query;
        console.log('getExpiredProductsByBranch called with branch_id:', branch_id);

        if (!branch_id) {
            console.log('Branch ID is missing');
            return res.status(400).json({ message: "Branch ID is required" });
        }

        console.log('Executing query for branch_id:', branch_id);

        const [products] = await db.pool.query(`
            SELECT 
                p.name,
                p.barcode,
                bi.batch_id,
                p.brand_name,
                c.name AS category_name,
                b.branch_name,
                DATE_FORMAT(bi.expiryDate, '%Y-%m-%d') AS expiryDate,
                bi.expiryThreshold,
                CASE 
                    WHEN bi.expiryDate IS NULL OR bi.expiryDate = '0000-00-00' THEN NULL
                    ELSE DATEDIFF(bi.expiryDate, CURDATE())
                END as daysUntilExpiry,
                CASE
                    WHEN bi.expiryDate IS NULL OR bi.expiryDate = '0000-00-00' THEN 'no_date'
                    WHEN bi.expiryDate <= CURDATE() THEN 'expired'
                    WHEN DATEDIFF(bi.expiryDate, CURDATE()) <= bi.expiryThreshold THEN 'near_expiry'
                    ELSE 'valid'
                END as expiry_status
            FROM branch_inventory bi
            JOIN products p ON bi.product_id = p.id
            JOIN category c ON p.category = c.category_id
            JOIN branches b ON bi.branch_id = b.branch_id
            WHERE bi.is_active = TRUE
            AND bi.expiryDate IS NOT NULL
            AND bi.expiryDate != '0000-00-00'
            AND bi.branch_id = ?
            AND bi.expiryDate <= CURDATE()
            ORDER BY bi.expiryDate ASC
            LIMIT 5;
        `, [branch_id]);

        console.log('Expired Products Data for branch:', branch_id, products);

        // Try to emit the update, but don't fail if socket isn't ready
        try {
            const io = getIo();
            io.emit('expired_products_update_by_branch', products);
        } catch (socketError) {
            console.log('Socket not ready for expired products update');
        }

        res.json({ products });
    } catch (error) {
        console.error('Error fetching expired products by branch:', error);
        res.status(500).json({ message: 'Error fetching expired products by branch', error: error.message });
    }
};

module.exports = {
    getDashboardOverview,
    getRecentTransactions,
    getLowStockItems,
    emitDashboardUpdate, // Export the helper function
    emitExpiredProductsUpdate, // Export the expired products helper function
    emitExpiredProductsUpdateByBranch, // Export the expired products helper function
    getDashboardOverviewByBranch,
    getRecentTransactionsByBranch,
    getLowStockItemsByBranch,
    getExpiredProducts,
    getExpiredProductsByBranch,
};  
const db = require('../config/database');
const { getConvertTZString, getMySQLTimestamp } = require('../utils/timeZoneUtil');

const getTransactionFilter = async (req, res) => {
    try {
        // Changed from req.params to req.query to match getKeyMetrics
        const { branchId, startDate, endDate } = req.query;

        if (!branchId) {
            return res.status(400).json({ error: 'Branch ID is required' });
        }

        let query = `
            SELECT 
                s.id,
                s.invoice_number,
                s.created_at,
                s.total_amount,
                s.discount_amount,
                s.discount_type,
                s.payment_method,
                s.payment_status,
                s.amount_tendered,
                s.amount_change,
                COALESCE(c.name, 'Walk-in Customer') as customer_name,
                s.points_earned,
                s.branch_id,
                b.branch_name
            FROM sales s
            LEFT JOIN customers c ON s.customer_id = c.customer_id
            LEFT JOIN branches b ON s.branch_id = b.branch_id
            WHERE s.branch_id = ?
        `;

        let params = [branchId];

        // Use the same default date logic as getKeyMetrics
        const defaultStartDate = startDate || '2024-01-01';
        const defaultEndDate = endDate || new Date().toISOString().split('T')[0];

        query += ` AND ${getConvertTZString('s.created_at')} BETWEEN ? AND ?`;
        params.push(defaultStartDate, defaultEndDate);

        query += ' ORDER BY s.created_at DESC';

        console.log('Query:', query);
        console.log('Parameters:', params);

        const [results] = await db.pool.query(query, params);
        res.json(results);
    } catch (error) {
        console.error('Error fetching transactions:', error);
        // Changed error message to match getKeyMetrics pattern
        res.status(500).json({ message: 'Error fetching transactions' });
    }
}

const getAllTransactions = async (req, res) => {
    try {
        const { branchId } = req.query;

        if (!branchId) {
            return res.status(400).json({ error: 'Branch ID is required' });
        }

        const query = `
            SELECT 
                s.id,
                s.invoice_number,
                s.created_at,
                s.total_amount,
                s.discount_amount,
                s.discount_type,
                s.payment_method,
                s.payment_status,
                s.amount_tendered,
                s.amount_change,
                COALESCE(c.name, 'Walk-in Customer') as customer_name,
                s.points_earned,
                s.branch_id,
                b.branch_name,
                COUNT(si.id) as item_count,
                GROUP_CONCAT(
                    CONCAT(p.name, ' (', si.quantity, ')')
                    SEPARATOR ', '
                ) as items
            FROM sales s
            LEFT JOIN customers c ON s.customer_id = c.customer_id
            LEFT JOIN branches b ON s.branch_id = b.branch_id
            LEFT JOIN sale_items si ON s.id = si.sale_id
            LEFT JOIN products p ON si.product_id = p.id
            WHERE s.branch_id = ?
            GROUP BY s.id, s.invoice_number, s.created_at, s.total_amount, 
                     s.discount_amount, s.discount_type, s.payment_method, 
                     s.payment_status, s.amount_tendered, s.amount_change, customer_name, s.points_earned, 
                     s.branch_id, b.branch_name
            ORDER BY s.created_at DESC`;

        const [results] = await db.pool.query(query, [branchId]);

        //         console.log('Fetching all transactions...');
        //         const [results] = await db.pool.query(query);
        //         console.log(`Successfully fetched ${results.length} transactions`);

        res.json(results);
    } catch (error) {
        console.error('Error fetching all transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
};

const getAllBranchesTransactions = async (req, res) => {
    try {
        const query = `
            SELECT
                    s.id,
                    s.invoice_number,
                    s.created_at,
                    s.total_amount,
                    s.discount_amount,
                    s.discount_type,
                    s.payment_method,
                    s.payment_status,
                    s.amount_tendered,
                    s.amount_change,
                    COALESCE(c.name, 'Walk-in Customer') AS customer_name,
                    s.points_earned,
                    s.branch_id,
                    p_name.name AS pharmacist_name,
                    b.branch_name,
                    s_payments.reference_number AS reference_number,
                    COUNT(si.id) AS item_count,
                    GROUP_CONCAT(
                        JSON_OBJECT(
                            'barcode', p.barcode,
                            'product_name', p.name,
                            'quantity', si.quantity,
                            'unit_price', si.unit_price,
                            'total_price', si.total_price
                        ) SEPARATOR '|||'
                    ) AS items_details
                FROM
                    sales s
                LEFT JOIN customers c ON
                    s.customer_id = c.customer_id
                LEFT JOIN branches b ON
                    s.branch_id = b.branch_id
                LEFT JOIN sale_items si ON
                    s.id = si.sale_id
                LEFT JOIN products p ON
                    si.product_id = p.id
                LEFT JOIN pharmacist_sessions p_session ON 
                    s.pharmacist_session_id = p_session.staff_id
                LEFT JOIN pharmacist p_name ON
                    p_session.staff_id = p_name.staff_id
                LEFT JOIN sales_payments s_payments ON
                    s.id = s_payments.sale_id
                GROUP BY
                    s.id,
                    s.invoice_number,
                    s.created_at,
                    s.total_amount,
                    s.discount_amount,
                    s.discount_type,
                    s.payment_method,
                    s.payment_status,
                    s.amount_tendered,
                    s.amount_change,
                    customer_name,
                    s.points_earned,
                    s.branch_id,
                    b.branch_name
                ORDER BY
                    s.created_at
                DESC
                    `;

        const [results] = await db.pool.query(query);

        //         console.log('Fetching all transactions...');
        //         const [results] = await db.pool.query(query);
        //         console.log(`Successfully fetched ${results.length} transactions`);

        res.json(results);
    } catch (error) {
        console.error('Error fetching all transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
};

// Get transaction summary with enhanced metrics and branch filtering
const getTransactionSummary = async (req, res) => {
    try {
        const { timeFilter, startDate, endDate, branchId } = req.query;

        if (!branchId) {
            return res.status(400).json({ error: 'Branch ID is required' });
        }

        let query = '';
        let params = [branchId]; // Always include branchId

        // Base query with timezone conversion and enhanced metrics
        const baseQuery = `
            SELECT 
                b.branch_name,
                COALESCE(SUM(s.total_amount), 0) AS total_sales
            FROM branches b
            LEFT JOIN sales s ON b.branch_id = s.branch_id
            WHERE 
                b.is_active = 1 
                AND b.is_archived = 0
                AND s.payment_status = 'paid'
                AND s.created_at BETWEEN '2023-02-01' AND '2025-05-31'
            GROUP BY b.branch_name
            ORDER BY total_sales DESC;
                    `;

        // // Add branch filter if specified
        // if (branchId) {
        //     query += ' AND s.branch_id = ?';
        //     params.push(branchId);
        // }

        // // Add date range filter
        // if (startDate && endDate) {
        //     query += ` AND ${getConvertTZString('s.created_at')} BETWEEN ? AND ?`;
        //     params.push(startDate, endDate);
        // }

        // // Add group by based on time filter
        // switch (timeFilter) {
        //     case 'hour':
        //         query += ` GROUP BY DATE_FORMAT(${getConvertTZString('s.created_at')}, '%Y-%m-%d %H:00:00'), s.branch_id`;
        //         break;
        //     case 'day':
        //         query += ` GROUP BY DATE_FORMAT(${getConvertTZString('s.created_at')}, '%Y-%m-%d'), s.branch_id`;
        //         break;
        //     case 'week':
        //         query += ` GROUP BY YEARWEEK(${getConvertTZString('s.created_at')}, 1), s.branch_id`;
        //         break;
        //     case 'month':
        //         query += ` GROUP BY DATE_FORMAT(${getConvertTZString('s.created_at')}, '%Y-%m'), s.branch_id`;
        //         break;
        //     case 'year':
        //         query += ` GROUP BY YEAR(${getConvertTZString('s.created_at')}), s.branch_id`;
        //         break;
        //     default:
        //         query += ` GROUP BY DATE_FORMAT(${getConvertTZString('s.created_at')}, '%Y-%m-%d'), s.branch_id`;
        // }

        // query += ' ORDER BY date DESC';

        // const [results] = await db.pool.query(baseQuery + query, params);
        const [results] = await db.pool.query(baseQuery)
        res.json(results);
    } catch (error) {
        console.error('Error fetching transaction summary:', error);
        res.status(500).json({ message: 'Error fetching transaction summary' });
    }
};

// Get latest transactions with enhanced details
const getLatestTransactions = async (req, res) => {
    try {
        const { branchId, limit = 10 } = req.query;

        if (!branchId) {
            return res.status(400).json({ error: 'Branch ID is required' });
        }

        const query = `
            SELECT 
                s.id,
                s.invoice_number,
                s.branch_id,
                ${getConvertTZString('s.created_at')} as created_at,
                CAST(s.total_amount AS DECIMAL(10,2)) as total_amount,
                CAST(s.discount_amount AS DECIMAL(10,2)) as discount_amount,
                CAST(s.amount_tendered AS DECIMAL(10,2)) as amount_tendered,
                CAST(s.amount_change AS DECIMAL(10,2)) as amount_change,
                s.discount_type,
                s.payment_method,
                s.payment_status,
                s.customer_name,
                s.points_earned,
                b.branch_name,
                COUNT(si.id) as item_count,
                GROUP_CONCAT(CONCAT(p.name, ' (', si.quantity, ')') SEPARATOR ', ') as items
            FROM sales s
            JOIN branches b ON s.branch_id = b.branch_id
            LEFT JOIN sale_items si ON s.id = si.sale_id
            LEFT JOIN products p ON si.product_id = p.id
            WHERE s.branch_id = ?
            GROUP BY s.id 
            ORDER BY s.created_at DESC 
            LIMIT ?`;

        const [results] = await db.pool.query(query, [branchId, parseInt(limit)]);
        res.json(results);
    } catch (error) {
        console.error('Error fetching latest transactions:', error);
        res.status(500).json({ message: 'Error fetching latest transactions' });
    }
};

// Get key metrics with branch filtering
const getKeyMetrics = async (req, res) => {
    try {
        const { branchId, startDate, endDate } = req.query;

        if (!branchId) {
            return res.status(400).json({ error: 'Branch ID is required' });
        }

        let params = [branchId];

        // Main metrics query
        const metricsQuery = `
            SELECT 
                COUNT(DISTINCT s.id) as total_transactions,
                CAST(COALESCE(SUM(s.total_amount), 0) AS DECIMAL(10,2)) as total_sales,
                CAST(COALESCE(AVG(s.total_amount), 0) AS DECIMAL(10,2)) as average_transaction_value,
                CAST(COALESCE(SUM(s.discount_amount), 0) AS DECIMAL(10,2)) as total_discounts,
                COUNT(DISTINCT sr.return_id) as total_returns,
                CAST(COALESCE(SUM(CASE WHEN sr.return_id IS NOT NULL THEN sr.refund_amount ELSE 0 END), 0) AS DECIMAL(10,2)) as total_return_amount,
                COUNT(DISTINCT s.customer_id) as unique_customers,
                CAST(COALESCE(SUM(CASE WHEN s.payment_status = 'paid' THEN s.total_amount ELSE 0 END), 0) AS DECIMAL(10,2)) as paid_amount,
                COUNT(DISTINCT CASE WHEN s.payment_status = 'paid' THEN s.id END) as paid_transactions,
                CAST(COALESCE(SUM(s.points_earned), 0) AS DECIMAL(10,2)) as total_points_earned,
                COUNT(DISTINCT CASE WHEN s.discount_type != 'None' THEN s.id END) as discounted_transactions,
                CAST(COALESCE(MAX(s.total_amount), 0) AS DECIMAL(10,2)) as highest_transaction,
                CAST(COALESCE(MIN(CASE WHEN s.total_amount > 0 THEN s.total_amount END), 0) AS DECIMAL(10,2)) as lowest_transaction,
                COUNT(DISTINCT DATE(${getConvertTZString('s.created_at')})) as active_days
            FROM sales s
            LEFT JOIN sales_returns sr ON s.id = sr.sale_id
            WHERE s.branch_id = ?
            AND ${getConvertTZString('s.created_at')} BETWEEN ? AND ?
        `;

        // Payment methods distribution query
        const paymentMethodsQuery = `
            SELECT 
                payment_method,
                COUNT(*) as count
            FROM sales s
            WHERE s.branch_id = ?
            AND ${getConvertTZString('s.created_at')} BETWEEN ? AND ?
            GROUP BY payment_method
        `;

        // Discount types distribution query
        const discountTypesQuery = `
            SELECT 
                discount_type,
                COUNT(*) as count
            FROM sales s
            WHERE s.branch_id = ?
            AND ${getConvertTZString('s.created_at')} BETWEEN ? AND ?
            GROUP BY discount_type
        `;

        params.push(startDate || '2024-01-01', endDate || new Date().toISOString().split('T')[0]);
        const paymentParams = [...params];
        const discountParams = [...params];

        const [metricsResults] = await db.pool.query(metricsQuery, params);
        const [paymentResults] = await db.pool.query(paymentMethodsQuery, paymentParams);
        const [discountResults] = await db.pool.query(discountTypesQuery, discountParams);

        // Convert array of payment methods to object
        const paymentMethodDistribution = paymentResults.reduce((acc, curr) => {
            acc[curr.payment_method] = curr.count;
            return acc;
        }, {});

        // Convert array of discount types to object
        const discountTypeDistribution = discountResults.reduce((acc, curr) => {
            acc[curr.discount_type] = curr.count;
            return acc;
        }, {});

        // Combine all results
        const combinedResults = {
            ...metricsResults[0],
            payment_method_distribution: paymentMethodDistribution,
            discount_type_distribution: discountTypeDistribution
        };

        res.json(combinedResults);
    } catch (error) {
        console.error('Error fetching key metrics:', error);
        res.status(500).json({ message: 'Error fetching key metrics' });
    }
};

// Update the invoice number of a transaction in sales table
const updateInvoiceNumber = async (req, res) => {
    try {
        const { oldInvoiceNumber, newInvoiceNumber } = req.body;
        if (oldInvoiceNumber === newInvoiceNumber) {
            return res.status(400).json({ message: 'Old and new invoice numbers cannot be the same' });
        }

        if (typeof oldInvoiceNumber !== 'string' || typeof newInvoiceNumber !== 'string') {
            return res.status(400).json({ message: 'Invoice numbers must be strings' });
        }

        // Check if the new invoice number already exists

        if (newInvoiceNumber === '') {
            const checkQuery = 'SELECT COUNT(*) as count FROM sales WHERE invoice_number = ?';
            const [checkResult] = await db.pool.query(checkQuery, [newInvoiceNumber]);
            if (checkResult[0].count > 0) {
                return res.status(400).json({ message: 'New invoice number already exists' });
            }
        }


        // Update the invoice number
        const updateQuery = 'UPDATE sales SET invoice_number = ? WHERE invoice_number = ?';
        const [updateResult] = await db.pool.query(updateQuery, [newInvoiceNumber, oldInvoiceNumber]);
        if (updateResult.affectedRows === 0) {
            return res.status(404).json({ message: 'Transaction not found or invoice number unchanged' });
        }

        res.json({ message: 'Invoice number updated successfully' });
        return;
    } catch (error) {
        console.error('Error updating invoice number:', error);
        res.status(500).json({ message: 'Error updating invoice number' });
    }
}

const getTransactionItems = async (req, res) => {
    try {
        const { invoiceNumber } = req.params;

        if (!invoiceNumber) {
            return res.status(400).json({ error: 'Invoice number is required' });
        }

        const query = `
            SELECT
                si.product_id,
                si.quantity,
                si.unit_price,
                (si.quantity * si.unit_price) as subtotal,
                si.transaction_id,
                si.is_void,
                p.name as product_name,
                p.barcode,
                p.brand_name,
                p.category
            FROM sale_items si
            LEFT JOIN products p ON si.product_id = p.id
            WHERE si.sale_id = (
                SELECT id FROM sales WHERE invoice_number = ?
            )
            ORDER BY si.id
        `;

        const [results] = await db.pool.query(query, [invoiceNumber]);
        res.json(results);
    } catch (error) {
        console.error('Error fetching transaction items:', error);
        res.status(500).json({ error: 'Error fetching transaction items' });
    }
}

const getPharmacyReports = async (req, res) => {
    try {
        const { branchId, startDate, endDate } = req.query;

        if (!branchId) {
            return res.status(400).json({ error: 'Branch ID is required' });
        }

        const params = [branchId];
        const dateCondition = startDate && endDate 
            ? `AND ${getConvertTZString('s.created_at')} BETWEEN ? AND ?`
            : '';
        
        if (startDate && endDate) {
            params.push(startDate, endDate);
        }

        // 1. Sales Summary Query
        const salesSummaryQuery = `
            SELECT 
                CAST(COALESCE(SUM(s.total_amount), 0) AS DECIMAL(10,2)) as total_sales,
                COUNT(DISTINCT s.id) as total_transactions,
                CAST(COALESCE(AVG(s.total_amount), 0) AS DECIMAL(10,2)) as average_transaction_value,
                CAST(COALESCE(SUM(s.discount_amount), 0) AS DECIMAL(10,2)) as total_discounts
            FROM sales s
            WHERE s.branch_id = ? 
            AND s.payment_status = 'paid'
            ${dateCondition}
        `;

        // 2. Profit Calculation Query (assuming cost can be calculated from wholesale_price or markup)
        const profitQuery = `
            SELECT 
                CAST(COALESCE(SUM(
                    si.total_price - (
                        CASE 
                            WHEN p.wholesale_price IS NOT NULL AND p.wholesale_price > 0 
                            THEN (p.wholesale_price * si.quantity)
                            ELSE (si.total_price * 0.7) -- fallback: assume 30% profit margin
                        END
                    )
                ), 0) AS DECIMAL(10,2)) as total_profit,
                CAST(COALESCE(SUM(si.total_price), 0) AS DECIMAL(10,2)) as total_revenue,
                CAST(COALESCE(SUM(
                    CASE 
                        WHEN p.wholesale_price IS NOT NULL AND p.wholesale_price > 0 
                        THEN (p.wholesale_price * si.quantity)
                        ELSE (si.total_price * 0.7)
                    END
                ), 0) AS DECIMAL(10,2)) as total_cost
            FROM sales s
            INNER JOIN sale_items si ON s.id = si.sale_id
            INNER JOIN products p ON si.product_id = p.id
            WHERE s.branch_id = ? 
            AND s.payment_status = 'paid'
            ${dateCondition}
        `;

        // 3. Top 5 Products by Quantity Sold
        const topProductsQuery = `
            SELECT 
                p.id,
                p.name,
                p.brand_name,
                SUM(si.quantity) as total_quantity_sold,
                CAST(SUM(si.total_price) AS DECIMAL(10,2)) as total_revenue,
                COUNT(DISTINCT s.id) as transaction_count
            FROM sales s
            INNER JOIN sale_items si ON s.id = si.sale_id
            INNER JOIN products p ON si.product_id = p.id
            WHERE s.branch_id = ? 
            AND s.payment_status = 'paid'
            ${dateCondition}
            GROUP BY p.id, p.name, p.brand_name
            ORDER BY total_quantity_sold DESC
            LIMIT 5
        `;

        // 4. Top 5 Categories by Sales
        const topCategoriesQuery = `
            SELECT 
                c.category_id,
                c.name as category_name,
                c.prefix,
                SUM(si.quantity) as total_quantity_sold,
                CAST(SUM(si.total_price) AS DECIMAL(10,2)) as total_revenue,
                COUNT(DISTINCT p.id) as unique_products,
                COUNT(DISTINCT s.id) as transaction_count
            FROM sales s
            INNER JOIN sale_items si ON s.id = si.sale_id
            INNER JOIN products p ON si.product_id = p.id
            INNER JOIN category c ON p.category = c.category_id
            WHERE s.branch_id = ? 
            AND s.payment_status = 'paid'
            AND c.is_active = 1
            ${dateCondition}
            GROUP BY c.category_id, c.name, c.prefix
            ORDER BY total_revenue DESC
            LIMIT 5
        `;

        // 5. Transaction Details Query
        const transactionDetailsQuery = `
            SELECT 
                COUNT(DISTINCT s.id) as total_transactions,
                COUNT(DISTINCT CASE WHEN s.payment_status = 'paid' THEN s.id END) as paid_transactions,
                COUNT(DISTINCT CASE WHEN s.payment_status = 'pending' THEN s.id END) as pending_transactions,
                COUNT(DISTINCT CASE WHEN s.payment_status = 'cancelled' THEN s.id END) as cancelled_transactions,
                COUNT(DISTINCT CASE WHEN s.payment_status = 'refunded' THEN s.id END) as refunded_transactions,
                COUNT(DISTINCT s.customer_id) as unique_customers,
                CAST(COALESCE(MAX(s.total_amount), 0) AS DECIMAL(10,2)) as highest_transaction,
                CAST(COALESCE(MIN(CASE WHEN s.total_amount > 0 THEN s.total_amount END), 0) AS DECIMAL(10,2)) as lowest_transaction
            FROM sales s
            WHERE s.branch_id = ?
            ${dateCondition}
        `;

        // Execute all queries in parallel
        const [
            salesSummaryResults,
            profitResults,
            topProductsResults,
            topCategoriesResults,
            transactionDetailsResults
        ] = await Promise.all([
            db.pool.query(salesSummaryQuery, [...params]),
            db.pool.query(profitQuery, [...params]),
            db.pool.query(topProductsQuery, [...params]),
            db.pool.query(topCategoriesQuery, [...params]),
            db.pool.query(transactionDetailsQuery, [...params])
        ]);

        // Format the response
        const report = {
            summary: {
                sales: salesSummaryResults[0][0],
                profit: profitResults[0][0],
                transactions: transactionDetailsResults[0][0]
            },
            top_products: topProductsResults[0],
            top_categories: topCategoriesResults[0],
            report_period: {
                start_date: startDate || 'All time',
                end_date: endDate || 'Present',
                branch_id: branchId
            }
        };

        res.json(report);
    } catch (error) {
        console.error('Error fetching pharmacy reports:', error);
        res.status(500).json({ 
            message: 'Error fetching pharmacy reports',
            error: error.message 
        });
    }
};

// Additional endpoint for detailed product performance
const getProductPerformance = async (req, res) => {
    try {
        const { branchId, startDate, endDate, limit = 10 } = req.query;

        if (!branchId) {
            return res.status(400).json({ error: 'Branch ID is required' });
        }

        const params = [branchId];
        const dateCondition = startDate && endDate 
            ? `AND ${getConvertTZString('s.created_at')} BETWEEN ? AND ?`
            : '';
        
        if (startDate && endDate) {
            params.push(startDate, endDate);
        }

        params.push(parseInt(limit));

        const productPerformanceQuery = `
            SELECT 
                p.id,
                p.name,
                p.brand_name,
                p.barcode,
                c.name as category_name,
                SUM(si.quantity) as total_quantity_sold,
                CAST(SUM(si.total_price) AS DECIMAL(10,2)) as total_revenue,
                CAST(AVG(si.unit_price) AS DECIMAL(10,2)) as average_selling_price,
                COUNT(DISTINCT s.id) as transaction_count,
                COUNT(DISTINCT DATE(${getConvertTZString('s.created_at')})) as active_days,
                CAST(SUM(si.quantity) / COUNT(DISTINCT DATE(${getConvertTZString('s.created_at')})) AS DECIMAL(10,2)) as avg_daily_quantity,
                p.current_stock_level,
                CASE 
                    WHEN p.current_stock_level <= p.critical THEN 'Low Stock'
                    WHEN p.current_stock_level <= (p.critical * 2) THEN 'Medium Stock'
                    ELSE 'Good Stock'
                END as stock_status
            FROM sales s
            INNER JOIN sale_items si ON s.id = si.sale_id
            INNER JOIN products p ON si.product_id = p.id
            INNER JOIN category c ON p.category = c.category_id
            WHERE s.branch_id = ? 
            AND s.payment_status = 'paid'
            AND p.is_active = 1
            ${dateCondition}
            GROUP BY p.id, p.name, p.brand_name, p.barcode, c.name, p.current_stock_level, p.critical
            ORDER BY total_revenue DESC
            LIMIT ?
        `;

        const [results] = await db.pool.query(productPerformanceQuery, params);

        res.json({
            products: results,
            total_products: results.length,
            report_period: {
                start_date: startDate || 'All time',
                end_date: endDate || 'Present',
                branch_id: branchId
            }
        });
    } catch (error) {
        console.error('Error fetching product performance:', error);
        res.status(500).json({ 
            message: 'Error fetching product performance',
            error: error.message 
        });
    }
};

// Additional endpoint for category analysis
const getCategoryAnalysis = async (req, res) => {
    try {
        const { branchId, startDate, endDate } = req.query;

        if (!branchId) {
            return res.status(400).json({ error: 'Branch ID is required' });
        }

        const params = [branchId];
        const dateCondition = startDate && endDate 
            ? `AND ${getConvertTZString('s.created_at')} BETWEEN ? AND ?`
            : '';
        
        if (startDate && endDate) {
            params.push(startDate, endDate);
        }

        const categoryAnalysisQuery = `
            SELECT 
                c.category_id,
                c.name as category_name,
                c.prefix,
                COUNT(DISTINCT p.id) as total_products_in_category,
                COUNT(DISTINCT CASE WHEN si.id IS NOT NULL THEN p.id END) as products_sold,
                SUM(COALESCE(si.quantity, 0)) as total_quantity_sold,
                CAST(SUM(COALESCE(si.total_price, 0)) AS DECIMAL(10,2)) as total_revenue,
                CAST(AVG(CASE WHEN si.id IS NOT NULL THEN si.unit_price END) AS DECIMAL(10,2)) as avg_selling_price,
                COUNT(DISTINCT s.id) as transaction_count,
                CAST(
                    (COUNT(DISTINCT CASE WHEN si.id IS NOT NULL THEN p.id END) * 100.0 / 
                     COUNT(DISTINCT p.id)) AS DECIMAL(5,2)
                ) as sell_through_rate_percentage
            FROM category c
            LEFT JOIN products p ON c.category_id = p.category AND p.is_active = 1
            LEFT JOIN sale_items si ON p.id = si.product_id
            LEFT JOIN sales s ON si.sale_id = s.id AND s.branch_id = ? AND s.payment_status = 'paid'
            WHERE c.is_active = 1
            ${dateCondition.replace('s.created_at', 's.created_at')}
            GROUP BY c.category_id, c.name, c.prefix
            ORDER BY total_revenue DESC
        `;

        const [results] = await db.pool.query(categoryAnalysisQuery, params);

        res.json({
            categories: results,
            total_categories: results.length,
            report_period: {
                start_date: startDate || 'All time',
                end_date: endDate || 'Present',
                branch_id: branchId
            }
        });
    } catch (error) {
        console.error('Error fetching category analysis:', error);
        res.status(500).json({ 
            message: 'Error fetching category analysis',
            error: error.message 
        });
    }
};

module.exports = {
    getTransactionFilter,
    getAllTransactions,
    getTransactionSummary,
    getLatestTransactions,
    getKeyMetrics,
    getAllBranchesTransactions,
    updateInvoiceNumber,
    getTransactionItems,
    getPharmacyReports,
    getProductPerformance,
    getCategoryAnalysis
}; 

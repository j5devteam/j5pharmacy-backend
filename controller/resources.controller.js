// Check if session has any saved products in stock_session_products
const checkSessionProductsExist = async (req, res) => {
    const { reference } = req.query;
    if (!reference) {
        return res.status(400).json({ exists: false, message: 'Missing session reference' });
    }
    try {
        // Get session_id from stock_review_history by reference
        const [sessionRows] = await db.pool.query(
            'SELECT id FROM stock_review_history WHERE reference = ? LIMIT 1',
            [reference]
        );
        if (!sessionRows.length) {
            return res.status(404).json({ exists: false, message: 'Session not found' });
        }
        const sessionId = sessionRows[0].id;
        // Check if any products exist for this session
        const [rows] = await db.pool.query(
            'SELECT COUNT(*) as count FROM stock_session_products WHERE session_id = ?',
            [sessionId]
        );
        const count = rows[0]?.count || 0;
        res.json({ exists: count > 0, count });
    } catch (error) {
        console.error('[StockReview] Error checking session products exist:', error);
        res.status(500).json({ exists: false, message: 'Error checking session products' });
    }
};
const db = require('../config/database');
const { getMySQLTimestamp } = require('../utils/timeZoneUtil');

// Supplier Management
const getAllSuppliers = async (req, res) => {
    try {
        const [suppliers] = await db.pool.query(
            `SELECT * FROM suppliers 
             WHERE is_active = 1 AND (is_archived IS NULL OR is_archived = 0) 
             ORDER BY supplier_name`
        );
        console.log('Fetched all active suppliers');
        res.json(suppliers);
    } catch (error) {
        console.error('Error fetching suppliers:', error);
        res.status(500).json({ message: 'Error fetching suppliers' });
    }
};

const addSupplier = async (req, res) => {
    const { supplier_name, contact_person, email, phone, address } = req.body;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        // Insert new supplier
        const [result] = await connection.query(
            `INSERT INTO suppliers 
             (supplier_name, contact_person, email, phone, address, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ${getMySQLTimestamp()}, ${getMySQLTimestamp()})`,
            [supplier_name, contact_person, email, phone, address]
        );

        await connection.commit();
        console.log('Added new supplier:', {
            supplier_id: result.insertId,
            supplier_name,
            contact_person,
            email,
            phone,
            address
        });
        res.json({
            message: 'Supplier added successfully',
            supplier_id: result.insertId
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error adding supplier:', error);
        res.status(500).json({ message: 'Error adding supplier' });
    } finally {
        connection.release();
    }
};

const updateSupplier = async (req, res) => {
    const { supplier_id } = req.params;
    const { supplier_name, contact_person, email, phone, address } = req.body;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        await connection.query(
            `UPDATE suppliers 
             SET supplier_name = ?, 
                 contact_person = ?, 
                 email = ?, 
                 phone = ?, 
                 address = ?,
                 updated_at = ${getMySQLTimestamp()}
             WHERE supplier_id = ?`,
            [supplier_name, contact_person, email, phone, address, supplier_id]
        );

        await connection.commit();
        console.log('Updated supplier:', {
            supplier_id,
            supplier_name,
            contact_person,
            email,
            phone,
            address
        });
        res.json({ message: 'Supplier updated successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('Error updating supplier:', error);
        res.status(500).json({ message: 'Error updating supplier' });
    } finally {
        connection.release();
    }
};

const deleteSupplier = async (req, res) => {
    const { supplier_id } = req.params;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        // Soft delete by setting is_active to 0
        await connection.query(
            `UPDATE suppliers 
             SET is_active = 0,
                 updated_at = ${getMySQLTimestamp()}
             WHERE supplier_id = ?`,
            [supplier_id]
        );

        await connection.commit();
        console.log('Deleted supplier:', { supplier_id });
        res.json({ message: 'Supplier deleted successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('Error deleting supplier:', error);
        res.status(500).json({ message: 'Error deleting supplier' });
    } finally {
        connection.release();
    }
};

// Get suppliers for a specific product
const getProductSuppliers = async (req, res) => {
    const { product_id } = req.params;
    try {
        const [suppliers] = await db.pool.query(
            `SELECT ps.*, s.supplier_name, s.contact_person, s.email, s.phone, 
                    p.name as product_name, p.brand_name
             FROM product_suppliers ps
             JOIN suppliers s ON ps.supplier_id = s.supplier_id
             JOIN products p ON ps.product_id = p.id
             WHERE ps.product_id = ? AND ps.is_active = 1 AND p.is_active = 1
             ORDER BY ps.is_preferred DESC, s.supplier_name`,
            [product_id]
        );
        console.log('Fetched suppliers for product:', product_id);
        res.json(suppliers);
    } catch (error) {
        console.error('Error fetching product suppliers:', error);
        res.status(500).json({ message: 'Error fetching product suppliers' });
    }
};

// Add supplier to a product
const addProductSupplier = async (req, res) => {
    const { product_id } = req.params;
    const { supplier_id, supplier_price, ceiling_price, is_preferred } = req.body;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        // If this supplier is set as preferred, unset any existing preferred supplier
        if (is_preferred) {
            await connection.query(
                `UPDATE product_suppliers 
                 SET is_preferred = 0, 
                     updated_at = ${getMySQLTimestamp()}
                 WHERE product_id = ?`,
                [product_id]
            );
        }

        // Add new product supplier
        const [result] = await connection.query(
            `INSERT INTO product_suppliers 
             (product_id, supplier_id, supplier_price, ceiling_price, is_preferred, last_supply_date, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ${getMySQLTimestamp()}, ${getMySQLTimestamp()}, ${getMySQLTimestamp()})`,
            [product_id, supplier_id, supplier_price, ceiling_price, is_preferred]
        );

        // If this is the preferred supplier, update the product's current supplier
        if (is_preferred) {
            await connection.query(
                `UPDATE products 
                 SET current_supplier_id = ?, 
                     updatedAt = ${getMySQLTimestamp()}
                 WHERE id = ?`,
                [supplier_id, product_id]
            );
        }

        // Add to price history
        await connection.query(
            `INSERT INTO price_history 
             (product_id, product_supplier_id, supplier_price, ceiling_price, unit_price, markup_percentage, effective_date, created_at)
             SELECT ?, ?, ?, ?, p.price, p.markup_percentage, ${getMySQLTimestamp()}, ${getMySQLTimestamp()}
             FROM products p WHERE p.id = ?`,
            [product_id, result.insertId, supplier_price, ceiling_price, product_id]
        );

        await connection.commit();
        console.log('Added supplier to product:', product_id);
        res.json({
            id: result.insertId,
            message: 'Product supplier added successfully'
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error adding product supplier:', error);
        res.status(500).json({ message: 'Error adding product supplier' });
    } finally {
        connection.release();
    }
};

// Update product supplier
const updateProductSupplier = async (req, res) => {
    const { product_supplier_id } = req.params;
    const { supplier_price, ceiling_price, is_preferred } = req.body;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        // Get product_id and supplier_id
        const [supplierInfo] = await connection.query(
            'SELECT product_id, supplier_id FROM product_suppliers WHERE product_supplier_id = ?',
            [product_supplier_id]
        );

        if (supplierInfo.length === 0) {
            throw new Error('Product supplier not found');
        }

        // If setting as preferred, unset any existing preferred supplier
        if (is_preferred) {
            await connection.query(
                `UPDATE product_suppliers 
                 SET is_preferred = 0,
                     updated_at = ${getMySQLTimestamp()}
                 WHERE product_id = ?`,
                [supplierInfo[0].product_id]
            );
        }

        // Update product supplier
        await connection.query(
            `UPDATE product_suppliers 
             SET supplier_price = ?, 
                 ceiling_price = ?,
                 is_preferred = ?,
                 last_supply_date = ${getMySQLTimestamp()},
                 updated_at = ${getMySQLTimestamp()}
             WHERE product_supplier_id = ?`,
            [supplier_price, ceiling_price, is_preferred, product_supplier_id]
        );

        // If this is the preferred supplier, update the product's current supplier
        if (is_preferred) {
            await connection.query(
                `UPDATE products 
                 SET current_supplier_id = ?,
                     updatedAt = ${getMySQLTimestamp()}
                 WHERE id = ?`,
                [supplierInfo[0].supplier_id, supplierInfo[0].product_id]
            );
        }

        // Add to price history
        await connection.query(
            `INSERT INTO price_history 
             (product_id, product_supplier_id, supplier_price, ceiling_price, unit_price, markup_percentage, effective_date, created_at)
             SELECT p.id, ?, ?, ?, p.price, p.markup_percentage, ${getMySQLTimestamp()}, ${getMySQLTimestamp()}
             FROM products p 
             WHERE p.id = ?`,
            [product_supplier_id, supplier_price, ceiling_price, supplierInfo[0].product_id]
        );

        await connection.commit();
        console.log('Updated product supplier:', product_supplier_id);
        res.json({ message: 'Product supplier updated successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('Error updating product supplier:', error);
        res.status(500).json({ message: 'Error updating product supplier' });
    } finally {
        connection.release();
    }
};

// Remove supplier from product
const removeProductSupplier = async (req, res) => {
    const { product_supplier_id } = req.params;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        // Get product info before removal
        const [supplierInfo] = await connection.query(
            'SELECT product_id, supplier_id, is_preferred FROM product_suppliers WHERE product_supplier_id = ?',
            [product_supplier_id]
        );

        if (supplierInfo.length === 0) {
            throw new Error('Product supplier not found');
        }

        // Soft delete the product supplier
        await connection.query(
            `UPDATE product_suppliers 
             SET is_active = 0,
                 updated_at = ${getMySQLTimestamp()}
             WHERE product_supplier_id = ?`,
            [product_supplier_id]
        );

        // If this was the preferred supplier, update the product's current supplier
        if (supplierInfo[0].is_preferred) {
            // Find the next available supplier
            const [nextSupplier] = await connection.query(
                `SELECT supplier_id FROM product_suppliers 
                 WHERE product_id = ? AND is_active = 1 
                 ORDER BY supplier_price ASC LIMIT 1`,
                [supplierInfo[0].product_id]
            );

            await connection.query(
                `UPDATE products 
                 SET current_supplier_id = ?,
                     updatedAt = ${getMySQLTimestamp()}
                 WHERE id = ?`,
                [nextSupplier.length > 0 ? nextSupplier[0].supplier_id : null, supplierInfo[0].product_id]
            );
        }

        await connection.commit();
        console.log('Removed supplier from product:', product_supplier_id);
        res.json({ message: 'Product supplier removed successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('Error removing product supplier:', error);
        res.status(500).json({ message: 'Error removing product supplier' });
    } finally {
        connection.release();
    }
};

// Get price history for a product (including all suppliers)
const getProductPriceHistory = async (req, res) => {
    const { product_id } = req.params;
    try {
        const [history] = await db.pool.query(
            `SELECT ph.*, ps.supplier_id, s.supplier_name, 
                    p.name as product_name, p.brand_name
             FROM price_history ph
             JOIN product_suppliers ps ON ph.product_supplier_id = ps.product_supplier_id
             JOIN suppliers s ON ps.supplier_id = s.supplier_id
             JOIN products p ON ph.product_id = p.id
             WHERE ph.product_id = ? AND p.is_active = 1
             ORDER BY ph.effective_date DESC`,
            [product_id]
        );
        console.log('Fetched price history for product:', product_id);
        res.json(history);
    } catch (error) {
        console.error('Error fetching price history:', error);
        res.status(500).json({ message: 'Error fetching price history' });
    }
};

// Calculate and update product price based on supplier prices
const calculateProductPrice = async (req, res) => {
    const { product_id } = req.params;
    const { markup_percentage } = req.body;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        // Get current supplier's price and ceiling price
        const [supplierInfo] = await connection.query(
            `SELECT ps.supplier_price, ps.ceiling_price, 
                    p.name as product_name, p.brand_name
             FROM product_suppliers ps
             JOIN products p ON ps.product_id = p.id
             WHERE p.id = ? AND ps.is_active = 1 AND p.is_active = 1
             AND ps.supplier_id = p.current_supplier_id`,
            [product_id]
        );

        if (supplierInfo.length === 0) {
            throw new Error('No active supplier found for product');
        }

        const supplier_price = supplierInfo[0].supplier_price;
        const ceiling_price = supplierInfo[0].ceiling_price;

        // Calculate new unit price
        let unit_price = supplier_price * (1 + markup_percentage / 100);

        // Check against ceiling price if it exists
        if (ceiling_price && unit_price > ceiling_price) {
            unit_price = ceiling_price;
        }

        // Update product price
        await connection.query(
            `UPDATE products 
             SET price = ?,
                 markup_percentage = ?,
                 updatedAt = ${getMySQLTimestamp()}
             WHERE id = ?`,
            [unit_price, markup_percentage, product_id]
        );

        await connection.commit();
        console.log('Updated product price calculation for:', supplierInfo[0].product_name);
        res.json({
            unit_price,
            markup_percentage,
            message: 'Product price updated successfully'
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error calculating product price:', error);
        res.status(500).json({ message: 'Error calculating product price' });
    } finally {
        connection.release();
    }
};

// Add getCategories function
const getCategories = async (req, res) => {
    const connection = await db.pool.getConnection();

    try {
        const [categories] = await connection.query(
            `SELECT 
                category_id,
                name,
                prefix
             FROM category 
             WHERE is_active = 1 
             ORDER BY name ASC`
        );

        console.log('Fetched categories:', categories.length);
        res.json(categories);
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({ message: 'Error fetching categories' });
    } finally {
        connection.release();
    }
};

// Update validateBulkImport function to check for duplicate barcodes
const validateBulkImport = async (req, res) => {
    const { products, importType, branchId } = req.body;
    console.log(`[BulkImport] Starting validation for ${products.length} products. Import type: ${importType}`);

    const validatedProducts = [];
    const connection = await db.pool.getConnection();
    const barcodeMap = new Map(); // Track duplicate barcodes

    try {
        // Single pass: Validate each product and check for duplicates
        console.log('[BulkImport] Starting product validation...');
        for (let i = 0; i < products.length; i++) {
            const product = products[i];
            console.log(`[BulkImport] Validating product: ${product.name} (${product.barcode})`);

            let matchedProduct = null;
            let similarProducts = [];
            let status = 'pending';
            let errors = [];
            let currentStock = 0;

            // Check for duplicate barcodes
            if (product.barcode) {
                if (barcodeMap.has(product.barcode)) {
                    console.log(`[BulkImport] Found duplicate barcode: ${product.barcode}`);
                    status = 'invalid';
                    errors = ['Duplicate barcode in import file'];

                    // Also mark the first occurrence as invalid
                    const duplicateIndex = barcodeMap.get(product.barcode);
                    validatedProducts[duplicateIndex].status = 'invalid';
                    validatedProducts[duplicateIndex].errors = ['Duplicate barcode in import file'];
                } else {
                    barcodeMap.set(product.barcode, i);
                }
            }

            if (status !== 'invalid') {
                // First, try to find by barcode and lot number (if lot number is provided)
                if (product.barcode) {
                    console.log(`[BulkImport] Searching for barcode match: ${product.barcode}, lot: ${product.lot_number || 'none'}`);

                    let barcodeMatch;
                    if (product.lot_number && product.lot_number.trim() !== '') {
                        // Check for exact match with both barcode and lot number in batch_items
                        // Use INNER JOIN to ensure lot number must exist
                        [barcodeMatch] = await connection.query(
                            `SELECT p.*, c.name as category_name,
                                    bi.stock as current_stock, bit.lot_number
                             FROM products p
                             LEFT JOIN category c ON p.category = c.category_id
                             LEFT JOIN branch_inventory bi ON p.id = bi.product_id 
                                AND bi.branch_id = ? AND bi.is_active = 1
                             INNER JOIN batch_items bit ON p.id = bit.product_id
                                AND bit.lot_number = ?
                             WHERE p.barcode = ? AND p.is_active = 1`,
                            [branchId, product.lot_number, product.barcode]
                        );
                    } else {
                        // Check for barcode only (original logic)
                        [barcodeMatch] = await connection.query(
                            `SELECT p.*, c.name as category_name,
                                    bi.stock as current_stock
                             FROM products p
                             LEFT JOIN category c ON p.category = c.category_id
                             LEFT JOIN branch_inventory bi ON p.id = bi.product_id 
                                AND bi.branch_id = ? AND bi.is_active = 1
                             WHERE p.barcode = ? AND p.is_active = 1`,
                            [branchId, product.barcode]
                        );
                    }
                    if (barcodeMatch.length > 0) {
                        const matchType = product.lot_number && product.lot_number.trim() !== '' ? 'barcode and lot number' : 'barcode only';
                        console.log(`[BulkImport] Found exact ${matchType} match for: ${product.barcode}${product.lot_number ? ` (lot: ${product.lot_number})` : ''}`);
                        matchedProduct = barcodeMatch[0];
                        currentStock = matchedProduct.current_stock || 0;
                        status = 'matched';
                    } else {
                        const searchType = product.lot_number && product.lot_number.trim() !== '' ? 'barcode and lot number' : 'barcode only';
                        console.log(`[BulkImport] No ${searchType} match found for: ${product.barcode}${product.lot_number ? ` (lot: ${product.lot_number})` : ''}`);
                    }
                }

                // If no barcode match and importType allows new products, search by name
                if (!matchedProduct && product.name) {
                    console.log(`[BulkImport] No barcode match found, searching for similar products by name: ${product.name}`);
                    console.log(`[BulkImport] matchedProduct status:`, matchedProduct);
                    console.log(`[BulkImport] product.name:`, product.name);
                    console.log(`[BulkImport] branchId:`, branchId);

                    const searchTerm = `%${product.name}%`;
                    const [nameMatches] = await connection.query(
                        `SELECT p.*, c.name as category_name,
                                bi.stock as current_stock
                         FROM products p
                         LEFT JOIN category c ON p.category = c.category_id
                         LEFT JOIN branch_inventory bi ON p.id = bi.product_id 
                            AND bi.branch_id = ? AND bi.is_active = 1
                         WHERE (p.name LIKE ? OR p.brand_name LIKE ?) 
                         AND p.is_active = 1
                         LIMIT 5`,
                        [branchId, searchTerm, searchTerm]
                    );

                    console.log(`[BulkImport] Name search query executed with params:`, [branchId, searchTerm, searchTerm]);
                    console.log(`[BulkImport] Name search results:`, nameMatches);

                    if (nameMatches.length > 0) {
                        console.log(`[BulkImport] Found ${nameMatches.length} similar products for: ${product.name}`);
                        similarProducts = nameMatches;
                        status = 'similar';
                    } else if (importType === 'all') {
                        console.log(`[BulkImport] No matches found, marking as new product: ${product.name}`);
                        status = 'new';
                    } else {
                        console.log(`[BulkImport] No matches found, marking as invalid: ${product.name}`);
                        status = 'invalid';
                        errors.push('Product not found in database');
                    }
                } else {
                    console.log(`[BulkImport] Skipping name search - matchedProduct:`, !!matchedProduct, 'product.name:', !!product.name);
                }
            }

            validatedProducts.push({
                ...product,
                status,
                errors,
                matchedProduct,
                similarProducts,
                currentStock,
                importedData: {
                    name: product.name,
                    brand_name: product.brand_name,
                    lot_number: product.lot_number
                },
                packaged_by_box: product.packaged_by_box === true,
                pieces_per_box: product.pieces_per_box || null,
                calculated_unit_price: product.calculated_unit_price || null
            });
        }

        const statusCounts = validatedProducts.reduce((acc, product) => {
            acc[product.status] = (acc[product.status] || 0) + 1;
            return acc;
        }, {});

        validatedProducts.forEach(p => {
            console.log(`  ${p.name}: packaged_by_box=${p.packaged_by_box}, pieces_per_box=${p.pieces_per_box}, original_packaged_by_box=${p.packaged_by_box === true}`);
        });

        res.json(validatedProducts);
    } catch (error) {
        console.error('[BulkImport] Error validating bulk import:', error);
        res.status(500).json({ message: 'Error validating bulk import' });
    } finally {
        connection.release();
    }
};

const searchProduct = async (req, res) => {
    const { query, page = 0, limit = 5 } = req.query;
    try {
        // Get total count
        const [countResult] = await db.pool.query(
            `SELECT COUNT(*) as total
                FROM products p
                LEFT JOIN category c ON p.category = c.category_id
             WHERE (p.name LIKE ? OR p.brand_name LIKE ? OR p.barcode LIKE ?)
             AND p.is_active = 1`,
            [`%${query}%`, `%${query}%`, `%${query}%`]
        );

        // Get paginated results
        const [products] = await db.pool.query(
            `SELECT p.*, c.name as category_name
                FROM products p
                LEFT JOIN category c ON p.category = c.category_id
             WHERE (p.name LIKE ? OR p.brand_name LIKE ? OR p.barcode LIKE ?)
             AND p.is_active = 1
             ORDER BY p.name
             LIMIT ? OFFSET ?`,
            [`%${query}%`, `%${query}%`, `%${query}%`, parseInt(limit), parseInt(page) * parseInt(limit)]
        );

        res.json({
            products,
            total: countResult[0].total
        });
    } catch (error) {
        console.error('Error searching products:', error);
        res.status(500).json({ message: 'Error searching products' });
    }
};

// Check if a specific barcode already exists in the system
const checkBarcodeExists = async (req, res) => {
    const { barcode, lotNumber, branchId } = req.query;

    if (!barcode) {
        return res.status(400).json({ message: 'Barcode parameter is required' });
    }

    try {
        console.log('[BarcodeCheck] Checking barcode:', barcode, 'lot:', lotNumber || 'none', 'branch:', branchId);

        let products;
        if (lotNumber && lotNumber.trim() !== '' && branchId) {
            // Check for exact match with both barcode and lot number in batch_items
            [products] = await db.pool.query(
                `SELECT p.*, c.name as category_name,
                        bi.stock as current_stock, bit.lot_number
                 FROM products p
                 LEFT JOIN category c ON p.category = c.category_id
                 LEFT JOIN branch_inventory bi ON p.id = bi.product_id 
                    AND bi.branch_id = ? AND bi.is_active = 1
                 INNER JOIN batch_items bit ON p.id = bit.product_id
                    AND bit.lot_number = ?
                 WHERE p.barcode = ? AND p.is_active = 1
                 LIMIT 1`,
                [branchId, lotNumber, barcode]
            );
        } else {
            // Check for barcode only (original logic)
            [products] = await db.pool.query(
                `SELECT p.*, c.name as category_name,
                        ${branchId ? 'bi.stock as current_stock' : '0 as current_stock'}
                 FROM products p
                 LEFT JOIN category c ON p.category = c.category_id
                 ${branchId ? 'LEFT JOIN branch_inventory bi ON p.id = bi.product_id AND bi.branch_id = ? AND bi.is_active = 1' : ''}
                 WHERE p.barcode = ? AND p.is_active = 1
                 LIMIT 1`,
                branchId ? [branchId, barcode] : [barcode]
            );
        }

        if (products.length > 0) {
            const matchType = lotNumber && lotNumber.trim() !== '' ? 'barcode and lot number' : 'barcode only';
            console.log(`[BarcodeCheck] Found exact ${matchType} match for: ${barcode}${lotNumber ? ` (lot: ${lotNumber})` : ''}`);
            res.json({
                exists: true,
                status: 'matched',
                product: products[0],
                currentStock: products[0].current_stock || 0
            });
        } else {
            const searchType = lotNumber && lotNumber.trim() !== '' ? 'barcode and lot number' : 'barcode only';
            console.log(`[BarcodeCheck] No ${searchType} match found for: ${barcode}${lotNumber ? ` (lot: ${lotNumber})` : ''}`);
            res.json({
                exists: false,
                status: 'new',
                product: null,
                currentStock: 0
            });
        }
    } catch (error) {
        console.error('[BarcodeCheck] Error checking barcode:', error);
        res.status(500).json({ message: 'Error checking barcode' });
    }
};

// Comprehensive validation that checks both barcode and name similarity
const checkProductMatch = async (req, res) => {
    const { barcode, lotNumber, branchId, productName } = req.query;

    if (!barcode && !productName) {
        return res.status(400).json({ message: 'Either barcode or productName parameter is required' });
    }

    try {
        console.log('[ProductCheck] Checking product:', { barcode, lotNumber: lotNumber || 'none', productName, branchId });

        let matchedProduct = null;
        let similarProducts = [];
        let status = 'new';
        let currentStock = 0;

        // First, try to find by barcode and lot number (if provided)
        if (barcode) {
            let products;
            if (lotNumber && lotNumber.trim() !== '' && branchId) {
                // Check for exact match with both barcode and lot number
                [products] = await db.pool.query(
                    `SELECT p.*, c.name as category_name,
                            bi.stock as current_stock, bit.lot_number
                     FROM products p
                     LEFT JOIN category c ON p.category = c.category_id
                     LEFT JOIN branch_inventory bi ON p.id = bi.product_id 
                        AND bi.branch_id = ? AND bi.is_active = 1
                     INNER JOIN batch_items bit ON p.id = bit.product_id
                        AND bit.lot_number = ?
                     WHERE p.barcode = ? AND p.is_active = 1
                     LIMIT 1`,
                    [branchId, lotNumber, barcode]
                );
            } else {
                // Check for barcode only
                [products] = await db.pool.query(
                    `SELECT p.*, c.name as category_name,
                            ${branchId ? 'bi.stock as current_stock' : '0 as current_stock'}
                     FROM products p
                     LEFT JOIN category c ON p.category = c.category_id
                     ${branchId ? 'LEFT JOIN branch_inventory bi ON p.id = bi.product_id AND bi.branch_id = ? AND bi.is_active = 1' : ''}
                     WHERE p.barcode = ? AND p.is_active = 1
                     LIMIT 1`,
                    branchId ? [branchId, barcode] : [barcode]
                );
            }

            if (products.length > 0) {
                const matchType = lotNumber && lotNumber.trim() !== '' ? 'barcode and lot number' : 'barcode only';
                console.log(`[ProductCheck] Found exact ${matchType} match for: ${barcode}${lotNumber ? ` (lot: ${lotNumber})` : ''}`);
                matchedProduct = products[0];
                currentStock = matchedProduct.current_stock || 0;
                status = 'matched';
            }
        }

        // If no barcode match and productName provided, search by name
        if (!matchedProduct && productName && branchId) {
            console.log(`[ProductCheck] Searching for similar products by name: ${productName}`);
            const searchTerm = `%${productName}%`;
            const [nameMatches] = await db.pool.query(
                `SELECT p.*, c.name as category_name,
                        bi.stock as current_stock
                 FROM products p
                 LEFT JOIN category c ON p.category = c.category_id
                 LEFT JOIN branch_inventory bi ON p.id = bi.product_id 
                    AND bi.branch_id = ? AND bi.is_active = 1
                 WHERE (p.name LIKE ? OR p.brand_name LIKE ?) 
                 AND p.is_active = 1
                 LIMIT 5`,
                [branchId, searchTerm, searchTerm]
            );

            if (nameMatches.length > 0) {
                console.log(`[ProductCheck] Found ${nameMatches.length} similar products for: ${productName}`);
                similarProducts = nameMatches;
                status = 'similar';
            }
        }

        res.json({
            status,
            matchedProduct,
            similarProducts,
            currentStock
        });
    } catch (error) {
        console.error('[ProductCheck] Error checking product:', error);
        res.status(500).json({ message: 'Error checking product' });
    }
};

// Add a new function to generate batch numbers
const generateBatchNumber = async (connection) => {
    try {
        const currentDate = new Date();
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth() + 1;

        // Check if we have a sequence for this year and month
        const [sequence] = await connection.query(
            `SELECT * FROM batch_sequence 
             WHERE year = ? AND month = ?`,
            [year, month]
        );

        let sequenceNumber;

        if (sequence.length === 0) {
            // Create a new sequence for this year and month
            const [result] = await connection.query(
                `INSERT INTO batch_sequence (prefix, current_number, year, month)
                 VALUES ('BATCH', 1, ?, ?)`,
                [year, month]
            );
            sequenceNumber = 1;
        } else {
            // Increment the existing sequence
            sequenceNumber = sequence[0].current_number + 1;
            await connection.query(
                `UPDATE batch_sequence 
                 SET current_number = ?
                 WHERE id = ?`,
                [sequenceNumber, sequence[0].id]
            );
        }

        // Format: BATCH-YYYYMM-XXXX
        const batchNumber = `BATCH-${year}${month.toString().padStart(2, '0')}-${sequenceNumber.toString().padStart(4, '0')}`;

        return batchNumber;
    } catch (error) {
        console.error('Error generating batch number:', error);
        throw error;
    }
};

// Modify the processBulkImport function to handle batch information
const processBulkImport = async (req, res) => {
    const { products, branch_id, batch_info } = req.body;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        const userId = req.user.userId;
        console.log('Processing bulk import by user:', userId);

        // Handle receipt image URL if provided
        let receiptImageUrl = batch_info.receipt_image_url || null;
        if (receiptImageUrl) {
            console.log('Receipt image URL provided:', receiptImageUrl);
        }

        // Create a new batch record
        let batchNumber = batch_info.batch_number;
        let orderNumber = batch_info.order_number || null;
        let batchId;

        // If no batch number provided, generate one
        if (!batchNumber) {
            batchNumber = await generateBatchNumber(connection);
        }

        // Insert the batch record (store receipt URL in notes for now since the table doesn't have a receipt_url field)
        const notesWithReceipt = batch_info.notes ?
            `${batch_info.notes}${receiptImageUrl ? `\nReceipt: ${receiptImageUrl}` : ''}` :
            (receiptImageUrl ? `Receipt: ${receiptImageUrl}` : null);

        // Handle "No Supplier" case (supplier_id = 0)
        const supplierId = batch_info.supplier_id === 0 ? null : batch_info.supplier_id;

        const [batchResult] = await connection.query(
            `INSERT INTO batches 
             (batch_number, order_number, supplier_id, received_date, notes, created_by, created_at)
             VALUES (?, ?, ?, ${getMySQLTimestamp(batch_info.received_date)}, ?, ?, ${getMySQLTimestamp()})`,
            [batchNumber, orderNumber, supplierId, notesWithReceipt, userId]
        );

        batchId = batchResult.insertId;
        console.log(`Created new batch: ${batchNumber} (ID: ${batchId})`);

        for (const product of products) {
            // unit_cost from import becomes supplier_price in our system
            const supplier_price = product.unit_cost || 0;

            console.log('Processing product packaging data:', {
                product_name: product.name,
                received_packaging_fields: {
                    enable_packaging_conversion: product.enable_packaging_conversion,
                    pieces_per_packaging: product.pieces_per_packaging,
                    packaging_unit: product.packaging_unit,
                    price_per_packaging: product.price_per_packaging,
                    quantity_in_packaging_units: product.quantity_in_packaging_units,
                    total_pieces: product.total_pieces
                }
            });

            if (product.status === 'matched') {
                // Get the product_id from matchedProduct
                const product_id = product.matchedProduct.id;

                // Update packaging information if provided
                if (product.packaged_by_box !== undefined) {
                    const enable_packaging_conversion = product.enable_packaging_conversion || false;
                    const pieces_per_packaging = product.pieces_per_packaging || 1;
                    const packaging_unit = product.packaging_unit || (enable_packaging_conversion ? 'Box' : 'Piece');
                    const price_per_packaging = product.price_per_packaging || (enable_packaging_conversion ? supplier_price : null);

                    await connection.query(
                        `UPDATE products 
                         SET enable_packaging_conversion = ?, packaging_unit = ?, pieces_per_box = ?,
                             price_per_packaging = ?, updatedAt = ${getMySQLTimestamp()}
                         WHERE id = ?`,
                        [enable_packaging_conversion, packaging_unit, pieces_per_packaging, price_per_packaging, product_id]
                    );

                    console.log(`Updated packaging info for product ${product_id}: enable_packaging_conversion=${enable_packaging_conversion}, pieces_per_packaging=${pieces_per_packaging}`);
                }

                // Only create/update supplier relationship if a supplier was selected
                let productSupplierId = null;
                if (supplierId) {
                    // Check/Create product_suppliers relationship
                    const [existingSupplier] = await connection.query(
                        `SELECT product_supplier_id FROM product_suppliers 
                         WHERE product_id = ? AND supplier_id = ? AND is_active = 1`,
                        [product_id, supplierId]
                    );

                    if (existingSupplier.length === 0) {
                        // Create new product_suppliers relationship
                        const [supplierResult] = await connection.query(
                            `INSERT INTO product_suppliers 
                             (product_id, supplier_id, supplier_price, is_preferred, last_supply_date, created_at, updated_at)
                             VALUES (?, ?, ?, 0, ${getMySQLTimestamp()}, ${getMySQLTimestamp()}, ${getMySQLTimestamp()})`,
                            [product_id, supplierId, supplier_price]
                        );
                        productSupplierId = supplierResult.insertId;
                    } else {
                        // Update existing relationship
                        productSupplierId = existingSupplier[0].product_supplier_id;
                        await connection.query(
                            `UPDATE product_suppliers 
                             SET supplier_price = ?, last_supply_date = ${getMySQLTimestamp()}, updated_at = ${getMySQLTimestamp()}
                             WHERE product_supplier_id = ?`,
                            [supplier_price, productSupplierId]
                        );
                    }

                    // Add to price_history
                    await connection.query(
                        `INSERT INTO price_history 
                         (product_id, product_supplier_id, supplier_price, unit_price, markup_percentage, effective_date, created_at)
                         SELECT ?, ?, ?, p.price, p.markup_percentage, ${getMySQLTimestamp()}, ${getMySQLTimestamp()}
                         FROM products p WHERE p.id = ?`,
                        [product_id, productSupplierId, supplier_price, product_id]
                    );
                }

                // Check if branch inventory exists
                const [existingInventory] = await connection.query(
                    `SELECT inventory_id, stock 
                     FROM branch_inventory 
                     WHERE product_id = ? AND branch_id = ? AND is_active = 1`,
                    [product_id, branch_id]
                );

                if (existingInventory.length > 0) {
                    console.log('Updating existing inventory:', {
                        inventory_id: existingInventory[0].inventory_id,
                        product_id: product_id,
                        old_stock: existingInventory[0].stock,
                        new_stock: product.quantity,
                        updated_by: userId
                    });

                    await connection.query(
                        `UPDATE branch_inventory 
                         SET stock = stock + ?,
                             batch_id = ?,
                             updatedAt = ${getMySQLTimestamp()}
                         WHERE inventory_id = ?`,
                        [product.quantity, batchId, existingInventory[0].inventory_id]
                    );

                    // Add inventory history record
                    await connection.query(
                        `INSERT INTO inventory_history 
                         (inventory_id, batch_id, transaction_type, quantity, previous_stock, 
                          current_stock, remarks, created_at, created_by)
                         VALUES (?, ?, 'BULK_IMPORT', ?, ?, ?, ?, ${getMySQLTimestamp()}, ?)`,
                        [
                            existingInventory[0].inventory_id,
                            batchId,
                            product.quantity,
                            existingInventory[0].stock,
                            existingInventory[0].stock + parseInt(product.quantity),
                            `Bulk import from batch ${batchNumber}`,
                            userId
                        ]
                    );
                } else {
                    // Create new branch inventory record
                    const [result] = await connection.query(
                        `INSERT INTO branch_inventory 
                         (branch_id, product_id, batch_id, stock, expiryDate, expiryThreshold, is_active, createdAt, updatedAt)
                         VALUES (?, ?, ?, ?, ?, ?, 1, ${getMySQLTimestamp()}, ${getMySQLTimestamp()})`,
                        [
                            branch_id,
                            product_id,
                            batchId,
                            product.quantity,
                            product.expiry || null,
                            product.expiry_warning_days || 90
                        ]
                    );

                    // Add inventory history record
                    await connection.query(
                        `INSERT INTO inventory_history 
                         (inventory_id, batch_id, transaction_type, quantity, previous_stock, 
                          current_stock, remarks, created_at, created_by)
                         VALUES (?, ?, 'BULK_IMPORT', ?, 0, ?, ?, ${getMySQLTimestamp()}, ?)`,
                        [
                            result.insertId,
                            batchId,
                            product.quantity,
                            product.quantity,
                            `New inventory from batch ${batchNumber}`,
                            userId
                        ]
                    );
                }

                // Add to batch_items table (unit_cost is the supplier cost)
                await connection.query(
                    `INSERT INTO batch_items 
                     (batch_id, product_id, quantity, unit_cost, lot_number, created_at)
                     VALUES (?, ?, ?, ?, ?, ${getMySQLTimestamp()})`,
                    [
                        batchId,
                        product_id,
                        product.quantity,
                        supplier_price,
                        product.lot_number || null
                    ]
                );
            } else if (product.status === 'new') {
                // Get category_id from frontend selection or use NO CATEGORY (11) as default
                let category_id = product.selected_category_id || 11; // Default to NO CATEGORY

                // Validate that the category exists
                if (product.selected_category_id) {
                    const [categoryResult] = await connection.query(
                        'SELECT category_id FROM category WHERE category_id = ? AND is_active = 1',
                        [product.selected_category_id]
                    );
                    if (categoryResult.length === 0) {
                        console.log(`Invalid category ID provided: ${product.selected_category_id}, using default`);
                        category_id = 11; // Fallback to NO CATEGORY
                    }
                }

                // Handle packaging fields for new product
                const enable_packaging_conversion = product.enable_packaging_conversion || false;
                const pieces_per_packaging = product.pieces_per_packaging || 1;
                const packaging_unit = product.packaging_unit || (enable_packaging_conversion ? 'Box' : 'Piece');
                const price_per_packaging = product.price_per_packaging || (enable_packaging_conversion ? supplier_price : null);
                const quantity_in_packaging_units = product.quantity_in_packaging_units ||
                    (enable_packaging_conversion ? Math.ceil(product.quantity / pieces_per_packaging) : product.quantity);

                // Calculate total pieces if packaging conversion is enabled
                const total_pieces = product.total_pieces ||
                    (enable_packaging_conversion ? (quantity_in_packaging_units * pieces_per_packaging) : product.quantity);

                // For database compatibility - map pieces_per_packaging to pieces_per_box
                const pieces_per_box = pieces_per_packaging;

                console.log('Packaging data for new product:', {
                    enable_packaging_conversion,
                    pieces_per_packaging,
                    packaging_unit,
                    price_per_packaging,
                    quantity_in_packaging_units,
                    total_pieces,
                    received_data: {
                        enable_packaging_conversion: product.enable_packaging_conversion,
                        pieces_per_packaging: product.pieces_per_packaging,
                        packaging_unit: product.packaging_unit,
                        price_per_packaging: product.price_per_packaging,
                        total_pieces: product.total_pieces
                    }
                });

                // Calculate unit price - use calculated price if packaged by box, otherwise apply markup
                let unit_price;
                if (enable_packaging_conversion && product.calculated_unit_price) {
                    unit_price = product.calculated_unit_price * 1.3; // Apply 30% markup to calculated unit price
                } else {
                    unit_price = supplier_price * 1.3; // Default markup of 30%
                }

                // Handle new product creation
                const [result] = await connection.query(
                    `INSERT INTO products (
                    barcode, name, brand_name, category, 
                    description, sideEffects, dosage_amount, dosage_unit,
                    price, pieces_per_box, critical, requiresPrescription, VATExempt,
                    enable_packaging_conversion, packaging_unit, pieces_per_packaging,
                    quantity_in_packaging_units, price_per_packaging,
                    unit_price_per_piece, retail_price, wholesale_price, supplier_discount,
                    total_pieces,
                    is_active, current_supplier_id, createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ${getMySQLTimestamp()}, ${getMySQLTimestamp()})`,
                    [
                        product.barcode,
                        product.name,
                        product.brand_name,
                        category_id,
                        product.description || null,
                        product.side_effects || null,
                        product.dosage_amount || null,
                        product.dosage_unit || null,
                        unit_price,
                        pieces_per_box,
                        product.critical || 10,
                        product.requires_prescription || false,
                        product.VATExempt || false,
                        enable_packaging_conversion,
                        packaging_unit,
                        pieces_per_packaging,
                        quantity_in_packaging_units,
                        price_per_packaging,
                        product.unit_price_per_piece || null,
                        product.retail_price || null,
                        product.wholesale_price || null,
                        product.supplier_discount || null,
                        total_pieces,
                        supplierId // Set current supplier (will be null if no supplier)
                    ]
                );

                const newProductId = result.insertId;

                // Only create supplier relationship if a supplier was selected
                if (supplierId) {
                    // Create product_suppliers relationship for new product
                    const [supplierResult] = await connection.query(
                        `INSERT INTO product_suppliers 
                         (product_id, supplier_id, supplier_price, is_preferred, last_supply_date, created_at, updated_at)
                         VALUES (?, ?, ?, 1, ${getMySQLTimestamp()}, ${getMySQLTimestamp()}, ${getMySQLTimestamp()})`,
                        [newProductId, supplierId, supplier_price]
                    );

                    // Add to price_history for new product
                    const defaultMarkup = 30.0; // 30% markup
                    await connection.query(
                        `INSERT INTO price_history 
                         (product_id, product_supplier_id, supplier_price, unit_price, markup_percentage, effective_date, created_at)
                         VALUES (?, ?, ?, ?, ?, ${getMySQLTimestamp()}, ${getMySQLTimestamp()})`,
                        [newProductId, supplierResult.insertId, supplier_price, unit_price, defaultMarkup]
                    );
                }

                // Create branch inventory record for new product with batch_id
                const [inventoryResult] = await connection.query(
                    `INSERT INTO branch_inventory 
                     (branch_id, product_id, batch_id, stock, expiryDate, expiryThreshold, is_active, createdAt, updatedAt)
                     VALUES (?, ?, ?, ?, ?, ?, 1, ${getMySQLTimestamp()}, ${getMySQLTimestamp()})`,
                    [
                        branch_id,
                        newProductId,
                        batchId,
                        product.quantity,
                        product.expiry || null,
                        product.expiry_warning_days || 90
                    ]
                );

                // Add inventory history record with batch_id
                await connection.query(
                    `INSERT INTO inventory_history 
                     (inventory_id, batch_id, transaction_type, quantity, previous_stock, 
                      current_stock, remarks, created_at, created_by)
                     VALUES (?, ?, 'BULK_IMPORT', ?, 0, ?, ?, ${getMySQLTimestamp()}, ?)`,
                    [
                        inventoryResult.insertId,
                        batchId,
                        product.quantity,
                        product.quantity,
                        `New product from batch ${batchNumber}`,
                        userId
                    ]
                );

                // Add to batch_items table
                await connection.query(
                    `INSERT INTO batch_items 
                     (batch_id, product_id, quantity, unit_cost, lot_number, created_at)
                     VALUES (?, ?, ?, ?, ?, ${getMySQLTimestamp()})`,
                    [
                        batchId,
                        newProductId,
                        product.quantity,
                        supplier_price,
                        product.lot_number || null
                    ]
                );

                console.log('Created new product:', {
                    product_id: newProductId,
                    barcode: product.barcode,
                    name: product.name,
                    brand_name: product.brand_name,
                    category_id: category_id,
                    supplier_price: supplier_price
                });
            }
        }

        await connection.commit();
        console.log('Bulk import processed successfully');
        res.json({
            message: 'Import completed successfully',
            batch_id: batchId,
            batch_number: batchNumber
        });

    } catch (error) {
        await connection.rollback();
        console.error('Error processing bulk import:', error);
        res.status(500).json({
            message: 'Error processing import',
            error: error.message
        });
    } finally {
        connection.release();
    }
};

const getArchivedSuppliers = async (req, res) => {
    try {
        const [archives] = await db.pool.query(`
            SELECT 
                s.supplier_id,
                s.supplier_name,
                s.contact_person,
                s.email,
                s.phone,
                s.address,
                s.is_active,
                s.is_archived
            FROM suppliers s
            WHERE s.is_archived = 1
            ORDER BY s.supplier_name
        `);
        console.log('Fetched archived suppliers');
        res.json(archives);
    } catch (error) {
        console.error('Error fetching archived suppliers:', error);
        res.status(500).json({ message: 'Error fetching archived suppliers' });
    }
};

const archiveSupplier = async (req, res) => {
    const { supplier_id } = req.params;
    const { archive_reason } = req.body;
    const archived_by = req.user.user_id;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        // Get supplier details before archiving
        const [supplier] = await connection.query(
            'SELECT * FROM suppliers WHERE supplier_id = ?',
            [supplier_id]
        );

        if (supplier.length === 0) {
            throw new Error('Supplier not found');
        }

        // Create archive record
        await connection.query(`
            INSERT INTO supplier_archives (
                supplier_id, supplier_name, contact_person, email, phone, address,
                archived_by, archive_reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            supplier_id,
            supplier[0].supplier_name,
            supplier[0].contact_person,
            supplier[0].email,
            supplier[0].phone,
            supplier[0].address,
            archived_by,
            archive_reason
        ]);

        // Update supplier as archived
        await connection.query(
            `UPDATE suppliers 
             SET is_archived = 1, is_active = 0, updated_at = ${getMySQLTimestamp()}
             WHERE supplier_id = ?`,
            [supplier_id]
        );

        await connection.commit();
        console.log('Supplier archived successfully:', {
            supplier_id,
            archived_by,
            archive_reason
        });
        res.json({ message: 'Supplier archived successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('Error archiving supplier:', error);
        res.status(500).json({ message: 'Error archiving supplier' });
    } finally {
        connection.release();
    }
};

const restoreSupplier = async (req, res) => {
    const { supplier_id } = req.params;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        // Get archive details
        const [archive] = await connection.query(
            'SELECT supplier_id FROM suppliers WHERE supplier_id = ?',
            [supplier_id]
        );

        if (archive.length === 0) {
            throw new Error('Archive record not found');
        }

        // Update supplier as not archived
        await connection.query(
            `UPDATE suppliers 
             SET is_archived = 0, is_active = 1, updated_at = ${getMySQLTimestamp()}
             WHERE supplier_id = ?`,
            [archive[0].supplier_id]
        );

        await connection.commit();
        console.log('Supplier restored successfully:', {
            supplier_id,
            supplier_id: archive[0].supplier_id
        });
        res.json({ message: 'Supplier restored successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('Error restoring supplier:', error);
        res.status(500).json({ message: 'Error restoring supplier' });
    } finally {
        connection.release();
    }
};

const bulkArchiveSuppliers = async (req, res) => {
    const { supplier_ids, archive_reason } = req.body;
    const archived_by = req.user.user_id;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        for (const supplier_id of supplier_ids) {
            // Get supplier details
            const [supplier] = await connection.query(
                'SELECT * FROM suppliers WHERE supplier_id = ?',
                [supplier_id]
            );

            if (supplier.length > 0) {
                // Create archive record
                await connection.query(`
                    INSERT INTO supplier_archives (
                        supplier_id, supplier_name, contact_person, email, phone, address,
                        archived_by, archive_reason
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    supplier_id,
                    supplier[0].supplier_name,
                    supplier[0].contact_person,
                    supplier[0].email,
                    supplier[0].phone,
                    supplier[0].address,
                    archived_by,
                    archive_reason
                ]);

                // Update supplier as archived
                await connection.query(
                    `UPDATE suppliers 
                     SET is_archived = 1, is_active = 0, updated_at = ${getMySQLTimestamp()}
                     WHERE supplier_id = ?`,
                    [supplier_id]
                );
            }
        }

        await connection.commit();
        console.log('Suppliers archived successfully:', {
            supplier_ids,
            archived_by,
            archive_reason
        });
        res.json({ message: 'Suppliers archived successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('Error archiving suppliers:', error);
        res.status(500).json({ message: 'Error archiving suppliers' });
    } finally {
        connection.release();
    }
};

const bulkRestoreSuppliers = async (req, res) => {
    const { archive_ids } = req.body;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        for (const archive_id of archive_ids) {
            // Get archive details
            const [archive] = await connection.query(
                'SELECT supplier_id FROM supplier_archives WHERE archive_id = ?',
                [archive_id]
            );

            if (archive.length > 0) {
                // Update supplier as not archived
                await connection.query(
                    `UPDATE suppliers 
                     SET is_archived = 0, is_active = 1, updated_at = ${getMySQLTimestamp()}
                     WHERE supplier_id = ?`,
                    [archive[0].supplier_id]
                );

                // Delete archive record
                await connection.query(
                    'DELETE FROM supplier_archives WHERE archive_id = ?',
                    [archive_id]
                );
            }
        }

        await connection.commit();
        console.log('Suppliers restored successfully:', { archive_ids });
        res.json({ message: 'Suppliers restored successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('Error restoring suppliers:', error);
        res.status(500).json({ message: 'Error restoring suppliers' });
    } finally {
        connection.release();
    }
};

// Add new functions for batch management
const getBatches = async (req, res) => {
    try {
        const [batches] = await db.pool.query(
            `SELECT b.*, s.supplier_name, u.name as created_by_name,
                    COUNT(bi.batch_item_id) as product_count,
                    SUM(bi.quantity) as total_quantity
             FROM batches b
             LEFT JOIN suppliers s ON b.supplier_id = s.supplier_id
             LEFT JOIN users u ON b.created_by = u.user_id
             LEFT JOIN batch_items bi ON b.batch_id = bi.batch_id
             WHERE b.is_active = 1
             GROUP BY b.batch_id
             ORDER BY b.created_at DESC`
        );

        console.log('Fetched all batches');
        res.json(batches);
    } catch (error) {
        console.error('Error fetching batches:', error);
        res.status(500).json({ message: 'Error fetching batches' });
    }
};

const getBatchDetails = async (req, res) => {
    const { batch_id } = req.params;

    try {
        // Get batch information
        const [batchInfo] = await db.pool.query(
            `SELECT b.*, s.supplier_name, u.name as created_by_name
             FROM batches b
             LEFT JOIN suppliers s ON b.supplier_id = s.supplier_id
             LEFT JOIN users u ON b.created_by = u.user_id
             WHERE b.batch_id = ?`,
            [batch_id]
        );

        if (batchInfo.length === 0) {
            return res.status(404).json({ message: 'Batch not found' });
        }

        // Get batch items
        const [batchItems] = await db.pool.query(
            `SELECT bi.*, p.name as product_name, p.brand_name, p.barcode,
                    c.name as category_name
             FROM batch_items bi
             JOIN products p ON bi.product_id = p.id
             LEFT JOIN category c ON p.category = c.category_id
             WHERE bi.batch_id = ?
             ORDER BY p.name`,
            [batch_id]
        );

        console.log(`Fetched details for batch ID: ${batch_id}`);
        res.json({
            batch: batchInfo[0],
            items: batchItems
        });
    } catch (error) {
        console.error('Error fetching batch details:', error);
        res.status(500).json({ message: 'Error fetching batch details' });
    }
};

const archiveBatch = async (req, res) => {
    const { batch_id } = req.params;
    const { archive_reason } = req.body;
    const archived_by = req.user.userId;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        // Get batch details before archiving
        const [batch] = await connection.query(
            `SELECT * FROM batches WHERE batch_id = ?`,
            [batch_id]
        );

        if (batch.length === 0) {
            return res.status(404).json({ message: 'Batch not found' });
        }

        // Create archive record
        await connection.query(
            `INSERT INTO batches_archive
             (batch_id, batch_number, order_number, supplier_id, received_date, expiry_date, 
              notes, archived_by, archive_reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                batch_id,
                batch[0].batch_number,
                batch[0].order_number,
                batch[0].supplier_id,
                batch[0].received_date,
                batch[0].expiry_date,
                batch[0].notes,
                archived_by,
                archive_reason
            ]
        );

        // Update batch as inactive
        await connection.query(
            `UPDATE batches SET is_active = 0 WHERE batch_id = ?`,
            [batch_id]
        );

        await connection.commit();
        console.log(`Archived batch ID: ${batch_id}`);
        res.json({ message: 'Batch archived successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('Error archiving batch:', error);
        res.status(500).json({ message: 'Error archiving batch' });
    } finally {
        connection.release();
    }
};

const addBatch = async (req, res) => {
    const { batch_number, order_number, supplier_id, received_date, expiry_date, notes } = req.body;
    const created_by = req.user.userId;

    try {
        // Validate required fields
        if (!batch_number || !supplier_id || !received_date) {
            return res.status(400).json({ message: 'Batch number, supplier, and received date are required' });
        }

        // Check if batch number already exists
        const [existingBatch] = await db.pool.query(
            `SELECT * FROM batches WHERE batch_number = ? AND is_active = 1`,
            [batch_number]
        );

        if (existingBatch.length > 0) {
            return res.status(400).json({ message: 'Batch number already exists' });
        }

        // Insert new batch
        const [result] = await db.pool.query(
            `INSERT INTO batches 
             (batch_number, order_number, supplier_id, received_date, expiry_date, notes, created_by, created_at)
             VALUES (?, ?, ?, ${getMySQLTimestamp(received_date)}, ${expiry_date ? getMySQLTimestamp(expiry_date) : 'NULL'}, ?, ?, ${getMySQLTimestamp()})`,
            [batch_number, order_number, supplier_id, notes, created_by]
        );

        console.log(`Created new batch: ${batch_number} (ID: ${result.insertId})`);
        res.status(201).json({
            message: 'Batch created successfully',
            batch_id: result.insertId,
            batch_number: batch_number
        });
    } catch (error) {
        console.error('Error creating batch:', error);
        res.status(500).json({ message: 'Error creating batch' });
    }
};

const updateBatch = async (req, res) => {
    const { batch_id } = req.params;
    const { batch_number, order_number, supplier_id, received_date, expiry_date, notes } = req.body;

    try {
        // Validate required fields
        if (!batch_number || !supplier_id || !received_date) {
            return res.status(400).json({ message: 'Batch number, supplier, and received date are required' });
        }

        // Check if batch exists
        const [existingBatch] = await db.pool.query(
            `SELECT * FROM batches WHERE batch_id = ? AND is_active = 1`,
            [batch_id]
        );

        if (existingBatch.length === 0) {
            return res.status(404).json({ message: 'Batch not found' });
        }

        // Check if updated batch number already exists (if changed)
        if (batch_number !== existingBatch[0].batch_number) {
            const [duplicateBatch] = await db.pool.query(
                `SELECT * FROM batches WHERE batch_number = ? AND batch_id != ? AND is_active = 1`,
                [batch_number, batch_id]
            );

            if (duplicateBatch.length > 0) {
                return res.status(400).json({ message: 'Batch number already exists' });
            }
        }

        // Update batch
        await db.pool.query(
            `UPDATE batches 
             SET batch_number = ?, 
                 order_number = ?,
                 supplier_id = ?, 
                 received_date = ${getMySQLTimestamp(received_date)}, 
                 expiry_date = ${expiry_date ? getMySQLTimestamp(expiry_date) : 'NULL'}, 
                 notes = ?,
                 updated_at = ${getMySQLTimestamp()}
             WHERE batch_id = ?`,
            [batch_number, order_number, supplier_id, notes, batch_id]
        );

        console.log(`Updated batch ID: ${batch_id}`);
        res.json({ message: 'Batch updated successfully' });
    } catch (error) {
        console.error('Error updating batch:', error);
        res.status(500).json({ message: 'Error updating batch' });
    }
};

// Add uploadReceipt function
const uploadReceipt = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        // Return the URL path to the uploaded file
        const fileUrl = `/uploads/receipts/${req.file.filename}`;

        console.log('Receipt uploaded successfully:', fileUrl);
        res.json({
            message: 'Receipt uploaded successfully',
            fileUrl: fileUrl,
            fileName: req.file.filename
        });
    } catch (error) {
        console.error('Error uploading receipt:', error);
        res.status(500).json({ message: 'Error uploading receipt' });
    }
};

// Get all branches for dropdown selection
const getBranches = async (req, res) => {
    try {
        const [branches] = await db.pool.query(
            `SELECT 
                branch_id,
                branch_name,
                branch_code,
                address,
                city,
                is_active
             FROM branches 
             WHERE is_archived = FALSE AND is_active = 1
             ORDER BY branch_name ASC`
        );
        console.log('Fetched branches for resources:', branches.length);
        res.json(branches);
    } catch (error) {
        console.error('Error fetching branches:', error);
        res.status(500).json({ message: 'Error fetching branches' });
    }
};

// Get inventory history with filtering and pagination
const getInventoryHistory = async (req, res) => {
    try {
        const {
            page = 0,
            limit = 25,
            search = '',
            transaction_type = '',
            branch_id = '',
            date_from = '',
            date_to = '',
            product_id = ''
        } = req.query;

        const offset = parseInt(page) * parseInt(limit);

        // Build the WHERE clause dynamically
        let whereConditions = ['1=1'];
        let queryParams = [];

        // Search by product name, barcode, or batch number
        if (search) {
            whereConditions.push(`(
                p.name LIKE ? OR 
                p.barcode LIKE ? OR 
                p.brand_name LIKE ? OR 
                b.batch_number LIKE ? OR
                bit.lot_number LIKE ?
            )`);
            const searchParam = `%${search}%`;
            queryParams.push(searchParam, searchParam, searchParam, searchParam, searchParam);
        }

        // Filter by transaction type
        if (transaction_type) {
            whereConditions.push('ih.transaction_type = ?');
            queryParams.push(transaction_type);
        }

        // Filter by branch
        if (branch_id) {
            whereConditions.push('br.branch_id = ?');
            queryParams.push(parseInt(branch_id));
        }

        // Filter by product
        if (product_id) {
            whereConditions.push('p.id = ?');
            queryParams.push(parseInt(product_id));
        }

        // Filter by date range
        if (date_from) {
            whereConditions.push('DATE(ih.created_at) >= ?');
            queryParams.push(date_from);
        }
        if (date_to) {
            whereConditions.push('DATE(ih.created_at) <= ?');
            queryParams.push(date_to);
        }

        const whereClause = whereConditions.join(' AND ');

        // Get total count
        const countQuery = `
            SELECT COUNT(*) as total
            FROM inventory_history ih
            JOIN branch_inventory bi ON ih.inventory_id = bi.inventory_id
            JOIN products p ON bi.product_id = p.id
            JOIN branches br ON bi.branch_id = br.branch_id
            LEFT JOIN batches b ON ih.batch_id = b.batch_id
            LEFT JOIN batch_items bit ON b.batch_id = bit.batch_id AND p.id = bit.product_id
            LEFT JOIN users u ON ih.created_by = u.user_id
            WHERE ${whereClause}
        `;

        const [countResult] = await db.pool.query(countQuery, queryParams);
        const total = countResult[0].total;

        // Get paginated results
        const dataQuery = `
            SELECT 
                ih.*,
                p.id as product_id,
                p.name as product_name,
                p.brand_name,
                p.barcode,
                br.branch_id,
                br.branch_name,
                br.branch_code,
                b.batch_number,
                b.order_number,
                b.notes as batch_notes,
                bit.lot_number,
                u.name as created_by_name,
                c.name as category_name
            FROM inventory_history ih
            JOIN branch_inventory bi ON ih.inventory_id = bi.inventory_id
            JOIN products p ON bi.product_id = p.id
            JOIN branches br ON bi.branch_id = br.branch_id
            LEFT JOIN batches b ON ih.batch_id = b.batch_id
            LEFT JOIN batch_items bit ON b.batch_id = bit.batch_id AND p.id = bit.product_id
            LEFT JOIN users u ON ih.created_by = u.user_id
            LEFT JOIN category c ON p.category = c.category_id
            WHERE ${whereClause}
            ORDER BY ih.created_at DESC
            LIMIT ? OFFSET ?
        `;

        const [history] = await db.pool.query(dataQuery, [...queryParams, parseInt(limit), offset]);

        // Get transaction types for filter dropdown
        const [transactionTypes] = await db.pool.query(`
            SELECT DISTINCT transaction_type 
            FROM inventory_history 
            WHERE transaction_type IS NOT NULL
            ORDER BY transaction_type
        `);

        console.log(`Fetched inventory history: ${history.length} records, total: ${total}`);
        res.json({
            history,
            total,
            totalPages: Math.ceil(total / parseInt(limit)),
            currentPage: parseInt(page),
            transactionTypes: transactionTypes.map(t => t.transaction_type)
        });
    } catch (error) {
        console.error('Error fetching inventory history:', error);
        res.status(500).json({ message: 'Error fetching inventory history' });
    }
};

// Get inventory history for a specific product
const getProductInventoryHistory = async (req, res) => {
    const { product_id } = req.params;
    const { page = 0, limit = 25 } = req.query;

    try {
        const offset = parseInt(page) * parseInt(limit);

        // Get total count for the product
        const [countResult] = await db.pool.query(`
            SELECT COUNT(*) as total
            FROM inventory_history ih
            JOIN branch_inventory bi ON ih.inventory_id = bi.inventory_id
            WHERE bi.product_id = ?
        `, [product_id]);

        const total = countResult[0].total;

        // Get paginated history for the product
        const [history] = await db.pool.query(`
            SELECT 
                ih.*,
                p.name as product_name,
                p.brand_name,
                p.barcode,
                br.branch_name,
                br.branch_code,
                b.batch_number,
                b.order_number,
                bit.lot_number,
                u.name as created_by_name
            FROM inventory_history ih
            JOIN branch_inventory bi ON ih.inventory_id = bi.inventory_id
            JOIN products p ON bi.product_id = p.id
            JOIN branches br ON bi.branch_id = br.branch_id
            LEFT JOIN batches b ON ih.batch_id = b.batch_id
            LEFT JOIN batch_items bit ON b.batch_id = bit.batch_id AND p.id = bit.product_id
            LEFT JOIN users u ON ih.created_by = u.user_id
            WHERE bi.product_id = ?
            ORDER BY ih.created_at DESC
            LIMIT ? OFFSET ?
        `, [product_id, parseInt(limit), offset]);

        console.log(`Fetched inventory history for product ${product_id}: ${history.length} records`);
        res.json({
            history,
            total,
            totalPages: Math.ceil(total / parseInt(limit)),
            currentPage: parseInt(page)
        });
    } catch (error) {
        console.error('Error fetching product inventory history:', error);
        res.status(500).json({ message: 'Error fetching product inventory history' });
    }
};

// Generate inventory checklist for stock review
const generateInventoryChecklist = async (req, res) => {
    const { branch_id } = req.params;

    try {
        // Get all products with current stock for the specified branch
        const [inventory] = await db.pool.query(`
            SELECT 
                p.id as product_id,
                p.barcode,
                p.name as product_name,
                p.brand_name,
                c.name as category_name,
                bi.stock as system_stock,
                bi.inventory_id,
                bi.expiryDate as expiryDate,
                bi.batch_id as batch_id,
                bi_item.lot_number as lot_number
            FROM products p
            JOIN branch_inventory bi ON p.id = bi.product_id
            LEFT JOIN batch_items bi_item ON bi.batch_id = bi_item.batch_id AND bi.product_id = bi_item.product_id
            LEFT JOIN category c ON p.category = c.category_id
            WHERE bi.branch_id = ? 
            AND bi.is_active = 1 
            AND p.is_active = 1
            ORDER BY p.name
        `, [branch_id]);

        // Get branch information
        const [branchInfo] = await db.pool.query(
            `SELECT branch_name, branch_code FROM branches WHERE branch_id = ?`,
            [branch_id]
        );

        if (branchInfo.length === 0) {
            return res.status(404).json({ message: 'Branch not found' });
        }

        console.log(`Generated inventory checklist for branch ${branch_id}: ${inventory.length} items`);
        res.json({
            branch: branchInfo[0],
            inventory: inventory,
            total_items: inventory.length
        });
    } catch (error) {
        console.error('Error generating inventory checklist:', error);
        res.status(500).json({ message: 'Error generating inventory checklist' });
    }
};

// Start a new manual stock review session
const startStockReviewSession = async (req, res) => {
    const { branch_id, remarks = '' } = req.body;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        // Use existing `reference` column in stock_review_history
        // Format: SR-YYMMDD + 4 random digits (e.g., SR-2508270123)
        const now = new Date();
        const yy = String(now.getFullYear()).slice(-2);
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const datePart = `${yy}${mm}${dd}`;
        const rand4 = Math.floor(1000 + Math.random() * 9000); // 4-digit random
        const reference = `SR-${datePart}${rand4}`;
        const details = {
            remarks,
            total_items: 0,
            adjusted_count: 0,
            created_count: 0,
            quick_saves: []
        };

        // Determine reviewer display name from token
        const reviewedBy = req.user?.name || req.user?.employeeId || `user_${req.user?.user_id || req.user?.userId || 'unknown'}`;

        const [result] = await connection.query(
            `INSERT INTO stock_review_history (branch_id, reviewed_by, reference, details_json, created_at, review_date, is_active)
             VALUES (?, ?, ?, ?, ${getMySQLTimestamp()}, ${getMySQLTimestamp()}, 1)`,
            [branch_id, reviewedBy, reference, JSON.stringify(details)]
        );

        await connection.commit();

        console.log('[StockReview] Started new session', { id: result.insertId, reference, branch_id });
        res.status(201).json({ id: result.insertId, reference, details });
    } catch (error) {
        await connection.rollback();
        console.error('[StockReview] Error starting session:', error);
        res.status(500).json({ message: 'Error starting stock review session' });
    } finally {
        connection.release();
    }
};

// Quick-save items for an existing session (upsert items, update details_json)
const quickSaveStockReview = async (req, res) => {
    const { reference, branch_id, quick_save = {}, items = [] } = req.body;
    const userId = req.user?.userId || req.user?.user_id || null;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        // Lock and fetch the session row using reference
        const [historyRows] = await connection.query(
            `SELECT id, details_json FROM stock_review_history WHERE reference = ? FOR UPDATE`,
            [reference]
        );

        if (historyRows.length === 0) {
            return res.status(404).json({ message: 'Session not found' });
        }

        const history = historyRows[0];
        let details = {};
        try { details = history.details_json ? JSON.parse(history.details_json) : {}; } catch (e) { details = {}; }

        // Append quick_save metadata to details.quick_saves
        details.quick_saves = details.quick_saves || [];
        details.quick_saves.push({ ...quick_save, created_at: new Date().toISOString() });

        // Update summary counts if provided
        details.remarks = quick_save.remarks || details.remarks || '';
        if (typeof quick_save.total_items === 'number') details.total_items = quick_save.total_items;
        if (typeof quick_save.adjusted_count === 'number') details.adjusted_count = quick_save.adjusted_count;
        if (typeof quick_save.created_count === 'number') details.created_count = quick_save.created_count;

        // Upsert each item into stock_review_items
        for (const item of items) {
            const product_id = item.product_id || null;
            const actual_count = item.actual_count == null ? null : item.actual_count;
            const system_count = item.system_count == null ? null : item.system_count;
            const difference = item.difference == null ? null : item.difference;
            const adjustment_action = item.adjustment_action || null;

            if (!product_id) continue; // skip invalid rows

            const [existing] = await connection.query(
                `SELECT id FROM stock_review_items WHERE stock_review_history_id = ? AND product_id = ?`,
                [history.id, product_id]
            );

            if (existing.length > 0) {
                await connection.query(
                    `UPDATE stock_review_items
                     SET actual_count = ?, system_count = ?, difference = ?, adjustment_action = ?, created_at = ${getMySQLTimestamp()}
                     WHERE id = ?`,
                    [actual_count, system_count, difference, adjustment_action, existing[0].id]
                );
            } else {
                await connection.query(
                    `INSERT INTO stock_review_items
                     (stock_review_history_id, product_id, actual_count, system_count, difference, adjustment_action, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ${getMySQLTimestamp()})`,
                    [history.id, product_id, actual_count, system_count, difference, adjustment_action]
                );
            }
        }

        // Mark corresponding session products as 'saved' and persist counts so they reflect actual saved values
        try {
            for (const it of items) {
                try {
                    const actualCount = it.actual_count == null ? null : it.actual_count;
                    // Build a dynamic WHERE clause to uniquely identify the row
                    let whereClause = 'session_id = ?';
                    let params = [history.id];
                    if (it.inventory_id) {
                        whereClause += ' AND inventory_id = ?';
                        params.push(it.inventory_id);
                    }
                    if (it.product_id) {
                        whereClause += ' AND product_id = ?';
                        params.push(it.product_id);
                    }
                    if (it.barcode) {
                        whereClause += ' AND barcode = ?';
                        params.push(it.barcode);
                    }
                    if (it.batch_id) {
                        whereClause += ' AND batch_id = ?';
                        params.push(it.batch_id);
                    }
                    if (it.lot_number) {
                        whereClause += ' AND lot_number = ?';
                        params.push(it.lot_number);
                    }
                    // Only update if we have at least product_id or barcode
                    if (it.product_id || it.barcode) {
                        await connection.query(
                            `UPDATE stock_session_products SET status = 'saved', actual_count = ? WHERE ${whereClause}`,
                            [actualCount, ...params]
                        );
                    }
                } catch (innerErr) {
                    console.error('[StockReview] Failed to update session product counts for item', it, innerErr);
                }
            }
            console.log('[StockReview] Updated session products as saved for session', history.id);
        } catch (markErr) {
            console.error('[StockReview] Failed to mark session products as saved:', markErr);
            // continue without failing the whole quick-save operation
        }

        // Update branch inventory based on quick-saved actual counts (if provided)
        try {
            for (const it of items) {
                try {
                    console.log('[StockReview] quickSave: processing item', { product_id: it.product_id, barcode: it.barcode, batch_id: it.batch_id, lot_number: it.lot_number, actual_count: it.actual_count });

                    const actualCount = it.actual_count == null ? null : parseInt(it.actual_count);
                    if (actualCount == null || isNaN(actualCount)) {
                        console.log('[StockReview] quickSave: skipping item because actual_count is missing or not a number', { item: it });
                        continue;
                    }

                    // Resolve product_id from item or via barcode lookup
                    let productId = it.product_id || null;
                    if (!productId && it.barcode) {
                        const [prodRows] = await connection.query(
                            `SELECT id FROM products WHERE barcode = ? AND is_active = 1 LIMIT 1`,
                            [it.barcode]
                        );
                        if (prodRows.length > 0) productId = prodRows[0].id;
                    }
                    if (!productId) {
                        console.log('[StockReview] quickSave: no product_id found for item, skipping inventory update', { item: it });
                        continue;
                    }

                    // Simplified matching: match by product_id + branch_id + (batch_id if provided)
                    const batchId = (it.batch_id !== undefined && it.batch_id !== null) ? it.batch_id : null;

                    let existingInv = [];
                    if (batchId != null) {
                        [existingInv] = await connection.query(
                            `SELECT inventory_id, stock FROM branch_inventory WHERE product_id = ? AND branch_id = ? AND batch_id = ? AND is_active = 1 LIMIT 1`,
                            [productId, branch_id, batchId]
                        );
                    } else {
                        [existingInv] = await connection.query(
                            `SELECT inventory_id, stock FROM branch_inventory WHERE product_id = ? AND branch_id = ? AND is_active = 1 LIMIT 1`,
                            [productId, branch_id]
                        );
                    }

                    console.log('[StockReview] quickSave: existingInv found count', { count: existingInv.length, productId, branch_id, batchId });

                    if (existingInv.length > 0) {
                        const inv = existingInv[0];
                        const prevStock = inv.stock || 0;
                        if (batchId != null) {
                            await connection.query(
                                `UPDATE branch_inventory SET stock = ?, batch_id = ?, updatedAt = ${getMySQLTimestamp()} WHERE inventory_id = ?`,
                                [actualCount, batchId, inv.inventory_id]
                            );
                        } else {
                            await connection.query(
                                `UPDATE branch_inventory SET stock = ?, updatedAt = ${getMySQLTimestamp()} WHERE inventory_id = ?`,
                                [actualCount, inv.inventory_id]
                            );
                        }

                        await connection.query(
                            `INSERT INTO inventory_history (inventory_id, transaction_type, quantity, previous_stock, current_stock, remarks, created_at, created_by) VALUES (?, 'QUICK_SAVE', ?, ?, ?, ?, ${getMySQLTimestamp()}, ?)`,
                            [inv.inventory_id, actualCount - prevStock, prevStock, actualCount, `Quick save adjustment`, userId]
                        );
                        console.log('[StockReview] quickSave: updated inventory for product', productId, 'inv', inv.inventory_id, 'from', prevStock, 'to', actualCount);
                    } else {
                        // Create new branch inventory and set batch_id if available
                        const [newInv] = await connection.query(
                            `INSERT INTO branch_inventory (branch_id, product_id, batch_id, stock, is_active, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, ${getMySQLTimestamp()}, ${getMySQLTimestamp()})`,
                            [branch_id, productId, batchId, actualCount]
                        );

                        await connection.query(
                            `INSERT INTO inventory_history (inventory_id, transaction_type, quantity, previous_stock, current_stock, remarks, created_at, created_by) VALUES (?, 'QUICK_SAVE', ?, 0, ?, ?, ${getMySQLTimestamp()}, ?)`,
                            [newInv.insertId, actualCount, actualCount, `Quick save created inventory (batch: ${batchId || 'N/A'})`, userId]
                        );
                        console.log('[StockReview] quickSave: created new inventory for product', productId, 'inv', newInv.insertId, 'stock', actualCount);
                    }
                } catch (innerErr) {
                    console.error('[StockReview] quickSave: failed to update inventory for item', { item: it, error: innerErr && innerErr.stack ? innerErr.stack : innerErr });
                }
            }
        } catch (invErr) {
            console.error('[StockReview] quickSave: inventory update loop failed', invErr && invErr.stack ? invErr.stack : invErr);
            // continue; do not fail the entire quick-save because of history record failures
        }

        // Persist updated details_json
        await connection.query(
            `UPDATE stock_review_history SET details_json = ?, review_date = ${getMySQLTimestamp()} WHERE id = ?`,
            [JSON.stringify(details), history.id]
        );

        await connection.commit();

        console.log('[StockReview] Quick-saved session', { reference, items_count: items.length });
        res.json({ message: 'Quick save successful', reference, items_processed: items.length, details });
    } catch (error) {
        await connection.rollback();
        console.error('[StockReview] Error during quick save:', error);
        res.status(500).json({ message: 'Error during quick save' });
    } finally {
        connection.release();
    }
};

// Bulk process for an existing session — merges batch info and upserts items
const bulkProcessStockReview = async (req, res) => {
    const { reference, branch_id, batch_info = {}, items = [], summary = {} } = req.body;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        const [historyRows] = await connection.query(
            `SELECT id, details_json FROM stock_review_history WHERE reference = ? FOR UPDATE`,
            [reference]
        );

        if (historyRows.length === 0) {
            return res.status(404).json({ message: 'Session not found' });
        }

        const history = historyRows[0];
        let details = {};
        try { details = history.details_json ? JSON.parse(history.details_json) : {}; } catch (e) { details = {}; }

        // Merge batch_info and summary into details
        details.batch_info = { ...(details.batch_info || {}), ...batch_info, processed_at: new Date().toISOString() };
        details.summary = { ...(details.summary || {}), ...summary };

        // Upsert items similarly to quick save
        for (const item of items) {
            const product_id = item.product_id || null;
            if (!product_id) continue;

            const actual_count = item.actual_count == null ? null : item.actual_count;
            const system_count = item.system_count == null ? null : item.system_count;
            const difference = item.difference == null ? null : item.difference;
            const adjustment_action = item.adjustment_action || null;

            const [existing] = await connection.query(
                `SELECT id FROM stock_review_items WHERE stock_review_history_id = ? AND product_id = ?`,
                [history.id, product_id]
            );

            if (existing.length > 0) {
                await connection.query(
                    `UPDATE stock_review_items
                     SET actual_count = ?, system_count = ?, difference = ?, adjustment_action = ?, created_at = ${getMySQLTimestamp()}
                     WHERE id = ?`,
                    [actual_count, system_count, difference, adjustment_action, existing[0].id]
                );
            } else {
                await connection.query(
                    `INSERT INTO stock_review_items
                     (stock_review_history_id, product_id, actual_count, system_count, difference, adjustment_action, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ${getMySQLTimestamp()})`,
                    [history.id, product_id, actual_count, system_count, difference, adjustment_action]
                );
            }
            // Also update branch inventory based on actual_count when provided
            try {
                if (actual_count != null && !isNaN(parseInt(actual_count))) {
                    const actual = parseInt(actual_count);
                    const [existingInv] = await connection.query(
                        `SELECT inventory_id, stock FROM branch_inventory WHERE product_id = ? AND branch_id = ? AND is_active = 1 LIMIT 1`,
                        [product_id, branch_id]
                    );

                    if (existingInv.length > 0) {
                        const inv = existingInv[0];
                        const prevStock = inv.stock || 0;
                        await connection.query(
                            `UPDATE branch_inventory SET stock = ?, batch_id = ?, lot_number = ?, updatedAt = ${getMySQLTimestamp()} WHERE inventory_id = ?`,
                            [actual, item.batch_id || batchId, item.lot_number || lotNumber, inv.inventory_id]
                        );

                        await connection.query(
                            `INSERT INTO inventory_history (inventory_id, transaction_type, quantity, previous_stock, current_stock, remarks, created_at, created_by) VALUES (?, 'BULK_QUICK_SAVE', ?, ?, ?, ?, ${getMySQLTimestamp()}, ?)`,
                            [inv.inventory_id, actual - prevStock, prevStock, actual, `Bulk quick-save adjustment`, req.user?.userId || req.user?.user_id || null]
                        );
                        console.log('[StockReview] bulkProcess: updated inventory for product', product_id, 'inv', inv.inventory_id, 'from', prevStock, 'to', actual);
                    } else {
                        // Create new inventory and include batch_id if provided
                        const [newInv] = await connection.query(
                            `INSERT INTO branch_inventory (branch_id, product_id, batch_id, lot_number, stock, is_active, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, ${getMySQLTimestamp()}, ${getMySQLTimestamp()})`,
                            [branch_id, product_id, item.batch_id || null, item.lot_number || lotNumber || null, actual]
                        );

                        await connection.query(
                            `INSERT INTO inventory_history (inventory_id, transaction_type, quantity, previous_stock, current_stock, remarks, created_at, created_by) VALUES (?, 'BULK_QUICK_SAVE', ?, 0, ?, ?, ${getMySQLTimestamp()}, ?)`,
                            [newInv.insertId, actual, actual, `Bulk quick-save created inventory`, req.user?.userId || req.user?.user_id || null]
                        );
                        console.log('[StockReview] bulkProcess: created inventory for product', product_id, 'inv', newInv.insertId, 'stock', actual);
                    }
                }
            } catch (invErr) {
                console.error('[StockReview] bulkProcess: failed to update/create inventory for product', product_id, invErr);
            }
        }

        // Update counts in details if summary provided
        if (typeof summary.total_items === 'number') details.total_items = summary.total_items;
        if (typeof summary.adjusted_count === 'number') details.adjusted_count = summary.adjusted_count;
        if (typeof summary.created_count === 'number') details.created_count = summary.created_count;

        await connection.query(
            `UPDATE stock_review_history SET details_json = ?, review_date = ${getMySQLTimestamp()} WHERE id = ?`,
            [JSON.stringify(details), history.id]
        );

        await connection.commit();

        console.log('[StockReview] Bulk processed session', { reference, items_processed: items.length });
        res.json({ message: 'Bulk process successful', reference, items_processed: items.length, details });
    } catch (error) {
        await connection.rollback();
        console.error('[StockReview] Error during bulk process:', error);
        res.status(500).json({ message: 'Error during bulk process' });
    } finally {
        connection.release();
    }
};

// End (deactivate) a stock review session
const endStockReviewSession = async (req, res) => {
    const { reference, id } = req.body;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        let whereClause = '';
        let params = [];
        if (id) {
            whereClause = 'id = ?';
            params = [id];
        } else if (reference) {
            whereClause = 'reference = ?';
            params = [reference];
        } else {
            return res.status(400).json({ message: 'id or reference is required' });
        }

        const [rows] = await connection.query(
            `SELECT id, is_active FROM stock_review_history WHERE ${whereClause} FOR UPDATE`,
            params
        );

        if (rows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ message: 'Session not found' });
        }

        const session = rows[0];
        if (session.is_active === 0) {
            await connection.commit();
            return res.json({ message: 'Session already inactive', id: session.id });
        }

        // Deactivate the session
        await connection.query(
            `UPDATE stock_review_history SET is_active = 0, review_date = ${getMySQLTimestamp()} WHERE id = ?`,
            [session.id]
        );

        // Cleanup any saved session products for this session (user ended session -> remove temporary rows)
        try {
            await connection.query(`DELETE FROM stock_session_products WHERE session_id = ?`, [session.id]);
            console.log('[StockReview] Cleaned up stock_session_products for session', session.id);
        } catch (cleanupErr) {
            // Log and continue; do not fail the whole operation for cleanup issues
            console.error('[StockReview] Failed to cleanup stock_session_products for session', session.id, cleanupErr);
        }

        await connection.commit();
        console.log('[StockReview] Ended session', { id: session.id, reference });
        res.json({ message: 'Session ended', id: session.id });
    } catch (error) {
        await connection.rollback();
        console.error('[StockReview] Error ending session:', error);
        res.status(500).json({ message: 'Error ending session' });
    } finally {
        connection.release();
    }
};

// Process uploaded inventory count and compare with system
const processInventoryCount = async (req, res) => {
    const { branch_id, inventory_data } = req.body;

    try {
        const connection = await db.pool.getConnection();
        const processedItems = [];

        console.log(`[StockReview] Processing inventory count for branch ${branch_id} with ${inventory_data.length} items`);

        for (const item of inventory_data) {
            let status = 'match';
            let systemStock = item.system_stock || 0; // Use Excel file value as primary source
            let difference = 0;
            let productInfo = null;

            // Look up the product and verify against database
            if (item.barcode) {

                // Match by product barcode + branch + batch_id. Do not require expiryDate equality here
                // because expiry mismatches were causing items to be marked unrecognized.
                const [productResult] = await connection.query(`
                    SELECT 
                        p.id as product_id,
                        p.name as product_name,
                        p.brand_name,
                        bi.stock as db_system_stock,
                        bi.inventory_id,
                        bi.batch_id as batch_id
                    FROM products p
                    LEFT JOIN branch_inventory bi ON p.id = bi.product_id AND bi.branch_id = ? AND bi.is_active = 1 AND bi.batch_id = ?
                    WHERE p.barcode = ? AND p.is_active = 1
                `, [branch_id, item.batch_id, item.barcode]);

                if (productResult.length > 0 && productResult[0].inventory_id) {

                    productInfo = productResult[0];
                    const dbSystemStock = productInfo.db_system_stock || 0;

                    console.log(`[StockReview] Found product in DB: ${productInfo.product_name}, DB Stock: ${dbSystemStock}, Excel Stock: ${systemStock}`);

                    // Use Excel system stock as the baseline (since it was generated from the checklist)
                    // But log any significant discrepancies for reference
                    if (Math.abs(dbSystemStock - systemStock) > 0) {
                        console.log(`[StockReview] Stock discrepancy detected for ${item.product_name}: DB=${dbSystemStock}, Excel=${systemStock}. Using Excel value.`);
                    }

                    const actualCount = parseInt(item.actual_count) || 0;
                    difference = actualCount - systemStock;

                    if (difference > 0) {
                        status = 'overage';
                    } else if (difference < 0) {
                        status = 'shortage';
                    } else {
                        status = 'match';
                    }

                    // Special case: if Excel shows 0 system stock but we have actual count, it's "found"
                    if (systemStock === 0 && actualCount > 0) {
                        status = 'found';
                        console.log(`[StockReview] Marking as FOUND: ${item.product_name} - System: 0, Actual: ${actualCount}`);
                    }
                } else {
                    status = 'unrecognized';
                    console.log(`[StockReview] Product not found in database: ${item.barcode} - ${item.product_name}`);
                }
            } else {
                status = 'unrecognized';
                console.log(`[StockReview] No barcode provided for: ${item.product_name}`);
            }

            // Calculate difference using Excel system stock
            const actualCount = parseInt(item.actual_count) || 0;
            difference = actualCount - systemStock;

            processedItems.push({
                ...item,
                status,
                system_stock: systemStock, // Use Excel value
                actual_count: actualCount,
                difference,
                product_info: productInfo
            });

            console.log(`[StockReview] Processed: ${item.product_name} - Status: ${status}, System: ${systemStock}, Actual: ${actualCount}, Diff: ${difference}`);
        }

        connection.release();

        // Categorize results
        const summary = {
            total_items: processedItems.length,
            matches: processedItems.filter(item => item.status === 'match').length,
            overages: processedItems.filter(item => item.status === 'overage').length,
            shortages: processedItems.filter(item => item.status === 'shortage').length,
            found_items: processedItems.filter(item => item.status === 'found').length,
            unrecognized: processedItems.filter(item => item.status === 'unrecognized').length
        };

        console.log(`[StockReview] Processing complete for branch ${branch_id}:`, summary);
        res.json({
            items: processedItems,
            summary
        });
    } catch (error) {
        console.error('[StockReview] Error processing inventory count:', error);
        res.status(500).json({ message: 'Error processing inventory count' });
    }
};

// Apply stock adjustments from inventory count
const applyStockAdjustments = async (req, res) => {
    const { branch_id, adjustments, count_date, remarks } = req.body;
    const userId = req.user.userId;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        console.log(`[StockReview] Starting to apply adjustments for branch ${branch_id}`);
        console.log(`[StockReview] Received ${adjustments.length} total items for processing`);
        console.log(`[StockReview] Sample adjustment:`, adjustments[0]);

        let adjustedCount = 0;
        let createdCount = 0;
        const adjustmentResults = [];
        const errors = [];
        let totalShortage = 0;
        let totalOverage = 0;

        for (const adjustment of adjustments) {
            console.log(`[StockReview] Processing adjustment: ${adjustment.product_name} - Status: ${adjustment.status}`);
            console.log(`[StockReview] System Stock: ${adjustment.system_stock}, Actual Count: ${adjustment.actual_count}`);
            console.log(`[StockReview] Product Info:`, adjustment.product_info);

            if (["overage", "shortage", "found"].includes(adjustment.status)) {
                const actualCount = parseInt(adjustment.actual_count) || 0;
                const systemStock = adjustment.system_stock || 0;
                const difference = actualCount - systemStock;
                let previousStock = systemStock;
                let newStock = actualCount;

                // Calculate profit/loss for shortages and overages
                if (adjustment.status === 'shortage' && difference < 0) {
                    // Calculate loss based on product cost (you may need to adjust this calculation)
                    const costPerUnit = adjustment.product_info?.cost_price || 0;
                    const loss = Math.abs(difference) * costPerUnit;
                    totalShortage += loss;
                } else if (adjustment.status === 'overage' && difference > 0) {
                    // Calculate gain based on product cost
                    const costPerUnit = adjustment.product_info?.cost_price || 0;
                    const gain = difference * costPerUnit;
                    totalOverage += gain;
                }

                console.log(`[StockReview] Processing ${adjustment.status}: ${adjustment.product_name}`);
                console.log(`[StockReview] Actual: ${actualCount}, System: ${systemStock}, Difference: ${difference}`);

                if (adjustment.status === 'found') {
                    console.log(`[StockReview] Processing FOUND item: ${adjustment.product_name}`);

                    if (!adjustment.product_info || !adjustment.product_info.product_id) {
                        const errMsg = `[StockReview] ERROR: Found item missing product_info: ${adjustment.product_name}`;
                        console.log(errMsg);
                        errors.push({ product_name: adjustment.product_name, reason: 'Missing product_info.product_id' });
                        continue;
                    }

                    const [inventoryResult] = await connection.query(`
                        INSERT INTO branch_inventory 
                        (branch_id, product_id, stock, is_active, createdAt, updatedAt)
                        VALUES (?, ?, ?, 1, ${getMySQLTimestamp()}, ${getMySQLTimestamp()})
                    `, [
                        branch_id,
                        adjustment.product_info.product_id,
                        actualCount
                    ]);

                    console.log(`[StockReview] Created new inventory record with ID: ${inventoryResult.insertId}`);

                    await connection.query(`
                        INSERT INTO inventory_history 
                        (inventory_id, transaction_type, quantity, previous_stock, current_stock, 
                         remarks, created_at, created_by)
                        VALUES (?, 'ADJUSTMENT', ?, 0, ?, ?, ${getMySQLTimestamp()}, ?)
                    `, [
                        inventoryResult.insertId,
                        actualCount,
                        actualCount,
                        `${remarks || 'Stock count adjustment'} - Found item`,
                        userId
                    ]);

                    createdCount++;
                    console.log(`[StockReview] Successfully processed FOUND item: ${adjustment.product_name}`);
                } else if (adjustment.product_info && adjustment.product_info.inventory_id) {
                    console.log(`[StockReview] Processing ${adjustment.status} with inventory_id: ${adjustment.product_info.inventory_id}`);

                    await connection.query(`
                        UPDATE branch_inventory 
                        SET stock = ?, updatedAt = ${getMySQLTimestamp()}
                        WHERE inventory_id = ?
                    `, [actualCount, adjustment.product_info.inventory_id]);

                    console.log(`[StockReview] Updated inventory_id ${adjustment.product_info.inventory_id} to stock ${actualCount}`);

                    await connection.query(`
                        INSERT INTO inventory_history 
                        (inventory_id, transaction_type, quantity, previous_stock, current_stock, 
                         remarks, created_at, created_by)
                        VALUES (?, 'ADJUSTMENT', ?, ?, ?, ?, ${getMySQLTimestamp()}, ?)
                    `, [
                        adjustment.product_info.inventory_id,
                        difference,
                        systemStock,
                        actualCount,
                        `${remarks || 'Stock count adjustment'} - ${adjustment.status}`,
                        userId
                    ]);

                    adjustedCount++;
                    console.log(`[StockReview] Successfully processed ${adjustment.status}: ${adjustment.product_name}`);
                } else {
                    const errMsg = `[StockReview] ERROR: Missing product_info or inventory_id for ${adjustment.product_name}`;
                    console.log(errMsg);
                    console.log(`[StockReview] Product info:`, adjustment.product_info);
                    errors.push({ product_name: adjustment.product_name, reason: 'Missing product_info or inventory_id' });
                }

                adjustmentResults.push({
                    product_name: adjustment.product_name || adjustment.product_info?.product_name,
                    barcode: adjustment.barcode,
                    status: adjustment.status,
                    previous_stock: previousStock,
                    new_stock: newStock,
                    change: newStock - previousStock,
                    batch_id: adjustment.batch_id || adjustment.product_info?.batch_id,
                    expiryDate: adjustment.expiryDate || adjustment.product_info?.expiryDate,
                    system_stock: systemStock,
                    actual_count: actualCount,
                    difference: difference
                });
            } else {
                console.log(`[StockReview] Skipping item with status: ${adjustment.status} - ${adjustment.product_name}`);
            }
        }

        // Save stock review history after successful adjustments
        if (adjustedCount > 0 || createdCount > 0) {
            const reference = `SR-${Date.now()}`; // Generate a unique reference
            const reviewDate = count_date || new Date().toISOString();

            // Get user info for reviewed_by
            const [userResult] = await connection.query(
                'SELECT name FROM users WHERE user_id = ?',
                [userId]
            );

            const reviewedBy = userResult.length > 0
                ? userResult[0].name || `User ${userId}`
                : `User ${userId}`;

            await connection.query(`
                INSERT INTO stock_review_history 
                (branch_id, reviewed_by, review_date, reference, total_shortage, total_overage, details_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ${getMySQLTimestamp()})
            `, [
                branch_id,
                reviewedBy,
                reviewDate,
                reference,
                totalShortage,
                totalOverage,
                JSON.stringify({
                    adjustments: adjustmentResults,
                    remarks: remarks,
                    total_items: adjustments.length,
                    adjusted_count: adjustedCount,
                    created_count: createdCount
                })
            ]);

            console.log(`[StockReview] Saved stock review history with reference: ${reference}`);
        }

        await connection.commit();

        console.log(`[StockReview] Final results - Applied: ${adjustedCount}, Created: ${createdCount}, Skipped: ${errors.length}`);
        console.log(`Applied stock adjustments for branch ${branch_id}: ${adjustedCount} updated, ${createdCount} created`);

        res.status(200).json({
            message: errors.length > 0
                ? 'Stock adjustments applied with some issues'
                : 'Stock adjustments applied successfully',
            adjusted_count: adjustedCount,
            created_count: createdCount,
            skipped_count: errors.length,
            results: adjustmentResults,
            errors: errors,
            total_shortage: totalShortage,
            total_overage: totalOverage
        });
    } catch (error) {
        await connection.rollback();
        console.error('[StockReview] Error applying stock adjustments:', error);
        res.status(500).json({ message: 'Error applying stock adjustments' });
    } finally {
        connection.release();
    }
};

// Get stock review history
const getStockReviewHistory = async (req, res) => {
    try {
        const [history] = await db.pool.query(`
            SELECT 
                id,
                branch_id,
                reviewed_by,
                review_date,
                reference,
                total_shortage,
                total_overage,
                details_json,
                created_at
            FROM stock_review_history 
            ORDER BY review_date DESC
        `);

        console.log(`Fetched ${history.length} stock review history records`);
        res.json(history);
    } catch (error) {
        console.error('Error fetching stock review history:', error);
        res.status(500).json({ message: 'Error fetching stock review history' });
    }
};

// Get stock review history by branch
const getStockReviewHistoryByBranch = async (req, res) => {
    const { branch_id } = req.params;

    try {
        const [history] = await db.pool.query(`
            SELECT 
                id,
                branch_id,
                reviewed_by,
                review_date,
                reference,
                total_shortage,
                total_overage,
                details_json,
                created_at
            FROM stock_review_history 
            WHERE branch_id = ?
            ORDER BY review_date DESC
        `, [branch_id]);

        console.log(`Fetched ${history.length} stock review history records for branch ${branch_id}`);
        res.json(history);
    } catch (error) {
        console.error('Error fetching stock review history by branch:', error);
        res.status(500).json({ message: 'Error fetching stock review history' });
    }
};

// Get latest stock review history row for a branch (useful to check active session)
const getLatestStockReviewByBranch = async (req, res) => {
    const { branch_id } = req.params;
    try {
        // First, attempt to return the most recent ACTIVE session if one exists.
        const [activeRows] = await db.pool.query(`
            SELECT 
                id,
                branch_id,
                reviewed_by,
                review_date,
                reference,
                details_json,
                is_active,
                created_at
            FROM stock_review_history
            WHERE branch_id = ? AND is_active = 1
            ORDER BY created_at DESC
            LIMIT 1
        `, [branch_id]);

        if (activeRows.length > 0) {
            const latestActive = activeRows[0];
            // Parse details_json. If it's not an array (legacy/object), attempt to load the stored items
            if (latestActive.details_json) {
                let parsed = null;
                try { parsed = JSON.parse(latestActive.details_json); } catch (e) { parsed = latestActive.details_json; }

                // If parsed is an array, use as-is. If parsed is an object, try to load items from stock_review_items
                if (Array.isArray(parsed)) {
                    latestActive.details = parsed;
                    // keep details_json as the original
                } else {
                    // Fetch items from stock_review_items and join product info so frontend gets an array
                    const [itemRows] = await db.pool.query(`
                        SELECT sri.*, p.barcode, p.name as product_name, p.brand_name, c.name as category_name,
                               bi.stock as system_stock, bi.inventory_id, bi.batch_id as batch_id, bi.expiryDate
                        FROM stock_review_items sri
                        LEFT JOIN products p ON sri.product_id = p.id
                        LEFT JOIN category c ON p.category = c.category_id
                        LEFT JOIN branch_inventory bi ON p.id = bi.product_id AND bi.branch_id = ?
                        WHERE sri.stock_review_history_id = ?
                        ORDER BY p.name
                    `, [branch_id, latestActive.id]);

                    const mapped = itemRows.map(r => ({
                        barcode: r.barcode || '',
                        product_name: r.product_name || r.name || '',
                        brand_name: r.brand_name || '',
                        category_name: r.category_name || '',
                        system_stock: r.system_stock != null ? r.system_stock : (r.system_count != null ? r.system_count : 0),
                        actual_count: r.actual_count != null ? r.actual_count : 0,
                        difference: r.difference != null ? r.difference : ((r.actual_count || 0) - (r.system_count || r.system_stock || 0)),
                        status: r.adjustment_action || r.status || 'match',
                        product_info: {
                            product_id: r.product_id || null,
                            inventory_id: r.inventory_id || null,
                            batch_id: r.batch_id || null
                        },
                        expiryDate: r.expiryDate || null,
                        batch_id: r.batch_id || null,
                        lot_number: r.batch_id || null
                    }));

                    // Attach the items array so frontend resume code (which expects details_json to be an array) works
                    latestActive.details = mapped;
                    try {
                        latestActive.details_json = JSON.stringify(mapped);
                    } catch (e) {
                        // fallback: leave original details_json
                    }
                }
            }

            return res.json(latestActive);
        }

        // Fallback: return the latest session (active or not) if no active session is present
        const [rows] = await db.pool.query(`
            SELECT 
                id,
                branch_id,
                reviewed_by,
                review_date,
                reference,
                details_json,
                is_active,
                created_at
            FROM stock_review_history
            WHERE branch_id = ?
            ORDER BY created_at DESC
            LIMIT 1
        `, [branch_id]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'No stock review history for this branch' });
        }

        const latest = rows[0];
        if (latest.details_json) {
            let parsed = null;
            try { parsed = JSON.parse(latest.details_json); } catch (e) { parsed = latest.details_json; }

            if (Array.isArray(parsed)) {
                latest.details = parsed;
            } else {
                // Try to load associated items from stock_review_items
                const [itemRows] = await db.pool.query(`
                    SELECT sri.*, p.barcode, p.name as product_name, p.brand_name, c.name as category_name,
                           bi.stock as system_stock, bi.inventory_id, bi.batch_id as batch_id, bi.expiryDate
                    FROM stock_review_items sri
                    LEFT JOIN products p ON sri.product_id = p.id
                    LEFT JOIN category c ON p.category = c.category_id
                    LEFT JOIN branch_inventory bi ON p.id = bi.product_id AND bi.branch_id = ?
                    WHERE sri.stock_review_history_id = ?
                    ORDER BY p.name
                `, [branch_id, latest.id]);

                const mapped = itemRows.map(r => ({
                    barcode: r.barcode || '',
                    product_name: r.product_name || r.name || '',
                    brand_name: r.brand_name || '',
                    category_name: r.category_name || '',
                    system_stock: r.system_stock != null ? r.system_stock : (r.system_count != null ? r.system_count : 0),
                    actual_count: r.actual_count != null ? r.actual_count : 0,
                    difference: r.difference != null ? r.difference : ((r.actual_count || 0) - (r.system_count || r.system_stock || 0)),
                    status: r.adjustment_action || r.status || 'match',
                    product_info: {
                        product_id: r.product_id || null,
                        inventory_id: r.inventory_id || null,
                        batch_id: r.batch_id || null
                    },
                    expiryDate: r.expiryDate || null,
                    batch_id: r.batch_id || null,
                    lot_number: r.batch_id || null
                }));

                latest.details = mapped;
                try { latest.details_json = JSON.stringify(mapped); } catch (e) { }
            }
        }

        res.json(latest);
    } catch (error) {
        console.error('Error fetching latest stock review history for branch:', branch_id, error);
        res.status(500).json({ message: 'Error fetching latest stock review history' });
    }
};

// Get stock review history details by ID
const getStockReviewHistoryDetails = async (req, res) => {
    const { id } = req.params;

    try {
        const [history] = await db.pool.query(`
            SELECT 
                id,
                branch_id,
                reviewed_by,
                review_date,
                reference,
                total_shortage,
                total_overage,
                details_json,
                created_at
            FROM stock_review_history 
            WHERE id = ?
        `, [id]);

        if (history.length === 0) {
            return res.status(404).json({ message: 'Stock review history not found' });
        }

        const review = history[0];
        if (review.details_json) {
            review.details = JSON.parse(review.details_json);
        }

        console.log(`Fetched stock review history details for ID: ${id}`);
        res.json(review);
    } catch (error) {
        console.error('Error fetching stock review history details:', error);
        res.status(500).json({ message: 'Error fetching stock review history details' });
    }
};

// Get full inventory list for export (for download inventory list feature)
const getInventoryListExport = async (req, res) => {
    const { branch_id } = req.params;
    try {
        // Join products, branch_inventory, category, and supplier (if any)
        const [rows] = await db.pool.query(`
        SELECT 
            p.barcode,
            p.name as product_name,
            p.brand_name,
            c.name as category_name,
            bi.stock as quantity,
            p.critical,
            bi.batch_id as lot_number,
            bi.expiryDate as expiry_date,
            bi.expiryThreshold as expiry_warning_days,
            p.dosage_amount,
            p.dosage_unit,
            p.enable_packaging_conversion,
            p.packaging_unit,
            p.pieces_per_box as pieces_per_packaging,
            p.price_per_packaging,
            p.unit_price_per_piece,
            p.retail_price,
            p.wholesale_price,
            p.supplier_discount,
            p.total_pieces,
            p.description,
            p.sideEffects as side_effects,
            p.VATExempt,
            p.requiresPrescription
        FROM products p
        JOIN branch_inventory bi ON p.id = bi.product_id
        LEFT JOIN category c ON p.category = c.category_id
        WHERE bi.branch_id = ? AND bi.is_active = 1 AND p.is_active = 1
        ORDER BY p.name
    `, [branch_id]);
        res.json({
            inventory: rows,
            total_items: rows.length
        });
    } catch (error) {
        console.error('Error generating inventory list export:', error);
        res.status(500).json({ message: 'Error generating inventory list export' });
    }
};

// Save (upsert) session products for a given stock review session reference or id
const saveSessionProducts = async (req, res) => {
    const { session_id, reference, products = [] } = req.body;
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        let sessionId = session_id;

        // If reference is provided but not session_id, resolve it
        if (!sessionId && reference) {
            const [rows] = await connection.query(
                `SELECT id FROM stock_review_history WHERE reference = ? LIMIT 1`,
                [reference]
            );
            if (rows.length === 0) {
                await connection.rollback();
                return res.status(404).json({ message: 'Session not found' });
            }
            sessionId = rows[0].id;
        }

        if (!sessionId) {
            await connection.rollback();
            return res.status(400).json({ message: 'session_id or reference is required' });
        }

        // Upsert each product row into stock_session_products
        for (const p of products) {
            // frontend often sends identifiers inside product_info
            const productInfo = (p.product_info && typeof p.product_info === 'object') ? p.product_info : {};

            // derive identifiers from top-level fields or nested product_info
            const productId = p.product_id || productInfo.product_id || productInfo.id || null;
            const barcode = p.barcode || p.raw_barcode || productInfo.barcode || null;
            const system_stock = p.system_stock != null ? p.system_stock : (productInfo.system_stock != null ? productInfo.system_stock : 0);
            const actual_count = p.actual_count != null ? p.actual_count : (productInfo.actual_count != null ? productInfo.actual_count : null);
            // Normalize status: only allow 'pending' or 'saved'. Any other value -> 'pending'
            let status = (p.status || productInfo.status || '').toString().toLowerCase();
            if (status !== 'pending' && status !== 'saved') status = 'pending';
            const details_json = p.details_json ? JSON.stringify(p.details_json) : (productInfo.details_json ? JSON.stringify(productInfo.details_json) : null);

            // resolve inventory / batch / lot identifiers from multiple possible fields
            const invId = p.inventory_id || productInfo.inventory_id || productInfo.inventoryId || null;
            const batchId = p.batch_id || p.lot_number || p.lotNumber || productInfo.batch_id || productInfo.lot_number || productInfo.lotNumber || null;
            const lotNum = p.lot_number || p.lotNumber || productInfo.lot_number || productInfo.lotNumber || null;

            // Try to find existing row by most specific identifiers to avoid collapsing distinct rows
            let whereClause = '';
            let params = [];

            if (invId) {
                whereClause = 'session_id = ? AND inventory_id = ?';
                params = [sessionId, invId];
            } else if (productId && (batchId || lotNum)) {
                whereClause = 'session_id = ? AND product_id = ? AND (batch_id = ? OR lot_number = ?)';
                params = [sessionId, productId, batchId, lotNum];
            } else if (productId) {
                whereClause = 'session_id = ? AND product_id = ?';
                params = [sessionId, productId];
            } else if (barcode && (batchId || lotNum)) {
                whereClause = 'session_id = ? AND barcode = ? AND (batch_id = ? OR lot_number = ?)';
                params = [sessionId, barcode, batchId, lotNum];
            } else if (barcode) {
                whereClause = 'session_id = ? AND barcode = ?';
                params = [sessionId, barcode];
            } else {
                // Insert even without product reference (allow free text rows)
                await connection.query(
                    `INSERT INTO stock_session_products
                     (session_id, product_id, barcode, product_name, brand_name, category_name, inventory_id, batch_id, lot_number, expiry_date, system_stock, actual_count, status, details_json, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${getMySQLTimestamp()})`,
                    [sessionId, productId, barcode, p.product_name || productInfo.product_name || null, p.brand_name || productInfo.brand_name || null, p.category_name || productInfo.category_name || null, invId || null, batchId || null, lotNum || null, p.expiry_date || productInfo.expiry_date || null, system_stock, actual_count, status, details_json]
                );
                continue;
            }

            const [existing] = await connection.query(
                `SELECT id FROM stock_session_products WHERE ${whereClause} LIMIT 1`,
                params
            );

            if (existing.length > 0) {
                await connection.query(
                    `UPDATE stock_session_products SET product_id = ?, barcode = ?, product_name = ?, brand_name = ?, category_name = ?, inventory_id = ?, batch_id = ?, lot_number = ?, expiry_date = ?, system_stock = ?, actual_count = ?, status = ?, details_json = ?, created_at = ${getMySQLTimestamp()} WHERE id = ?`,
                    [productId, barcode, p.product_name || productInfo.product_name || null, p.brand_name || productInfo.brand_name || null, p.category_name || productInfo.category_name || null, invId || null, batchId || null, lotNum || null, p.expiry_date || productInfo.expiry_date || null, system_stock, actual_count, status, details_json, existing[0].id]
                );
            } else {
                await connection.query(
                    `INSERT INTO stock_session_products
                     (session_id, product_id, barcode, product_name, brand_name, category_name, inventory_id, batch_id, lot_number, expiry_date, system_stock, actual_count, status, details_json, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${getMySQLTimestamp()})`,
                    [sessionId, productId, barcode, p.product_name || productInfo.product_name || null, p.brand_name || productInfo.brand_name || null, p.category_name || productInfo.category_name || null, invId || null, batchId || null, lotNum || null, p.expiry_date || productInfo.expiry_date || null, system_stock, actual_count, status, details_json]
                );
            }
        }

        await connection.commit();
        res.json({ message: 'Session products saved', session_id: sessionId, saved: products.length });
    } catch (error) {
        await connection.rollback();
        console.error('[StockReview] Error saving session products:', error);
        res.status(500).json({ message: 'Error saving session products', error: error.message });
    } finally {
        connection.release();
    }
};

// Retrieve saved products for a session
const getSessionProducts = async (req, res) => {
    const { session_id, reference } = req.query;
    try {
        let sessionId = session_id;
        if (!sessionId && reference) {
            const [rows] = await db.pool.query(`SELECT id FROM stock_review_history WHERE reference = ? LIMIT 1`, [reference]);
            if (rows.length === 0) return res.status(404).json({ message: 'Session not found' });
            sessionId = rows[0].id;
        }
        if (!sessionId) return res.status(400).json({ message: 'session_id or reference is required' });

        // By default only return pending session products; caller can request all with show_all=true
        const showAll = req.query.show_all === 'true' || req.query.show_all === '1';
        const sql = showAll
            ? `SELECT * FROM stock_session_products WHERE session_id = ? ORDER BY created_at`
            : `SELECT * FROM stock_session_products WHERE session_id = ? AND status = 'pending' ORDER BY created_at`;

        const [rows] = await db.pool.query(sql, [sessionId]);
        res.json({ session_id: sessionId, products: rows });
    } catch (error) {
        console.error('[StockReview] Error fetching session products:', error);
        res.status(500).json({ message: 'Error fetching session products' });
    }
};


module.exports = {
    // Supplier Management
    getAllSuppliers,
    addSupplier,
    updateSupplier,
    deleteSupplier,
    getProductSuppliers,
    addProductSupplier,
    updateProductSupplier,
    removeProductSupplier,

    // Price Management
    getProductPriceHistory,
    calculateProductPrice,

    // Bulk Import
    validateBulkImport,
    searchProduct,
    checkBarcodeExists,
    checkProductMatch,
    processBulkImport,

    // Add getCategories to exports
    getCategories,

    // Archive Management
    getArchivedSuppliers,
    archiveSupplier,
    restoreSupplier,
    bulkArchiveSuppliers,
    bulkRestoreSuppliers,

    // Add new batch-related exports
    getBatches,
    getBatchDetails,
    archiveBatch,
    addBatch,
    updateBatch,

    // Add uploadReceipt function
    uploadReceipt,

    // Get all branches for dropdown selection
    getBranches,

    // Inventory History
    getInventoryHistory,
    getProductInventoryHistory,

    // Stock Review
    generateInventoryChecklist,
    processInventoryCount,
    applyStockAdjustments,
    // Manual stock review session endpoints
    startStockReviewSession,
    quickSaveStockReview,
    bulkProcessStockReview,
    endStockReviewSession,
    getLatestStockReviewByBranch,
    getStockReviewHistory,
    getStockReviewHistoryByBranch,
    getStockReviewHistoryDetails,
    // Session products
    saveSessionProducts,
    getSessionProducts,
    getInventoryListExport,
    checkSessionProductsExist
};

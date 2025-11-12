const db = require('../config/database');
const { getMySQLTimestamp } = require('../utils/timeZoneUtil');

// Product Search/Inquiry (F1)
const searchProducts = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    const { query, branchId } = req.query;

    console.log('Search request received:', { query, branchId });

    if (!query || !branchId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters',
      });
    }

    if (query.length < 3) {
      return res.status(400).json({
        success: false,
        message: 'Search query must be at least 3 characters',
      });
    }

    const searchPattern = `%${query}%`;

    const sqlQuery = `
            SELECT 
                p.id,
                p.name,
                p.brand_name,
                p.barcode,
                p.retail_price as price,
                p.wholesale_price,
                p.requiresPrescription,
                p.VATExempt,
                COALESCE(bi.stock, 0) as stock,
                bi.expiryDate as expiryDate,
                c.name as category_name,
                p.dosage_amount,
                p.dosage_unit,
                p.pieces_per_box
            FROM products p
            LEFT JOIN branch_inventory bi ON 
                p.id = bi.product_id AND 
                bi.branch_id = ? AND 
                bi.is_active = 1
            LEFT JOIN category c ON p.category = c.category_id
            WHERE p.is_active = 1
                AND (p.name LIKE ? 
                OR p.brand_name LIKE ? 
                OR p.barcode LIKE ?)
            ORDER BY
                CASE 
                    WHEN p.barcode = ? THEN 1
                    WHEN p.name LIKE ? THEN 2
                    WHEN p.brand_name LIKE ? THEN 3
                    ELSE 4
                END,
                p.name ASC
            LIMIT 50`;

    const [products] = await connection.query(sqlQuery, [
      branchId,
      searchPattern,
      searchPattern,
      searchPattern,
      query,
      `${query}%`,
      `${query}%`,
    ]);

    // Convert numeric fields to Numbers
    const processedProducts = products.map((product) => ({
      ...product,
      price: Number(product.price),
      wholesale_price: product.wholesale_price
        ? Number(product.wholesale_price)
        : null,
      stock: Number(product.stock),
      dosage_amount: product.dosage_amount
        ? Number(product.dosage_amount)
        : null,
      pieces_per_box: Number(product.pieces_per_box),
    }));

    res.json(processedProducts);
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({
      success: false,
      message: 'Database operation failed',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

// Hold Transaction (F3)
const holdTransaction = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    await connection.beginTransaction();

    const { salesSessionId, branchId, customerId, items, totalAmount, note } =
      req.body;

    console.log('Holding transaction:', {
      salesSessionId,
      branchId,
      customerId,
      itemCount: items.length,
      totalAmount,
    });

    // Get next hold number for this session
    const [holdCount] = await connection.query(
      'SELECT COUNT(*) as count FROM held_transactions WHERE sales_session_id = ?',
      [salesSessionId]
    );
    const holdNumber = holdCount[0].count + 1;

    // Insert held transaction
    const [result] = await connection.query(
      `INSERT INTO held_transactions SET 
            hold_number = ?,
            sales_session_id = ?,
            branch_id = ?,
            customer_id = ?,
            total_amount = ?,
            note = ?,
            created_at = ${getMySQLTimestamp()}`,
      [holdNumber, salesSessionId, branchId, customerId || null, totalAmount, note]
    );

    const heldTransactionId = result.insertId;

    // Insert held items
    for (const item of items) {
      await connection.query(
        `INSERT INTO held_transaction_items (
                    held_transaction_id, product_id,
                    quantity, unit_price, subtotal
                ) VALUES (?, ?, ?, ?, ?)`,
        [
          heldTransactionId,
          item.productId,
          item.quantity,
          item.unitPrice,
          item.subtotal,
        ]
      );
    }

    await connection.commit();
    console.log('Transaction held successfully:', {
      heldTransactionId,
      holdNumber,
      itemCount: items.length,
    });

    res.json({
      success: true,
      message: 'Transaction held successfully',
      holdNumber,
      heldTransactionId,
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error holding transaction:', error);
    res.status(500).json({
      success: false,
      message: 'Error holding transaction',
    });
  } finally {
    connection.release();
  }
};

// Recall Transaction (F4)
const getHeldTransactions = async (req, res) => {
  try {
    const { salesSessionId } = req.params;
    const showAll = req.query.showAll === 'true';

    const query = `
            SELECT 
                ht.id,
                ht.hold_number,
                CAST(ht.total_amount AS DECIMAL(10,2)) as total_amount,
                ht.created_at as created_at,
                COALESCE(c.name, 'Walk-in Customer') AS customer_name,
                COALESCE(GROUP_CONCAT(
                    CONCAT(p.name, ' (', hti.quantity, 'x)') 
                    SEPARATOR ', '
                ), 'No items') AS items_summary,
                ht.is_active
            FROM held_transactions ht
            LEFT JOIN customers c ON ht.customer_id = c.customer_id
            LEFT JOIN held_transaction_items hti 
                ON ht.id = hti.held_transaction_id
                AND hti.is_active = 1
            LEFT JOIN products p ON hti.product_id = p.id
            WHERE ht.sales_session_id = ?
            ${!showAll ? 'AND ht.is_active = 1' : ''}
            GROUP BY ht.id
            ORDER BY ht.created_at DESC`;

    const [transactions] = await db.pool.query(query, [salesSessionId]);

    // Convert numeric fields
    const processed = transactions.map((t) => ({
      ...t,
      total_amount: Number(t.total_amount),
    }));

    res.json({ success: true, data: processed });
  } catch (error) {
    console.error('Error getting held transactions:', error);
    res
      .status(500)
      .json({ success: false, message: 'Error getting held transactions' });
  }
};

// Delete held transaction after recall or abandonment
const deleteHeldTransaction = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    await connection.beginTransaction();

    // Update instead of delete
    await connection.query(
      `UPDATE held_transactions 
             SET is_active = 0 
             WHERE id = ?`,
      [req.params.heldTransactionId]
    );

    await connection.query(
      `UPDATE held_transaction_items 
             SET is_active = 0 
             WHERE held_transaction_id = ?`,
      [req.params.heldTransactionId]
    );

    await connection.commit();
    res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting held transaction:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to delete transaction' });
  } finally {
    connection.release();
  }
};

const completeTransaction = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      branchId,
      salesSessionId,
      pharmacistSessionId,
      customerName,
      starPointsId,
      discountType,
      discountAmount,
      discountIdNumber,
      paymentMethod = 'CASH',
      items = [],
      subtotal,
      discountedSubtotal,
      vat,
      total,
      amountTendered,
      change,
      pointsUsed = 0,
      referenceNumber = null,
      status = 'COMPLETE', // Add status field with default value
      receiptNumber = '0', // Add receipt number with default value
      // Return/Exchange mode fields
      isReturnMode = false,
      returnModeInfo = null,
    } = req.body;

    console.log('Transaction details:', {
      paymentMethod,
      amountTendered,
      total,
      items: items.length,
      isReturnMode,
      returnModeInfo: isReturnMode ? returnModeInfo : null,
    });

    // Handle exchange mode: validate exchange policy (no refunds, equal or higher value)
    if (isReturnMode && returnModeInfo) {
      // Get original transaction total for validation
      try {
        const [originalTransaction] = await connection.query(
          `SELECT total_amount FROM sales WHERE invoice_number = ?`,
          [returnModeInfo.originalInvoice]
        );

        if (originalTransaction.length === 0) {
          throw new Error(
            `Original transaction not found: ${returnModeInfo.originalInvoice}`
          );
        }

        const originalTotal = Number(originalTransaction[0].total_amount);

        // For exchange validation, we need to compare the total of NEW items (positive quantities)
        // against the original transaction total, not the final amount to pay
        const newItemsTotal = items
          .filter((item) => item.quantity > 0) // Only new items being purchased
          .reduce((sum, item) => sum + item.unit_price * item.quantity, 0);

        const returnItemsTotal = Math.abs(
          items
            .filter((item) => item.quantity < 0) // Only returned items (negative quantities)
            .reduce((sum, item) => sum + item.unit_price * item.quantity, 0)
        );

        console.log('Exchange validation details:', {
          originalTotal: originalTotal,
          newItemsTotal: newItemsTotal,
          returnItemsTotal: returnItemsTotal,
          finalAmountToPay: newItemsTotal - returnItemsTotal,
          originalInvoice: returnModeInfo.originalInvoice,
          returnReason: returnModeInfo.returnReason,
        });

        // Validate exchange policy: new items total must be >= return items total
        // This allows exchanges where customer pays the difference
        if (newItemsTotal < returnItemsTotal) {
          throw new Error(
            `Exchange not allowed. New items total (₱${newItemsTotal.toFixed(
              2
            )}) ` +
              `must be equal or greater than return credit (₱${returnItemsTotal.toFixed(
                2
              )})`
          );
        }

        console.log('Exchange validation passed:', {
          returnItemsTotal: returnItemsTotal,
          newItemsTotal: newItemsTotal,
          balanceToPay: newItemsTotal - returnItemsTotal,
          originalInvoice: returnModeInfo.originalInvoice,
          returnReason: returnModeInfo.returnReason,
        });

        // Mark original transaction as exchanged
        const updateResult = await connection.query(
          `UPDATE sales SET 
           status = 'EXCHANGED', 
           updated_at = ${getMySQLTimestamp()}
           WHERE invoice_number = ?`,
          [returnModeInfo.originalInvoice]
        );

        console.log(
          'Original transaction marked as EXCHANGED:',
          updateResult[0],
          'for invoice:',
          returnModeInfo.originalInvoice
        );

        if (updateResult[0].affectedRows === 0) {
          console.warn(
            'No rows updated - transaction not found:',
            returnModeInfo.originalInvoice
          );
        } else {
          console.log(
            'Successfully marked transaction as EXCHANGED:',
            returnModeInfo.originalInvoice
          );
        }
      } catch (error) {
        console.error('Error in exchange validation/update:', error);
        throw error; // Stop transaction if exchange validation fails
      }
    }

    // Generate invoice number
    const [branch] = await connection.query(
      'SELECT branch_code FROM branches WHERE branch_id = ?',
      [branchId]
    );

    const date = new Date();
    const branchCode = branch[0].branch_code;
    const month = `0${date.getMonth() + 1}`.slice(-2);
    const day = `0${date.getDate()}`.slice(-2);
    const year = date.getFullYear().toString().slice(-2);
    const hours = `0${date.getHours()}`.slice(-2);
    const minutes = `0${date.getMinutes()}`.slice(-2);

    const formattedDate = month + day + year;
    const time = hours + minutes;

    const [sequence] = await connection.query(
      `SELECT COALESCE(MAX(daily_sequence), 0) + 1 as next_sequence 
       FROM sales 
       WHERE branch_id = ? AND DATE(created_at) = CURDATE()`,
      [branchId]
    );

    const dailySequence = sequence[0].next_sequence.toString().padStart(4, '0');
    const invoiceNumber = `${branchCode}-${formattedDate}-${time}-${dailySequence}`;

    // Calculate points earned (1:200 ratio) - no points for exchanges
    const pointsEarned = isReturnMode
      ? 0
      : Math.round((subtotal / 200) * 100) / 100;

    // Get customer_id and star_points_id
    let customerId = null;
    let starPointsRecordId = null;

    if (starPointsId && starPointsId !== '001') {
      const [customer] = await connection.query(
        `SELECT c.customer_id, sp.star_points_id, sp.points_balance 
         FROM customers c
         LEFT JOIN star_points sp ON c.customer_id = sp.customer_id
         WHERE c.card_id = ?`,
        [starPointsId]
      );

      if (customer.length > 0) {
        customerId = customer[0].customer_id;
        starPointsRecordId = customer[0].star_points_id;

        // Handle points redemption if using points discount
        if (discountType === 'Points' && pointsUsed > 0) {
          // Update star_points balance
          await connection.query(
            `UPDATE star_points 
             SET points_balance = points_balance - ?,
                 total_points_redeemed = total_points_redeemed + ?,
                 updated_at = ${getMySQLTimestamp()}
             WHERE star_points_id = ?`,
            [pointsUsed, pointsUsed, starPointsRecordId]
          );

          // Record points redemption transaction
          await connection.query(
            `INSERT INTO star_points_transactions 
             (star_points_id, points_amount, transaction_type, reference_transaction_id, created_at)
             VALUES (?, ?, 'REDEEMED', ?, ${getMySQLTimestamp()})`,
            [starPointsRecordId, pointsUsed, invoiceNumber]
          );
        }

        // Add earned points
        if (pointsEarned > 0) {
          // Update star_points balance
          await connection.query(
            `UPDATE star_points 
             SET points_balance = points_balance + ?,
                 total_points_earned = total_points_earned + ?,
                 updated_at = ${getMySQLTimestamp()}
             WHERE star_points_id = ?`,
            [pointsEarned, pointsEarned, starPointsRecordId]
          );

          // Record points earned transaction
          await connection.query(
            `INSERT INTO star_points_transactions 
             (star_points_id, points_amount, transaction_type, reference_transaction_id, created_at)
             VALUES (?, ?, 'EARNED', ?, ${getMySQLTimestamp()})`,
            [starPointsRecordId, pointsEarned, invoiceNumber]
          );
        }
      }
    }

    // Handle return/exchange mode
    if (isReturnMode && returnModeInfo) {
      console.log('Processing return/exchange transaction:', {
        originalInvoice: returnModeInfo.originalInvoice,
        returnReason: returnModeInfo.returnReason,
        authorizedBy: returnModeInfo.authorizedBy,
        returnModeInfo: returnModeInfo, // Log the entire object
      });

      // Mark original transaction as returned
      try {
        const updateResult = await connection.query(
          `UPDATE sales SET 
           status = 'RETURNED', 
           updated_at = ${getMySQLTimestamp()}
           WHERE invoice_number = ?`,
          [returnModeInfo.originalInvoice]
        );
        console.log(
          'Original transaction update result:',
          updateResult[0],
          'for invoice:',
          returnModeInfo.originalInvoice
        );

        if (updateResult[0].affectedRows === 0) {
          console.warn(
            'No rows updated - transaction not found:',
            returnModeInfo.originalInvoice
          );
        } else {
          console.log(
            'Successfully marked transaction as RETURNED:',
            returnModeInfo.originalInvoice
          );
        }
      } catch (error) {
        console.error('Error updating original transaction status:', error);
        // Continue with the transaction even if this fails
      }
    }

    // Insert sale with payment status
    const [saleResult] = await connection.query(
      `INSERT INTO sales SET 
        invoice_number = ?,
        receipt_number = ?,
        customer_id = ?,
        total_amount = ?,
        discount_amount = ?,
        discount_type = ?,
        discount_id_number = ?,
        payment_method = ?,
        payment_status = ?,
        status = ?,
        branch_id = ?,
        pharmacist_session_id = ?,
        points_earned = ?,
        points_redeemed = ?,
        amount_tendered = ?,
        amount_change = ?,
        created_at = ${getMySQLTimestamp()},
        daily_sequence = ?`,
      [
        invoiceNumber,
        receiptNumber,
        customerId || null, // Use NULL instead of 1 for walk-in customers
        total || 0,
        discountAmount || 0,
        discountType || 'None',
        discountIdNumber || null,
        (paymentMethod || 'CASH').toLowerCase(),
        'paid', // Set initial payment status
        status || 'COMPLETE', // Add status parameter
        branchId,
        pharmacistSessionId,
        pointsEarned || 0,
        pointsUsed || 0,
        parseFloat(amountTendered) || 0,
        parseFloat(change) || 0,
        dailySequence,
      ]
    );

    const saleId = saleResult.insertId;

    console.log('Sales record created:', {
      saleId,
      invoiceNumber,
      status: status || 'COMPLETE',
      actualStatusSaved: status,
    });

    console.log('Transaction completion request:', {
      invoiceNumber,
      branchId,
      itemsCount: items?.length || 0,
      items: items?.map((item) => ({
        product_id: item.product_id,
        quantity: item.quantity,
        is_void: item.is_void,
      })),
    });

    // Insert sale items and update inventory
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        // Generate unique transaction_id for each item: invoice_number + item sequence
        const itemTransactionId = `${invoiceNumber}-${(i + 1)
          .toString()
          .padStart(3, '0')}`;

        // Determine if item is voided (default to false if not specified)
        const isVoid = item.is_void === true ? 1 : 0;

        // For return mode, quantities and prices should be negative
        await connection.query(
          `INSERT INTO sale_items SET 
            sale_id = ?,
            product_id = ?,
            quantity = ?,
            unit_price = ?,
            total_price = ?,
            transaction_id = ?,
            is_void = ?`,
          [
            saleId,
            item.product_id,
            item.quantity,
            item.unit_price,
            item.subtotal,
            itemTransactionId,
            isVoid,
          ]
        );

        // Update inventory
        if (!isVoid) {
          if (item.quantity < 0) {
            // For return items (negative quantities), add back to stock
            console.log(
              `Returning item ${item.product_id}: Adding ${Math.abs(
                item.quantity
              )} back to stock`
            );
            await connection.query(
              `UPDATE branch_inventory 
               SET stock = stock + ?
               WHERE branch_id = ? AND product_id = ?`,
              [Math.abs(item.quantity), branchId, item.product_id]
            );
          } else {
            // For regular items, reduce stock normally
            console.log(
              `Purchasing item ${item.product_id}: Reducing stock by ${item.quantity}`
            );
            await connection.query(
              `UPDATE branch_inventory 
               SET stock = stock - ?
               WHERE branch_id = ? AND product_id = ?`,
              [item.quantity, branchId, item.product_id]
            );
          }
        }
      }
    }

    // Insert payment with proper validation
    const paymentAmount = parseFloat(amountTendered);
    if (isNaN(paymentAmount) || paymentAmount <= 0) {
      throw new Error('Invalid payment amount');
    }

    await connection.query(
      `INSERT INTO sales_payments SET 
        sale_id = ?,
        payment_method = ?,
        amount = ?,
        reference_number = ?,
        created_at = ${getMySQLTimestamp()}`,
      [saleId, paymentMethod.toLowerCase(), paymentAmount, referenceNumber]
    );

    // Update sales session
    await connection.query(
      `UPDATE sales_sessions 
       SET total_sales = total_sales + ?
       WHERE session_id = ?`,
      [total, salesSessionId]
    );

    await connection.commit();

    console.log('Transaction completed successfully:', {
      invoiceNumber,
      saleId,
      paymentMethod,
      amountTendered: paymentAmount,
      total,
    });

    res.json({
      success: true,
      saleId,
      invoiceNumber,
      dailySequence,
      pointsEarned,
      message: 'Transaction completed successfully',
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error completing transaction:', error);
    res.status(500).json({
      success: false,
      message: 'Error completing transaction',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

const searchByBarcode = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    const { barcode } = req.params;
    const { branchId } = req.query;

    console.log('Barcode search request:', {
      barcode,
      branchId,
      timestamp: new Date().toISOString(),
    });

    // Use exact match for barcode search
    const [products] = await connection.query(
      `
            SELECT 
                p.id,
                p.name,
                p.brand_name,
                p.barcode,
                p.retail_price as price,
                 p.wholesale_price,
                p.requiresPrescription,
                p.VATExempt,
                COALESCE(bi.stock, 0) as stock,
                bi.expiryDate as expiryDate,
                c.name as category_name,
                p.dosage_amount,
                p.dosage_unit,
                p.pieces_per_box
            FROM products p
            LEFT JOIN branch_inventory bi 
                ON p.id = bi.product_id 
                AND bi.branch_id = ?
                AND bi.is_active = 1
            LEFT JOIN category c 
                ON p.category = c.category_id
            WHERE UPPER(p.barcode) = UPPER(?) 
                AND p.is_active = 1
            LIMIT 1`,
      [branchId, barcode]
    );

    if (products.length === 0) {
      console.log(`No product found for barcode: ${barcode}`);
      return res.status(404).json({ error: 'Product not found' });
    }

    console.log('Product found:', {
      barcode,
      productId: products[0].id,
      name: products[0].name,
    });

    // Convert numeric fields to Numbers
    const processedProducts = products.map((product) => ({
      ...product,
      price: Number(product.price),
      wholesale_price: product.wholesale_price
        ? Number(product.wholesale_price)
        : null,
      stock: Number(product.stock),
      dosage_amount: product.dosage_amount
        ? Number(product.dosage_amount)
        : null,
      pieces_per_box: Number(product.pieces_per_box),
    }));

    res.json(processedProducts[0]);
  } catch (error) {
    console.error('Barcode search error:', error);
    res.status(500).json({ error: 'Database error' });
  } finally {
    connection.release();
  }
};

const createPrescription = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      customerId,
      doctorName,
      licenseNumber,
      prescriptionDate,
      expiryDate,
      notes,
      items,
    } = req.body;

    // Handle image upload
    let imageData = null;
    let imageType = null;
    if (req.files && req.files.image) {
      const file = req.files.image;
      imageData = file.data;
      imageType = file.mimetype.split('/')[1].toUpperCase();
    }

    // Insert prescription
    const [result] = await connection.query(
      `INSERT INTO prescriptions SET
        customer_id = ?,
        doctor_name = ?,
        doctor_license_number = ?,
        prescription_date = ?,
        expiry_date = ?,
        notes = ?,
        image_data = ?,
        image_type = ?,
        image_upload_date = ${getMySQLTimestamp()},
        status = 'ACTIVE',
        created_at = ${getMySQLTimestamp()},
        updated_at = ${getMySQLTimestamp()}`,
      [
        customerId,
        doctorName,
        licenseNumber,
        prescriptionDate,
        expiryDate,
        notes,
        imageData,
        imageType,
      ]
    );

    // Insert prescription items
    for (const item of items) {
      await connection.query(
        `INSERT INTO prescription_items SET
          prescription_id = ?,
          product_id = ?,
          prescribed_quantity = ?,
          dispensed_quantity = 0,
          dosage_instructions = ?,
          created_at = ${getMySQLTimestamp()},
          updated_at = ${getMySQLTimestamp()}`,
        [
          result.insertId,
          item.id,
          item.quantity,
          item.dosage_instructions || null,
        ]
      );
    }

    await connection.commit();

    console.log('Prescription created:', {
      prescriptionId: result.insertId,
      items: items.length,
    });

    res.json({
      success: true,
      prescriptionId: result.insertId,
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating prescription:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating prescription',
    });
  } finally {
    connection.release();
  }
};

const getTransactionById = async (req, res) => {
  try {
    const { id } = req.params;

    // Get transaction details with items
    const [transaction] = await db.pool.query(
      `SELECT 
                s.id,
                s.total_amount,
                s.created_at as date,
                s.payment_status,
                si.id as item_id,
                si.product_id,
                si.quantity,
                si.unit_price,
                p.name as product_name
            FROM sales s
            JOIN sale_items si ON s.id = si.sale_id
            JOIN products p ON si.product_id = p.id
            WHERE s.id = ? AND s.is_active = 1`,
      [id]
    );

    if (transaction.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found',
      });
    }

    // Format response
    const formattedTransaction = {
      id: transaction[0].id,
      date: transaction[0].date,
      total: transaction[0].total_amount,
      status: transaction[0].payment_status,
      items: transaction.map((item) => ({
        id: item.item_id,
        productId: item.product_id,
        name: item.product_name,
        quantity: item.quantity,
        price: item.unit_price,
      })),
    };

    console.log('Transaction retrieved:', id);
    res.json(formattedTransaction);
  } catch (error) {
    console.error('Error getting transaction:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving transaction',
    });
  }
};

const processReturn = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      originalInvoiceNumber,
      returnItems,
      returnReason,
      pharmacistSessionId,
    } = req.body;

    console.log('Processing return:', {
      invoice: originalInvoiceNumber,
      itemCount: returnItems.length,
      reason: returnReason,
    });

    // Get original sale
    const [sale] = await connection.query(
      `SELECT * FROM sales WHERE invoice_number = ?`,
      [originalInvoiceNumber]
    );

    if (!sale.length) {
      throw new Error('Original sale not found');
    }

    // Calculate return amount
    const returnAmount = returnItems.reduce(
      (sum, item) => sum + item.price * item.returnQuantity,
      0
    );

    // Create return record
    const [returnResult] = await connection.query(
      `INSERT INTO returns 
             (original_sale_id, return_amount, reason, 
              pharmacist_session_id, status, created_at)
             VALUES (?, ?, ?, ?, 'PENDING', ${getMySQLTimestamp()})`,
      [sale[0].id, returnAmount, returnReason, pharmacistSessionId]
    );

    // Insert return items
    for (const item of returnItems) {
      await connection.query(
        `INSERT INTO return_items 
                 (return_id, product_id, quantity, unit_price)
                 VALUES (?, ?, ?, ?)`,
        [returnResult.insertId, item.id, item.returnQuantity, item.price]
      );
    }

    await connection.commit();

    console.log('Return processed successfully:', {
      returnId: returnResult.insertId,
      amount: returnAmount,
    });

    res.json({
      success: true,
      message: 'Return processed successfully',
      returnId: returnResult.insertId,
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error processing return:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing return',
    });
  } finally {
    connection.release();
  }
};

// Step 1: Get transaction details for return (validates receipt number)
const getTransactionForReturn = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    const { receiptNumber, branchId } = req.query;

    console.log('Getting transaction for return:', { receiptNumber, branchId });

    // Get transaction with items
    const [transaction] = await connection.query(
      `SELECT 
        s.*,
        COALESCE(c.name, 'Walk-in Customer') as customer_name
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.customer_id
      WHERE s.invoice_number = ? 
        AND s.branch_id = ?
        AND s.status NOT IN ('VOID', 'RETURN')`,
      [receiptNumber, branchId]
    );

    if (transaction.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found or already returned/voided',
      });
    }

    // Get transaction items
    const [items] = await connection.query(
      `SELECT 
        si.*,
        p.name as product_name,
        p.brand_name,
        p.barcode,
        p.retail_price,
        p.wholesale_price
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = ? AND si.is_void = 0
      ORDER BY si.id`,
      [transaction[0].id]
    );

    const transactionData = {
      ...transaction[0],
      items: items.map((item) => ({
        ...item,
        unit_price: Number(item.unit_price),
        total_price: Number(item.total_price),
        retail_price: Number(item.retail_price),
        wholesale_price: Number(item.wholesale_price),
      })),
    };

    console.log('Transaction found for return:', receiptNumber);
    res.json({
      success: true,
      transaction: transactionData,
    });
  } catch (error) {
    console.error('Error getting transaction for return:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving transaction details',
    });
  } finally {
    connection.release();
  }
};

// Step 2: Validate return and start exchange process
const validateReturnAndStartExchange = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      originalTransactionId,
      branchId,
      returnItems, // Array of items being returned
      returnReason,
      authorizedBy,
      authorizedByName,
    } = req.body;

    console.log('Validating return for exchange:', {
      transactionId: originalTransactionId,
      returnItems: returnItems.length,
      reason: returnReason,
    });

    // Get original sale
    const [sale] = await connection.query(
      `SELECT * FROM sales WHERE invoice_number = ? AND branch_id = ?`,
      [originalTransactionId, branchId]
    );

    if (!sale.length) {
      throw new Error('Original sale not found');
    }

    if (sale[0].status === 'RETURN' || sale[0].status === 'VOID') {
      throw new Error('Transaction is already returned or voided');
    }

    // Calculate total return amount
    const returnAmount = returnItems.reduce(
      (sum, item) => sum + item.unit_price * item.quantity,
      0
    );

    // Log the return validation
    await connection.query(
      `INSERT INTO logs (employee_id, name, role, branch_id, action, description, timestamp)
       VALUES (?, ?, 'PHARMACIST', ?, 'RETURN_VALIDATED', ?, ${getMySQLTimestamp()})`,
      [
        authorizedBy,
        authorizedByName,
        branchId,
        `RETURN VALIDATED - Receipt: ${originalTransactionId} | Items: ${returnItems.length
        } | Return Amount: ₱${returnAmount.toFixed(
          2
        )} | Reason: ${returnReason} | Authorized by: ${authorizedByName}`,
      ]
    );

    await connection.commit();

    res.json({
      success: true,
      message: 'Return validated. You can now add new items for exchange.',
      originalTransactionId,
      returnAmount,
      returnItems,
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error validating return:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating return: ' + error.message,
    });
  } finally {
    connection.release();
  }
};

// Step 3: Complete the exchange transaction
const completeExchangeTransaction = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      originalTransactionId,
      branchId,
      salesSessionId,
      pharmacistSessionId,
      returnItems,
      newItems,
      returnReason,
      authorizedBy,
      authorizedByName,
      // Payment details for difference (if any)
      paymentMethod = 'CASH',
      amountTendered = 0,
      change = 0,
    } = req.body;

    console.log('Completing exchange transaction:', {
      originalTransactionId,
      returnItems: returnItems.length,
      newItems: newItems.length,
    });

    // Calculate amounts
    const returnAmount = returnItems.reduce(
      (sum, item) => sum + item.unit_price * item.quantity,
      0
    );
    const newAmount = newItems.reduce(
      (sum, item) => sum + item.unit_price * item.quantity,
      0
    );
    const difference = newAmount - returnAmount;

    // Validate that new amount is >= return amount
    if (newAmount < returnAmount) {
      throw new Error(
        'New items total must be greater than or equal to returned items total'
      );
    }

    // Get original sale details
    const [originalSale] = await connection.query(
      `SELECT * FROM sales WHERE invoice_number = ? AND branch_id = ?`,
      [originalTransactionId, branchId]
    );

    if (!originalSale.length) {
      throw new Error('Original sale not found');
    }

    // Mark original transaction as RETURN
    await connection.query(
      `UPDATE sales SET 
        status = 'RETURN',
        updated_at = ${getMySQLTimestamp()}
       WHERE invoice_number = ?`,
      [originalTransactionId]
    );

    // Restore inventory for returned items
    for (const item of returnItems) {
      await connection.query(
        `UPDATE branch_inventory 
         SET stock = stock + ?
         WHERE branch_id = ? AND product_id = ?`,
        [item.quantity, branchId, item.product_id]
      );
    }

    // Generate new invoice number for exchange transaction
    const [branch] = await connection.query(
      'SELECT branch_code FROM branches WHERE branch_id = ?',
      [branchId]
    );

    const date = new Date();
    const branchCode = branch[0].branch_code;
    const month = `0${date.getMonth() + 1}`.slice(-2);
    const day = `0${date.getDate()}`.slice(-2);
    const year = date.getFullYear().toString().slice(-2);
    const hours = `0${date.getHours()}`.slice(-2);
    const minutes = `0${date.getMinutes()}`.slice(-2);

    const [sequence] = await connection.query(
      `SELECT COALESCE(MAX(daily_sequence), 0) + 1 as next_sequence 
       FROM sales 
       WHERE branch_id = ? AND DATE(created_at) = CURDATE()`,
      [branchId]
    );

    const dailySequence = sequence[0].next_sequence.toString().padStart(4, '0');
    const newInvoiceNumber = `${branchCode}-${month}${day}${year}-${hours}${minutes}-${dailySequence}`;

    // Create new exchange transaction
    const [newSaleResult] = await connection.query(
      `INSERT INTO sales SET 
        invoice_number = ?,
        customer_id = ?,
        total_amount = ?,
        discount_amount = 0,
        discount_type = 'Exchange',
        payment_method = ?,
        payment_status = 'paid',
        status = 'COMPLETE',
        branch_id = ?,
        pharmacist_session_id = ?,
        amount_tendered = ?,
        amount_change = ?,
        created_at = ${getMySQLTimestamp()},
        daily_sequence = ?`,
      [
        newInvoiceNumber,
        originalSale[0].customer_id,
        difference, // Only charge the difference
        paymentMethod.toLowerCase(),
        branchId,
        pharmacistSessionId,
        parseFloat(amountTendered),
        parseFloat(change),
        dailySequence,
      ]
    );

    const newSaleId = newSaleResult.insertId;

    // Insert new sale items and update inventory
    for (let i = 0; i < newItems.length; i++) {
      const item = newItems[i];
      const itemTransactionId = `${newInvoiceNumber}-${(i + 1)
        .toString()
        .padStart(3, '0')}`;

      await connection.query(
        `INSERT INTO sale_items SET 
          sale_id = ?,
          product_id = ?,
          quantity = ?,
          unit_price = ?,
          total_price = ?,
          transaction_id = ?,
          is_void = 0`,
        [
          newSaleId,
          item.product_id,
          item.quantity,
          item.unit_price,
          item.subtotal,
          itemTransactionId,
        ]
      );

      // Update inventory for new items
      await connection.query(
        `UPDATE branch_inventory 
         SET stock = stock - ?
         WHERE branch_id = ? AND product_id = ?`,
        [item.quantity, branchId, item.product_id]
      );
    }

    // Insert payment record if there's a difference to pay
    if (difference > 0 && amountTendered > 0) {
      await connection.query(
        `INSERT INTO sales_payments SET 
          sale_id = ?,
          payment_method = ?,
          amount = ?,
          created_at = ${getMySQLTimestamp()}`,
        [newSaleId, paymentMethod.toLowerCase(), parseFloat(amountTendered)]
      );
    }

    // Update sales session
    await connection.query(
      `UPDATE sales_sessions 
       SET total_sales = total_sales + ?
       WHERE session_id = ?`,
      [difference, salesSessionId]
    );

    // Log the complete exchange
    await connection.query(
      `INSERT INTO logs (employee_id, name, role, branch_id, action, description, timestamp)
       VALUES (?, ?, 'PHARMACIST', ?, 'EXCHANGE_COMPLETED', ?, ${getMySQLTimestamp()})`,
      [
        authorizedBy,
        authorizedByName,
        branchId,
        `EXCHANGE COMPLETED - Original: ${originalTransactionId} | New: ${newInvoiceNumber} | Return Amount: ₱${returnAmount.toFixed(
          2
        )} | New Amount: ₱${newAmount.toFixed(
          2
        )} | Difference: ₱${difference.toFixed(
          2
        )} | Reason: ${returnReason} | Authorized by: ${authorizedByName}`,
      ]
    );

    await connection.commit();

    console.log('Exchange transaction completed:', {
      originalInvoiceNumber: originalTransactionId,
      newInvoiceNumber,
      returnAmount,
      newAmount,
      difference,
    });

    res.json({
      success: true,
      message: 'Exchange completed successfully',
      originalInvoiceNumber: originalTransactionId,
      newInvoiceNumber,
      newSaleId,
      returnAmount,
      newAmount,
      difference,
      dailySequence,
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error completing exchange:', error);
    res.status(500).json({
      success: false,
      message: 'Error completing exchange: ' + error.message,
    });
  } finally {
    connection.release();
  }
};

const processSingleItemReturn = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      originalTransactionId,
      branchId,
      returnItem,
      returnReason,
      authorizedBy,
      authorizedByName,
    } = req.body;

    console.log('Processing single item return:', {
      transactionId: originalTransactionId,
      branchId,
      returnItem,
      reason: returnReason,
      authorizedBy,
    });

    // Get original sale
    const [sale] = await connection.query(
      `SELECT * FROM sales WHERE invoice_number = ?`,
      [originalTransactionId]
    );

    if (!sale.length) {
      throw new Error('Original sale not found');
    }

    // Check if transaction is already returned
    if (sale[0].status === 'RETURN') {
      throw new Error('Transaction is already returned');
    }

    // Update the sale status to RETURN
    await connection.query(
      `UPDATE sales SET 
        status = 'RETURN',
        updated_at = ${getMySQLTimestamp()}
       WHERE invoice_number = ?`,
      [originalTransactionId]
    );

    // Restore inventory for the returned item
    await connection.query(
      `UPDATE branch_inventory 
       SET stock = stock + ?
       WHERE branch_id = ? AND product_id = ?`,
      [returnItem.quantity, branchId, returnItem.product_id]
    );

    // Log the return action
    await connection.query(
      `INSERT INTO logs (employee_id, name, role, branch_id, action, description, timestamp)
       VALUES (?, ?, 'PHARMACIST', ?, 'ITEM_RETURN', ?, ${getMySQLTimestamp()})`,
      [
        authorizedBy,
        authorizedByName,
        branchId,
        `ITEM RETURN - Receipt: ${originalTransactionId} | Product: ${returnItem.product_name
        } | Quantity: ${returnItem.quantity} | Amount: ₱${(
          returnItem.unit_price * returnItem.quantity
        ).toFixed(
          2
        )} | Reason: ${returnReason} | Authorized by: ${authorizedByName}`,
      ]
    );

    await connection.commit();

    console.log('Single item return processed successfully:', {
      transactionId: originalTransactionId,
      productId: returnItem.product_id,
      quantity: returnItem.quantity,
      reason: returnReason,
    });

    res.json({
      success: true,
      message: 'Return processed successfully',
      transactionId: originalTransactionId,
      returnAmount: returnItem.unit_price * returnItem.quantity,
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error processing single item return:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing return: ' + error.message,
    });
  } finally {
    connection.release();
  }
};

const getNextSequence = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    const { branchId } = req.query;
    const today = new Date().toISOString().slice(0, 10);

    // Get the current daily sequence for this branch and date
    const [rows] = await connection.query(
      `SELECT COALESCE(MAX(daily_sequence), 0) + 1 as next_sequence 
       FROM sales 
       WHERE DATE(created_at) = ? AND branch_id = ?`,
      [today, branchId]
    );

    console.log(
      `Generated next sequence for branch ${branchId}:`,
      rows[0].next_sequence
    );

    res.json({
      daily_sequence: rows[0].next_sequence,
      branch_id: branchId,
      date: today,
    });
  } catch (error) {
    console.error('Error getting next sequence:', error);
    res.status(500).json({ error: 'Failed to generate sequence' });
  } finally {
    connection.release();
  }
};

const createSalesSession = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    const { branchId } = req.body;
    const { id: pharmacistId } = req.user;

    const [result] = await connection.query(
      `INSERT INTO sales_sessions SET 
        branch_id = ?,
        start_time = ${getMySQLTimestamp()},
        total_sales = 0.00`,
      [branchId]
    );

    await connection.query(
      `INSERT INTO pharmacist_sessions SET 
        session_id = ?,
        staff_id = ?,
        created_at = ${getMySQLTimestamp()}`,
      [result.insertId, pharmacistId]
    );

    res.json({
      success: true,
      sessionId: result.insertId,
      branchId,
    });
  } catch (error) {
    console.error('Error creating sales session:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to start sales session' });
  } finally {
    connection.release();
  }
};

const closeSalesSession = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    const { sessionId } = req.params;

    await connection.query(
      `UPDATE sales_sessions SET 
        end_time = ${getMySQLTimestamp()}
       WHERE session_id = ?`,
      [sessionId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error closing sales session:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to close sales session' });
  } finally {
    connection.release();
  }
};

const getHeldTransactionItems = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    const { heldTransactionId } = req.params;

    // First get the branch_id from held_transaction
    const [transaction] = await connection.query(
      `SELECT branch_id 
             FROM held_transactions 
             WHERE id = ?`,
      [heldTransactionId]
    );

    if (transaction.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Held transaction not found',
      });
    }

    const branchId = transaction[0].branch_id;

    // Then use it in the main query
    const [items] = await connection.query(
      `SELECT 
                hti.*,
                p.name,
                p.brand_name,
                p.barcode,
                p.retail_price,
                p.wholesale_price,
                p.requiresPrescription,
                p.VATExempt,
                p.pieces_per_box,
                c.name as category_name,
                bi.stock
             FROM held_transaction_items hti
             JOIN products p ON hti.product_id = p.id
             LEFT JOIN category c ON p.category = c.category_id
             LEFT JOIN branch_inventory bi ON 
                p.id = bi.product_id AND 
                bi.branch_id = ?
             WHERE hti.held_transaction_id = ?`,
      [branchId, heldTransactionId]
    );

    // Format the items to match CartItem structure
    const formattedItems = items.map((item) => ({
      id: item.product_id,
      name: item.name,
      brand_name: item.brand_name,
      barcode: item.barcode,
      price: Number(item.retail_price), // Use current retail price instead of stored unit_price
      quantity: Number(item.quantity),
      stock: Number(item.stock || 0),
      category_name: item.category_name,
      requiresPrescription: item.requiresPrescription,
      VATExempt: item.VATExempt,
      pieces_per_box: item.pieces_per_box,
    }));

    res.json(formattedItems);
  } catch (error) {
    console.error('Error getting held transaction items:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get held transaction items',
    });
  } finally {
    connection.release();
  }
};

const getCustomerByCard = async (req, res) => {
  try {
    const { cardId } = req.params;
    console.log('Searching for customer with card:', cardId);

    const [customer] = await db.pool.query(
      `SELECT c.*, sp.points_balance 
       FROM customers c
       LEFT JOIN star_points sp ON c.customer_id = sp.customer_id
       WHERE c.card_id = ?`,
      [cardId]
    );

    if (customer.length === 0) {
      console.log('No customer found with card:', cardId);
      return res
        .status(404)
        .json({ success: false, message: 'Customer not found' });
    }

    console.log('Customer found:', customer[0]);
    res.json({ success: true, data: customer[0] });
  } catch (error) {
    console.error('Error fetching customer:', error);
    res
      .status(500)
      .json({ success: false, message: 'Error fetching customer' });
  }
};

const createCustomerWithCard = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    await connection.beginTransaction();

    const { name, phone, address, discountType, discountId, cardId } = req.body;

    // Insert customer with card_id
    const [customerResult] = await connection.query(
      `INSERT INTO customers (
        name, phone, address, 
        discount_type, discount_id_number, card_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ${getMySQLTimestamp()}, ${getMySQLTimestamp()})`,
      [name, phone, address, discountType, discountId, cardId]
    );

    // Initialize star points
    await connection.query(
      `INSERT INTO star_points (
        customer_id, points_balance, total_points_earned,
        total_points_redeemed, created_at, updated_at
      ) VALUES (?, 0, 0, 0, ${getMySQLTimestamp()}, ${getMySQLTimestamp()})`,
      [customerResult.insertId]
    );

    // Get the complete customer data
    const [customer] = await connection.query(
      `SELECT c.*, sp.points_balance 
       FROM customers c
       LEFT JOIN star_points sp ON c.customer_id = sp.customer_id
       WHERE c.customer_id = ?`,
      [customerResult.insertId]
    );

    await connection.commit();

    console.log('Customer created:', {
      customerId: customerResult.insertId,
      cardId: cardId,
      customerData: customer[0],
    });

    res.json({
      success: true,
      data: customer[0],
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating customer:', error);
    res
      .status(500)
      .json({ success: false, message: 'Error creating customer' });
  } finally {
    connection.release();
  }
};

const generateInvoiceNumber = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    const { branchId } = req.query;

    // Get branch code
    const [branch] = await connection.query(
      'SELECT branch_code FROM branches WHERE branch_id = ?',
      [branchId]
    );

    const branchCode = branch[0].branch_code;

    // Get current date components
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const year = String(now.getFullYear()).slice(-2);
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    // Get daily sequence
    const [sequence] = await connection.query(
      `SELECT COALESCE(MAX(daily_sequence), 0) + 1 as next_sequence 
       FROM sales 
       WHERE branch_id = ? AND DATE(created_at) = CURDATE()`,
      [branchId]
    );

    const dailySequence = String(sequence[0].next_sequence).padStart(4, '0');

    // Format: J5P-B001-021025-0507-0002 (removed duplicate J5P)
    const invoiceNumber = `${branchCode}-${month}${day}${year}-${hours}${minutes}-${dailySequence}`;

    console.log('Generated invoice number:', invoiceNumber);
    res.json({ success: true, invoiceNumber });
  } catch (error) {
    console.error('Error generating invoice number:', error);
    res
      .status(500)
      .json({ success: false, message: 'Error generating invoice number' });
  } finally {
    connection.release();
  }
};

const getProductStock = async (req, res) => {
  try {
    const { branchId, productId } = req.params;

    const [stock] = await db.pool.query(
      `SELECT stock 
       FROM branch_inventory 
       WHERE branch_id = ? AND product_id = ?`,
      [branchId, productId]
    );

    if (stock.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Stock not found for this product',
      });
    }

    console.log('Stock check:', {
      branchId,
      productId,
      stock: stock[0].stock,
    });

    res.json({
      success: true,
      stock: stock[0].stock,
    });
  } catch (error) {
    console.error('Error checking stock:', error);
    res.status(500).json({
      success: false,
      message: 'Error checking stock',
    });
  }
};

// Get transaction details for voiding
const getTransactionDetails = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    const { date, receiptNumber, branchId } = req.query;

    console.log('Searching transaction:', { date, receiptNumber, branchId });

    // Get transaction with items
    const [transactions] = await connection.query(
      `SELECT 
        s.id,
        s.invoice_number,
        s.total_amount,
        s.discount_amount,
        s.discount_type,
        s.payment_method,
        s.amount_tendered,
        s.amount_change,
        s.created_at,
        s.status,
        COALESCE(c.name, 'Walk-in Customer') as customer_name
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.customer_id
      WHERE s.invoice_number = ? 
        AND DATE(s.created_at) = ?
        AND s.branch_id = ?`,
      [receiptNumber, date, branchId]
    );

    console.log('Sales found:', transactions.length);
    if (transactions.length > 0) {
      console.log('Sale details:', {
        id: transactions[0].id,
        invoice_number: transactions[0].invoice_number,
        date: transactions[0].created_at,
        status: transactions[0].status,
        status_type: typeof transactions[0].status,
      });
    }

    if (transactions.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found',
      });
    }

    // Get transaction items - using JOIN instead of subquery for better debugging
    const [items] = await connection.query(
      `SELECT 
        si.product_id,
        si.quantity,
        si.unit_price,
        si.total_price,
        si.is_void,
        p.name as product_name,
        p.brand_name,
        p.barcode,
        s.id as sale_id,
        s.invoice_number
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      JOIN sales s ON si.sale_id = s.id
      WHERE s.invoice_number = ? AND s.branch_id = ?
      ORDER BY si.id`,
      [receiptNumber, branchId]
    );

    console.log('Raw SQL query for items:', {
      receiptNumber,
      branchId,
      query: `SELECT si.product_id, si.quantity, si.unit_price, si.total_price, si.is_void, p.name as product_name, p.brand_name, p.barcode, s.id as sale_id, s.invoice_number 
              FROM sale_items si JOIN products p ON si.product_id = p.id JOIN sales s ON si.sale_id = s.id 
              WHERE s.invoice_number = '${receiptNumber}' AND s.branch_id = ${branchId} 
              ORDER BY si.id`,
    });

    console.log('Items found:', items.length);
    console.log('Items details:', items);

    const transaction = {
      ...transactions[0],
      items: items,
    };

    console.log('Transaction found:', receiptNumber);
    res.json({
      success: true,
      transaction: transaction,
    });
  } catch (error) {
    console.error('Error getting transaction details:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving transaction details',
    });
  } finally {
    connection.release();
  }
};

// Void transaction
const voidTransaction = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    await connection.beginTransaction();

    const { receiptNumber, branchId, authorizedBy, authorizedByName, reason } =
      req.body;

    console.log('Voiding transaction:', {
      receiptNumber,
      branchId,
      authorizedBy,
    });

    // Check if transaction exists and is not already voided
    const [transaction] = await connection.query(
      `SELECT id, status, total_amount FROM sales 
       WHERE invoice_number = ? AND branch_id = ?`,
      [receiptNumber, branchId]
    );

    if (transaction.length === 0) {
      throw new Error('Transaction not found');
    }

    if (transaction[0].status === 'VOID') {
      throw new Error('Transaction is already voided');
    }

    const saleId = transaction[0].id;

    // Get transaction items for inventory restoration
    // Only get items that were actually sold (is_void = 0) to restore inventory correctly
    const [items] = await connection.query(
      `SELECT product_id, quantity, is_void FROM sale_items WHERE sale_id = ?`,
      [saleId]
    );

    console.log(
      'Items to process for voiding:',
      items.map((item) => ({
        product_id: item.product_id,
        quantity: item.quantity,
        is_void: item.is_void,
        will_restore_inventory: item.is_void === 0 || item.is_void === null,
      }))
    );

    // Update transaction status to VOID
    await connection.query(
      `UPDATE sales SET 
        status = 'VOID',
        updated_at = ${getMySQLTimestamp()}
       WHERE id = ?`,
      [saleId]
    );

    // Mark all sale items as voided (is_void = 1) instead of deleting them
    await connection.query(
      `UPDATE sale_items SET is_void = 1 WHERE sale_id = ?`,
      [saleId]
    );

    // Restore inventory only for items that were actually sold (not previously voided)
    // Items that were line-voided during the transaction (is_void = 1) should not have their inventory restored
    // because their inventory was never deducted in the first place
    for (const item of items) {
      // Only restore inventory for items that were not previously voided
      if (item.is_void === 0 || item.is_void === null) {
        await connection.query(
          `UPDATE branch_inventory 
           SET stock = stock + ?
           WHERE branch_id = ? AND product_id = ?`,
          [item.quantity, branchId, item.product_id]
        );
        console.log(
          `Restored inventory: Product ${item.product_id}, Quantity: ${item.quantity}`
        );
      } else {
        console.log(
          `Skipped inventory restoration for already voided item: Product ${item.product_id}, Quantity: ${item.quantity}`
        );
      }
    }

    // Update sales session total (subtract voided amount)
    await connection.query(
      `UPDATE sales_sessions ss
       JOIN sales s ON s.pharmacist_session_id = ss.session_id
       SET ss.total_sales = ss.total_sales - ?
       WHERE s.id = ?`,
      [transaction[0].total_amount, saleId]
    );

    // Get user role for better logging
    const [userInfo] = await connection.query(
      `SELECT role FROM users WHERE employee_id = ?`,
      [authorizedBy]
    );

    const userRole = userInfo.length > 0 ? userInfo[0].role : 'UNKNOWN';

    // Log the void action with comprehensive details
    const itemsToRestore = items.filter(
      (item) => item.is_void === 0 || item.is_void === null
    );
    const totalItemsCount = items.length;
    const restoredItemsCount = itemsToRestore.length;

    await connection.query(
      `INSERT INTO logs (employee_id, name, role, branch_id, action, description, timestamp)
       VALUES (?, ?, ?, ?, 'Transaction Void', ?, ${getMySQLTimestamp()})`,
      [
        authorizedBy,
        authorizedByName,
        userRole,
        branchId,
        `TRANSACTION VOID - Receipt: ${receiptNumber} | Original Amount: ₱${Number(
          transaction[0].total_amount || 0
        ).toFixed(
          2
        )} | Total Items: ${totalItemsCount} | Items Restored to Inventory: ${restoredItemsCount} | Previously Voided Items: ${totalItemsCount - restoredItemsCount
        } | Payment Method: ${transaction[0].payment_method || 'N/A'
        } | Void Reason: ${reason} | Authorized by: ${authorizedByName} (${userRole}) | All Items Marked as Voided: Yes`,
      ]
    );

    // Additional detailed log for audit trail
    console.log('=== TRANSACTION VOID COMPLETED ===');
    console.log('Receipt Number:', receiptNumber);
    console.log(
      'Original Amount:',
      `₱${Number(transaction[0].total_amount || 0).toFixed(2)}`
    );
    console.log('Total Items:', totalItemsCount);
    console.log('Items Restored to Inventory:', restoredItemsCount);
    console.log(
      'Previously Voided Items (no inventory restoration):',
      totalItemsCount - restoredItemsCount
    );
    console.log('Authorized By:', `${authorizedByName} (ID: ${authorizedBy})`);
    console.log('User Role:', userRole);
    console.log('Branch ID:', branchId);
    console.log('Void Reason:', reason);
    console.log('All Items Marked as Voided:', 'Yes');
    console.log(
      'Inventory Restoration Logic:',
      'Applied only to previously active items'
    );
    console.log('Timestamp:', new Date().toISOString());
    console.log('===============================');

    await connection.commit();

    console.log('Transaction voided successfully:', receiptNumber);
    res.json({
      success: true,
      message: 'Transaction voided successfully',
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error voiding transaction:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Error voiding transaction',
    });
  } finally {
    connection.release();
  }
};

// Get daily transactions
const getDailyTransactions = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({
        success: false,
        message: 'Date parameter is required',
      });
    }

    // Get all transactions for the specified date
    const transactionQuery = `
      SELECT 
        s.id,
        s.invoice_number,
        COALESCE(s.receipt_number, 'N/A') as receipt_number,
        COALESCE(c.name, 'Walk-in') as customer_name,
        COALESCE(s.total_amount, 0) as total_amount,
        COALESCE(s.payment_method, 'N/A') as payment_method,
        COALESCE(s.discount_type, 'None') as discount_type,
        COALESCE(s.discount_amount, 0) as discount_amount,
        CASE 
          WHEN s.status = 'VOID' THEN 'voided'
          WHEN s.status = 'RETURN' THEN 'returned'
          ELSE 'completed'
        END as status,
        s.created_at,
        COALESCE(st.name, 'N/A') as cashier_name,
        (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) as items_count
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.customer_id
      LEFT JOIN pharmacist st ON s.pharmacist_session_id = st.staff_id
      WHERE DATE(s.created_at) = ?
      ORDER BY s.created_at DESC
    `;

    const [transactions] = await connection.execute(transactionQuery, [date]);

    res.json({
      success: true,
      transactions: transactions || [],
    });
  } catch (error) {
    console.error('Error fetching daily transactions:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching daily transactions',
    });
  } finally {
    connection.release();
  }
};

// Get transaction items for a specific transaction
const getTransactionItems = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    const { transactionId } = req.params;

    if (!transactionId) {
      return res.status(400).json({
        success: false,
        message: 'Transaction ID is required',
      });
    }

    // Get transaction items
    const itemsQuery = `
      SELECT 
        si.id,
        si.product_id,
        si.quantity,
        si.unit_price,
        si.total_price,
        COALESCE(p.name, 'N/A') as product_name,
        COALESCE(p.barcode, 'N/A') as barcode,
        COALESCE(p.brand_name, 'N/A') as brand_name,
        COALESCE(c.name, 'N/A') as category_name
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      LEFT JOIN category c ON p.category = c.category_id
      WHERE si.sale_id = ?
      ORDER BY si.id
    `;

    const [items] = await connection.execute(itemsQuery, [transactionId]);

    res.json({
      success: true,
      items: items || [],
    });
  } catch (error) {
    console.error('Error fetching transaction items:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching transaction items',
    });
  } finally {
    connection.release();
  }
};

// Recall transaction - load transaction items back to cart
const recallTransaction = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    const { transactionId } = req.params;

    if (!transactionId) {
      return res.status(400).json({
        success: false,
        message: 'Transaction ID is required',
      });
    }

    // Get transaction details
    const transactionQuery = `
      SELECT 
        s.*,
        COALESCE(c.name, 'Walk-in') as customer_name,
        COALESCE(st.name, 'N/A') as cashier_name
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.customer_id
      LEFT JOIN staff st ON s.pharmacist_session_id = st.staff_id
      WHERE s.id = ? AND s.status != 'VOID'
    `;
    const [transaction] = await connection.execute(transactionQuery, [transactionId]);

    if (transaction.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found or already voided',
      });
    }

    // Get transaction items with product details
    const itemsQuery = `
      SELECT 
        si.id,
        si.product_id,
        si.quantity,
        si.unit_price,
        si.total_price,
        COALESCE(si.discount_amount, 0) as discount_amount,
        COALESCE(p.name, 'N/A') as product_name,
        COALESCE(p.barcode, 'N/A') as barcode,
        COALESCE(p.brand_name, 'N/A') as brand_name,
        COALESCE(p.retail_price, 0) as retail_price,
        COALESCE(p.wholesale_price, 0) as wholesale_price,
        COALESCE(p.requiresPrescription, 0) as requiresPrescription,
        COALESCE(p.VATExempt, 0) as VATExempt,
        COALESCE(p.pieces_per_box, 1) as pieces_per_box,
        COALESCE(bi.stock, 0) as stock,
        bi.expiryDate,
        COALESCE(c.name, 'N/A') as category_name
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      LEFT JOIN branch_inventory bi ON p.id = bi.product_id AND bi.branch_id = 1
      LEFT JOIN category c ON p.category = c.category_id
      WHERE si.sale_id = ?
      ORDER BY si.id
    `;

    const [items] = await connection.execute(itemsQuery, [transactionId]);

    res.json({
      success: true,
      transaction: transaction[0],
      items: items || [],
    });
  } catch (error) {
    console.error('Error recalling transaction:', error);
    res.status(500).json({
      success: false,
      message: 'Error recalling transaction',
    });
  } finally {
    connection.release();
  }
};

module.exports = {
  searchProducts,
  holdTransaction,
  getHeldTransactions,
  deleteHeldTransaction,
  completeTransaction,
  searchByBarcode,
  createPrescription,
  getTransactionById,
  processReturn,
  processSingleItemReturn,
  getTransactionForReturn,
  validateReturnAndStartExchange,
  completeExchangeTransaction,
  getNextSequence,
  createSalesSession,
  closeSalesSession,
  getHeldTransactionItems,
  getCustomerByCard,
  createCustomerWithCard,
  generateInvoiceNumber,
  getProductStock,
  getTransactionDetails,
  voidTransaction,
  getDailyTransactions,
  getTransactionItems,
  recallTransaction,
};

const db = require('../config/database');
const { getMySQLTimestamp, getCurrentTimestamp } = require('../utils/timeZoneUtil');

// Get session summary for reconciliation
const getSessionSummary = async (req, res) => {
    const { sessionId } = req.params;

    try {
        // Get session info regardless of transactions
        const [results] = await db.pool.query(
            `SELECT 
                COALESCE(COUNT(s.id), 0) as total_transactions,
                COALESCE(SUM(s.total_amount), 0) as total_amount,
                p.name as pharmacist_name,
                p.staff_id as pharmacist_code,
                b.branch_id,
                b.branch_name,
                ps.pharmacist_session_id as session_id,
                ss.session_id as sales_session_id,
                ps.petty_cash as starting_cash,
                ps.cash_notes,
                COALESCE(SUM(CASE WHEN LOWER(s.payment_method) = 'cash' THEN s.total_amount ELSE 0 END), 0) as cash_sales,
                (ps.petty_cash + COALESCE(SUM(CASE WHEN LOWER(s.payment_method) = 'cash' THEN s.total_amount ELSE 0 END), 0)) as expected_cash
            FROM pharmacist_sessions ps
            JOIN pharmacist p ON ps.staff_id = p.staff_id
            JOIN branches b ON p.branch_id = b.branch_id
            JOIN sales_sessions ss ON ps.session_id = ss.session_id
            LEFT JOIN sales s ON s.pharmacist_session_id = ps.pharmacist_session_id
            WHERE ps.pharmacist_session_id = ?
            GROUP BY ps.pharmacist_session_id, ps.petty_cash, ps.cash_notes`,
            [sessionId]
        );

        if (results.length === 0) {
            return res.status(404).json({ message: 'Session not found' });
        }

        res.json(results[0]);
    } catch (error) {
        console.error('Error getting session summary:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

// Save cash reconciliation and end session
const saveCashReconciliation = async (req, res) => {
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        const reconciliationData = {
            ...req.body,
            created_at: getMySQLTimestamp()
        };

        // Insert reconciliation record
        const [result] = await connection.query(
            `INSERT INTO cash_reconciliation SET ?`,
            reconciliationData
        );

        // Get the sales_session_id
        const [sessionResult] = await connection.query(
            `SELECT ss.session_id, ss.total_sales 
             FROM sales_sessions ss
             JOIN pharmacist_sessions ps ON ss.session_id = ps.session_id
             WHERE ps.pharmacist_session_id = ?`,
            [reconciliationData.pharmacist_session_id]
        );

        if (sessionResult.length === 0) {
            throw new Error('Sales session not found');
        }

        // Update sales session end time and total sales
        await connection.query(
            `UPDATE sales_sessions 
             SET end_time = ${getMySQLTimestamp()},
                 total_sales = COALESCE((
                     SELECT SUM(total_amount) 
                     FROM sales s
                     JOIN pharmacist_sessions ps ON s.pharmacist_session_id = ps.pharmacist_session_id
                     WHERE ps.session_id = ?
                 ), 0),
                 updated_at = ${getMySQLTimestamp()}
             WHERE session_id = ?`,
            [sessionResult[0].session_id, sessionResult[0].session_id]
        );

        await connection.commit();

        res.json({
            success: true,
            reconciliation_id: result.insertId,
            message: 'Cash reconciliation saved and session ended successfully'
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error in cash reconciliation and session end:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save cash reconciliation and end session',
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// Check if session has transactions
const checkSessionTransactions = async (req, res) => {
    const { sessionId } = req.params;

    try {
        const [results] = await db.pool.query(
            `SELECT COUNT(s.id) as transaction_count
             FROM sales s
             WHERE s.pharmacist_session_id = ?`,
            [sessionId]
        );

        res.json({
            hasTransactions: results[0].transaction_count > 0,
            transactionCount: results[0].transaction_count
        });
    } catch (error) {
        console.error('Error checking session transactions:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

// Update petty cash for a session
const updatePettyCash = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { petty_cash, updated_by } = req.body;

        if (!petty_cash || petty_cash < 0) {
            return res.status(400).json({
                success: false,
                message: 'Valid petty cash amount is required'
            });
        }

        // Update the petty cash in pharmacist_sessions table
        const [result] = await db.pool.query(
            `UPDATE pharmacist_sessions 
             SET petty_cash = ?
             WHERE pharmacist_session_id = ?`,
            [petty_cash, sessionId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }

        res.json({
            success: true,
            message: 'Petty cash updated successfully',
            petty_cash: parseFloat(petty_cash)
        });
    } catch (error) {
        console.error('Error updating petty cash:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update petty cash'
        });
    }
};

// Get transaction summary for pharmacist session
const getTransactionSummary = async (req, res) => {
    try {
        const { sessionId } = req.params;

        const [results] = await db.pool.query(
            `SELECT 
                s.invoice_number,
                s.total_amount,
                s.amount_tendered,
                s.amount_change,
                s.created_at
            FROM sales s
            WHERE s.pharmacist_session_id = ?
            ORDER BY s.created_at DESC`,
            [sessionId]
        );

        const formattedResults = results.map(transaction => ({
            ...transaction,
            total_amount: parseFloat(transaction.total_amount) || 0,
            amount_tendered: parseFloat(transaction.amount_tendered) || 0,
            amount_change: parseFloat(transaction.amount_change) || 0
        }));

        res.json(formattedResults);
    } catch (error) {
        console.error('Error getting transaction summary:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

const createCashReconciliation = async (req, res) => {
  const connection = await db.pool.getConnection();
  try {
    const {
      pharmacist_session_id,
      notes,
    } = req.body;

    console.log("Creating cash reconciliation with data:", req.body);

    // Validate required fields
    if (!pharmacist_session_id) {
      return res.status(400).json({
        success: false,
        message: "Pharmacist session ID is required",
      });
    }

    // Validate denomination values (ensure they are numbers)
    const denominationFields = [
      "denomination_1000",
      "denomination_500",
      "denomination_200",
      "denomination_100",
      "denomination_50",
      "denomination_20",
      "denomination_10",
      "denomination_5",
      "denomination_1",
      "denomination_5c",
      "denomination_10c",
      "denomination_25c",
    ];

    // Convert denomination values to numbers and validate
    const processedBody = { ...req.body };
    for (const field of denominationFields) {
      const value = processedBody[field];
      if (value !== undefined && value !== null) {
        const numValue = Number(value);
        if (isNaN(numValue) || numValue < 0) {
          return res.status(400).json({
            success: false,
            message: `Invalid value for ${field}. Must be a non-negative number.`,
          });
        }
        processedBody[field] = numValue;
      } else {
        processedBody[field] = 0;
      }
    }

    // Calculate cash_counted from denominations using processed values
    const cash_counted =
      processedBody.denomination_1000 * 1000 +
      processedBody.denomination_500 * 500 +
      processedBody.denomination_200 * 200 +
      processedBody.denomination_100 * 100 +
      processedBody.denomination_50 * 50 +
      processedBody.denomination_20 * 20 +
      processedBody.denomination_10 * 10 +
      processedBody.denomination_5 * 5 +
      processedBody.denomination_1 * 1 +
      processedBody.denomination_5c * 0.05 +
      processedBody.denomination_10c * 0.1 +
      processedBody.denomination_25c * 0.25;

    await connection.beginTransaction();

    // Get total transactions count for this pharmacist session
    const [transactions] = await connection.query(
      `SELECT COUNT(*) as total_transactions
             FROM sales 
             WHERE pharmacist_session_id = ?`,
      [pharmacist_session_id]
    );

    const total_transactions = transactions[0].total_transactions || 0;

    // Get total cash amount from sales for this pharmacist session
    const [cashSales] = await connection.query(
      `SELECT COALESCE(SUM(total_amount), 0) as total_amount
             FROM sales 
             WHERE pharmacist_session_id = ? AND payment_method = 'cash'`,
      [pharmacist_session_id]
    );

    const cash_sales_amount = parseFloat(cashSales[0].total_amount) || 0;

    // Get petty cash from the request or from pharmacist_sessions table
    let petty_cash = parseFloat(processedBody.petty_cash) || 0;

    // If petty cash not provided in request, fetch from pharmacist_sessions
    if (!petty_cash) {
      const [sessionData] = await connection.query(
        `SELECT petty_cash FROM pharmacist_sessions WHERE pharmacist_session_id = ?`,
        [pharmacist_session_id]
      );
      petty_cash = parseFloat(sessionData[0]?.petty_cash) || 0;
    }

    // Total amount should include both cash sales and petty cash (both as numbers)
    const total_amount = cash_sales_amount + petty_cash;

    // Calculate balance
    const balance = cash_counted - total_amount;

    // Determine status based on balance
    let status;
    if (balance === 0) {
      status = "balanced";
    } else if (balance > 0) {
      status = "overage";
    } else {
      status = "shortage";
    }

    // Insert cash reconciliation record
    const [result] = await connection.query(
      `INSERT INTO cash_reconciliation (
                pharmacist_session_id,
                total_transactions,
                total_amount,
                cash_counted,
                balance,
                status,
                denomination_1000,
                denomination_500,
                denomination_200,
                denomination_100,
                denomination_50,
                denomination_20,
                denomination_10,
                denomination_5,
                denomination_1,
                denomination_5c,
                denomination_10c,
                denomination_25c,
                notes,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pharmacist_session_id,
        total_transactions,
        total_amount,
        cash_counted,
        balance,
        status,
        processedBody.denomination_1000,
        processedBody.denomination_500,
        processedBody.denomination_200,
        processedBody.denomination_100,
        processedBody.denomination_50,
        processedBody.denomination_20,
        processedBody.denomination_10,
        processedBody.denomination_5,
        processedBody.denomination_1,
        processedBody.denomination_5c,
        processedBody.denomination_10c,
        processedBody.denomination_25c,
        notes || null,
        getMySQLTimestamp(),
      ]
    );

    await connection.commit();

    console.log("Cash reconciliation calculation breakdown:", {
      reconciliation_id: result.insertId,
      pharmacist_session_id,
      total_transactions,
      cash_sales_amount,
      petty_cash,
      total_amount: `${cash_sales_amount} + ${petty_cash} = ${total_amount}`,
      cash_counted,
      balance: `${cash_counted} - ${total_amount} = ${balance}`,
      status,
    });

    res.status(201).json({
      success: true,
      message: "Cash reconciliation created successfully",
      data: {
        reconciliation_id: result.insertId,
        pharmacist_session_id,
        total_transactions,
        cash_sales_amount,
        petty_cash,
        total_amount,
        cash_counted,
        balance,
        status,
        notes,
        created_at: getMySQLTimestamp(),
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("Cash reconciliation error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create cash reconciliation",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

module.exports = {
    getSessionSummary,
    saveCashReconciliation,
    checkSessionTransactions,
    updatePettyCash,
    getTransactionSummary,
    createCashReconciliation
}; 
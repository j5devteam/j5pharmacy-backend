const express = require('express');
const router = express.Router();
const transactionController = require('../controller/transaction.controller');
const { verifyToken, isPMSUser, isPharmacist } = require('../middleware/auth.middleware');

// Existing transaction endpoints
router.get('/all', verifyToken, isPMSUser, transactionController.getAllTransactions);
router.get('/transactions', verifyToken, isPMSUser, transactionController.getAllBranchesTransactions);
router.get('/filter/:branchId/:startDate/:endDate', verifyToken, isPMSUser, transactionController.getTransactionFilter);
router.get('/summary', verifyToken, isPMSUser, transactionController.getTransactionSummary);
router.get('/latest', verifyToken, isPMSUser, transactionController.getLatestTransactions);
router.get('/metrics', verifyToken, isPMSUser, transactionController.getKeyMetrics);
router.get('/items/:invoiceNumber', verifyToken, isPharmacist, transactionController.getTransactionItems);
router.put('/update-invoice-number', verifyToken, isPMSUser, transactionController.updateInvoiceNumber);

// New pharmacy reports endpoints
router.get('/reports/pharmacy', transactionController.getPharmacyReports);
router.get('/reports/products', transactionController.getProductPerformance);
router.get('/reports/categories', transactionController.getCategoryAnalysis);

module.exports = router;
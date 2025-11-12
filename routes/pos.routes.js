const express = require('express');
const router = express.Router();
const posController = require('../controller/pos.controller');
const cashReconciliationController = require('../controller/cashReconciliation.controller');
const { verifyToken, isPharmacist } = require('../middleware/auth.middleware');

// Product Search Routes
router.get('/search', verifyToken, isPharmacist, posController.searchProducts);
router.get(
  '/barcode/:barcode',
  verifyToken,
  isPharmacist,
  posController.searchByBarcode
);

// Hold Transaction (F3)
router.post(
  '/transactions/hold',
  verifyToken,
  isPharmacist,
  posController.holdTransaction
);

// Get Held Transactions (F4)
router.get(
  '/transactions/held/:salesSessionId',
  verifyToken,
  isPharmacist,
  posController.getHeldTransactions
);

// Delete Held Transaction
router.delete(
  '/transactions/held/:heldTransactionId',
  verifyToken,
  isPharmacist,
  posController.deleteHeldTransaction
);

// Add this route after the delete route
router.get(
  '/transactions/held/:heldTransactionId/items',
  verifyToken,
  isPharmacist,
  posController.getHeldTransactionItems
);

// Prescription (F6)
router.post(
  '/prescriptions',
  verifyToken,
  isPharmacist,
  posController.createPrescription
);

// Process Return (F7)
router.get(
  '/transactions/:id',
  verifyToken,
  isPharmacist,
  posController.getTransactionById
);
router.post('/returns', verifyToken, isPharmacist, posController.processReturn);
router.post(
  '/process-return',
  verifyToken,
  isPharmacist,
  posController.processSingleItemReturn
);

// New Exchange/Return Process Routes
router.get(
  '/transaction-for-return',
  verifyToken,
  isPharmacist,
  posController.getTransactionForReturn
);
router.post(
  '/validate-return',
  verifyToken,
  isPharmacist,
  posController.validateReturnAndStartExchange
);
router.post(
  '/complete-exchange',
  verifyToken,
  isPharmacist,
  posController.completeExchangeTransaction
);

// Complete Transaction
router.post(
  '/transactions',
  verifyToken,
  isPharmacist,
  posController.completeTransaction
);

// Sales Session Management
router.post(
  '/sessions',
  verifyToken,
  isPharmacist,
  posController.createSalesSession
);
router.patch(
  '/sessions/:sessionId',
  verifyToken,
  isPharmacist,
  posController.closeSalesSession
);

// Customer Management
router.get(
  '/customers/by-card/:cardId',
  verifyToken,
  isPharmacist,
  posController.getCustomerByCard
);
router.post(
  '/customers',
  verifyToken,
  isPharmacist,
  posController.createCustomerWithCard
);

// Add this route
router.get(
  '/generate-invoice-number',
  verifyToken,
  isPharmacist,
  posController.generateInvoiceNumber
);

// Stock Checking
// Check product stock
router.get('/stock/:productId', posController.getProductStock);

router.get('/search/stock/:branchId/:productId', posController.getProductStock);

// Transaction Voiding
router.get(
  '/transaction-details',
  verifyToken,
  isPharmacist,
  posController.getTransactionDetails
);
router.post(
  '/void-transaction',
  verifyToken,
  isPharmacist,
  posController.voidTransaction
);

// Save cash reconciliation
router.post(
  '/cash-reconciliation',
  cashReconciliationController.saveCashReconciliation
);

// Get daily transactions
router.get(
  '/daily-transactions',
  verifyToken,
  isPharmacist,
  posController.getDailyTransactions
);

// Get transaction items
router.get(
  '/transaction-items/:transactionId',
  verifyToken,
  isPharmacist,
  posController.getTransactionItems
);

// Recall transaction
router.get(
  '/recall-transaction/:transactionId',
  verifyToken,
  isPharmacist,
  posController.recallTransaction
);

module.exports = router;

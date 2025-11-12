const express = require('express');
const router = express.Router();
const dashboardController = require('../controller/dashboard.controller');
const { verifyToken } = require('../middleware/auth.middleware');

// Dashboard routes
router.get('/overview', verifyToken, dashboardController.getDashboardOverview);
router.get('/overviewByBranch', verifyToken, dashboardController.getDashboardOverviewByBranch);
router.get('/recent-transactions', verifyToken, dashboardController.getRecentTransactions);
router.get('/recent-transactionsByBranch', verifyToken, dashboardController.getRecentTransactionsByBranch);
router.get('/low-stock', verifyToken, dashboardController.getLowStockItems);
router.get('/low-stockByBranch', verifyToken, dashboardController.getLowStockItemsByBranch);
router.get('/expired-products', verifyToken, dashboardController.getExpiredProducts);
router.get('/expired-productsByBranch', verifyToken, dashboardController.getExpiredProductsByBranch);

module.exports = router; 

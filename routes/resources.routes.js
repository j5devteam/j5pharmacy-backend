const express = require('express');
const router = express.Router();
const resourcesController = require('../controller/resources.controller');
const { verifyToken, isPMSUser } = require('../middleware/auth.middleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for receipt image uploads to frontend public directory
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Save to frontend public directory
        const uploadPath = path.join(__dirname, '../../frontend/public/uploads/receipts');

        // Create directory if it doesn't exist
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }

        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        // Use the filename from frontend
        cb(null, file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        // Accept images and PDFs
        if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only image files and PDFs are allowed'));
        }
    }
});

// Apply middleware to all routes
router.use(verifyToken, isPMSUser);

// Branches route for NewStockImport component
router.get('/branches', resourcesController.getBranches);

// Supplier Management Routes
router.get('/suppliers', resourcesController.getAllSuppliers);
router.post('/suppliers', resourcesController.addSupplier);
router.put('/suppliers/:supplier_id', resourcesController.updateSupplier);
router.delete('/suppliers/:supplier_id', resourcesController.deleteSupplier);

// Archive Management Routes
router.get('/archived-suppliers', resourcesController.getArchivedSuppliers);
router.post('/archive-supplier/:supplier_id', resourcesController.archiveSupplier);
router.post('/restore-supplier/:supplier_id', resourcesController.restoreSupplier);
router.post('/bulk-archive-suppliers', resourcesController.bulkArchiveSuppliers);

// Product Supplier Management Routes
router.get('/products/:product_id/suppliers', resourcesController.getProductSuppliers);
router.post('/products/:product_id/suppliers', resourcesController.addProductSupplier);
router.put('/product-suppliers/:product_supplier_id', resourcesController.updateProductSupplier);
router.delete('/product-suppliers/:product_supplier_id', resourcesController.removeProductSupplier);

// Price Management Routes
router.get('/products/:product_id/price-history', resourcesController.getProductPriceHistory);
router.post('/products/:product_id/calculate-price', resourcesController.calculateProductPrice);

// Bulk Import Routes
router.post('/bulk-import/validate', resourcesController.validateBulkImport);
router.get('/bulk-import/search-product', resourcesController.searchProduct);
router.get('/bulk-import/check-barcode', resourcesController.checkBarcodeExists);
router.get('/bulk-import/check-product', resourcesController.checkProductMatch);
router.post('/bulk-import/process', resourcesController.processBulkImport);

// Receipt Upload Route
router.post('/upload-receipt', upload.single('receipt'), resourcesController.uploadReceipt);

// Add categories route
router.get('/categories', resourcesController.getCategories);

// Batch Management Routes
router.get('/batches', resourcesController.getBatches);
router.get('/batches/:batch_id', resourcesController.getBatchDetails);
router.post('/batches', resourcesController.addBatch);
router.put('/batches/:batch_id', resourcesController.updateBatch);
router.post('/batches/:batch_id/archive', resourcesController.archiveBatch);

// Inventory History Routes
router.get('/inventory-history', resourcesController.getInventoryHistory);
router.get('/products/:product_id/inventory-history', resourcesController.getProductInventoryHistory);

// Stock Review Routes
router.get('/stock-review/checklist/:branch_id', resourcesController.generateInventoryChecklist);
router.post('/stock-review/process', resourcesController.processInventoryCount);
router.post('/stock-review/apply-adjustments', resourcesController.applyStockAdjustments);
// New endpoints for manual stock review session management
router.post('/stock-review/start-session', resourcesController.startStockReviewSession);
router.post('/stock-review/quick-save', resourcesController.quickSaveStockReview);
router.post('/stock-review/bulk-process', resourcesController.bulkProcessStockReview);
router.post('/stock-review/end-session', resourcesController.endStockReviewSession);
// Session products (save & resume)
router.post('/stock-review/session-products', resourcesController.saveSessionProducts);
router.get('/stock-review/session-products', resourcesController.getSessionProducts);
// Check if session has any saved products
router.get('/stock-review/session-products/exists', resourcesController.checkSessionProductsExist);

// Stock Review History Routes
router.get('/stock-review/history', resourcesController.getStockReviewHistory);
router.get('/stock-review/history/branch/:branch_id', resourcesController.getStockReviewHistoryByBranch);
router.get('/stock-review/history/branch/:branch_id/latest', resourcesController.getLatestStockReviewByBranch);
router.get('/stock-review/history/:id', resourcesController.getStockReviewHistoryDetails);

// Inventory List Export Route
router.get('/inventory-list/:branch_id', resourcesController.getInventoryListExport);

module.exports = router;
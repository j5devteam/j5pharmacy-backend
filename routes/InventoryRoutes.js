// backend/routes/inventoryRoutes.js
const express = require('express');
const router = express.Router();
const inventoryController = require('../controller/InventoryController');
const inventoryGroupController = require('../controller/InventoryGroupController');
const { verifyToken, isPMSUser } = require('../middleware/auth.middleware');

// Apply middleware to all routes
// router.use(verifyToken, isPMSUser);

// Inventory routes
router.get('/admin/inventory/stats', inventoryController.getInventoryStats);
router.get('/admin/inventory/statsByBranch', inventoryController.getInventoryStatsByBranch);
router.get('/admin/inventory/expired-products', inventoryController.getExpiredProducts);
router.get('/admin/inventory/expired-productsByBranch/:branch_id', inventoryController.getExpiredProductsByBranch);
router.get('/admin/inventory/archived-expired-products', inventoryController.getArchivedExpiredProducts);
router.get('/admin/inventory/archived-expired-productsByBranch/:branch_id', inventoryController.getArchivedExpiredProductsByBranch);
router.get('/admin/inventory/view-medicines-available', inventoryController.getMedicineAvailable);
router.get('/admin/inventory/view-medicines-description/:medicineName', inventoryController.getMedicineByName);
router.get('/admin/inventory/view-medicines-descriptionByBranch/:medicineName', inventoryController.getMedicineByNameAndBranch);
router.get('/admin/inventory/batch-lot-options/:productId', inventoryController.getBatchLotOptions);
router.get('/admin/inventory/categories', inventoryController.getCategories);
router.get('/admin/inventory/archived-products', inventoryController.getArchivedProducts);
router.get('/admin/inventory/archived-productsByBranch', inventoryController.getArchivedProductsByBranch);
router.get('/admin/inventory/suppliers', inventoryController.getSuppliers);
router.get('/admin/inventory/branches', inventoryController.getBranches);
router.get('/admin/inventory/critical-products', inventoryController.getCriticalProducts);
router.get('/admin/inventory/critical-products-by-branch', inventoryController.getCriticalProductsByBranch);
router.get('/admin/inventory/shortage-products-by-branch', inventoryController.getShortageProductsByBranch);
router.get('/admin/inventory/archived-categories', inventoryController.getArchivedCategories);
router.get('/admin/inventory/category-products/:categoryId', inventoryGroupController.getCategoryProducts);
router.get('/admin/inventory/next-barcode/:categoryId', inventoryGroupController.getNextBarcode);
router.get('/admin/inventory/view-medicines-availableByBranch', inventoryController.getMedicineAvailableByBranch);
router.get('/admin/inventory/shortage-products', inventoryController.getShortageProducts);
router.get('/admin/inventory/generate-unique-barcode', inventoryController.generateUniqueBarcode);


// POST routes
router.post('/admin/inventory/add-medicine', inventoryController.addMedicine);
router.post('/admin/inventory/edit-medicine/:medicineName', inventoryController.updateMedicineDescription);
router.post('/admin/inventory/update-branch-inventory', inventoryController.updateBranchInventory);
router.post('/admin/inventory/archive-product/:barcode', inventoryController.archiveProduct);
router.post('/admin/inventory/restore-expired-product/:productId', inventoryController.restoreExpiredProduct);
router.post('/admin/inventory/archive-category/:categoryId', inventoryGroupController.archiveCategory);
router.post('/admin/inventory/restore-category/:categoryId', inventoryController.restoreCategory);
router.post('/admin/inventory/add-category', inventoryGroupController.addMedicineGroup);
router.post('/admin/inventory/update-category', inventoryGroupController.updateMedicineGroup);
router.post('/admin/inventory/restore-product/:productId', inventoryController.restoreProduct);
router.post('/admin/inventory/expired-products-delete', inventoryController.deleteExpiredProducts);

// DELETE routes
router.delete('/admin/inventory/delete/:barcode', inventoryController.deleteMedicine);
router.delete('/admin/inventory/delete-multiple', inventoryController.deleteMedicines);

router.get('/admin/inventory/price-check/:searchTerm', inventoryController.getCompetitivePriceChecker);

module.exports = router;

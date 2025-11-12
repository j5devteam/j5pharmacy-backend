const db = require("../config/database").pool; // Import the promisePool from your database configuration
const timeZoneUtil = require("../utils/timeZoneUtil");

// Fetch inventory counts dynamically
exports.getInventoryStats = async (req, res) => {
  try {
    console.log("Getting global inventory stats (admin dashboard)");

    // Get total active products across all branches
    const [productsCount] = await db.query(`
            SELECT COUNT(DISTINCT p.id) as count 
            FROM products p
            WHERE p.is_active = TRUE
        `);

    // Get total categories
    const [categoriesCount] = await db.query(
      "SELECT COUNT(*) as count FROM category WHERE is_active = TRUE"
    );

    // Get count of products with stock below critical level across all branches
    const [criticalCount] = await db.query(`
            SELECT COUNT(DISTINCT p.id) as count
            FROM products p
            JOIN branch_inventory bi ON p.id = bi.product_id
            WHERE p.is_active = TRUE 
            AND bi.is_active = TRUE
            AND bi.stock <= p.critical
        `);

    // Get count of expired products across all branches
    const [expiredCount] = await db.query(`
            SELECT COUNT(*) AS count
            FROM branch_inventory bi
            JOIN products p 
                ON bi.product_id = p.id
            JOIN category c 
                ON p.category = c.category_id
            WHERE 
                bi.is_active = TRUE
                AND bi.expiryDate IS NOT NULL
                AND bi.expiryDate != '0000-00-00'
                AND bi.expiryDate < CURDATE()
        `);

    console.log("Global inventory stats retrieved:", {
      productsAvailable: productsCount[0].count,
      medicineGroups: categoriesCount[0].count,
      medicineShortage: criticalCount[0].count,
      expiredProducts: expiredCount[0].count,
    });

    return res.json({
      productsAvailable: productsCount[0].count,
      medicineGroups: categoriesCount[0].count,
      medicineShortage: criticalCount[0].count,
      expiredProducts: expiredCount[0].count,
    });
  } catch (error) {
    console.error("Error getting inventory stats:", error);
    res.status(500).json({
      message: "Error getting inventory stats",
      error: error.message,
    });
  }
};

// Fetch all available medicines
exports.getMedicineAvailable = async (req, res) => {
  try {
    const {
      orderBy = "updatedAt",
      sortDirection = "asc",
      createdStartDate,
      createdEndDate,
      updatedStartDate,
      updatedEndDate,
    } = req.query;

    const validColumns = [
      "name",
      "brand_name",
      "barcode",
      "category",
      "price",
      "stock",
      "createdAt",
    ];
    const sortColumn = validColumns.includes(orderBy) ? orderBy : "updatedAt";
    const direction = sortDirection === "desc" ? "DESC" : "ASC";

    // First get all active branches
    const [branches] = await db.query(`
      SELECT branch_id, branch_name 
      FROM branches 
      WHERE is_active = TRUE
    `);

    let query = `
            SELECT p.id as medicineID, p.name, p.brand_name, p.barcode, 
                   c.name as category, p.price,
                   p.enable_packaging_conversion, p.packaging_unit,
                   p.pieces_per_packaging, p.quantity_in_packaging_units,
                   p.price_per_packaging, p.total_pieces, p.unit_price_per_piece,
                   p.retail_price, p.wholesale_price,
                   (SELECT COALESCE(SUM(bi.stock), 0)
                    FROM branch_inventory bi 
                    WHERE bi.product_id = p.id AND bi.is_active = TRUE) as stock,
                   (SELECT GROUP_CONCAT(DISTINCT batch.batch_number)
                    FROM branch_inventory bi
                    LEFT JOIN batches batch ON bi.batch_id = batch.batch_id
                    WHERE bi.product_id = p.id AND bi.is_active = TRUE) as batch_numbers,
                    p.createdAt as createdAt,
                    p.updatedAt as updatedAt
            FROM products p
            LEFT JOIN category c ON p.category = c.category_id
            WHERE p.is_active = TRUE
        `;

    const queryParams = [];

    // Add date filters if provided
    if (createdStartDate) {
      query += ` AND p.createdAt >= ?`;
      queryParams.push(createdStartDate);
    }
    if (createdEndDate) {
      query += ` AND p.createdAt <= ?`;
      queryParams.push(createdEndDate);
    }
    if (updatedStartDate) {
      query += ` AND p.updatedAt >= ?`;
      queryParams.push(updatedStartDate);
    }
    if (updatedEndDate) {
      query += ` AND p.updatedAt <= ?`;
      queryParams.push(updatedEndDate);
    }

    query += ` ORDER BY ${sortColumn} ${direction}`;

    const [products] = await db.query(query, queryParams);

    // Get branch inventory data for each product
    const productsWithInventory = await Promise.all(
      products.map(async (product) => {
        // Get inventory for all branches for this product
        const [branchInventory] = await db.query(
          `
                SELECT 
                    bi.branch_id,
                    bi.stock,
                    CASE 
                        WHEN bi.expiryDate = '0000-00-00' THEN NULL
                        WHEN bi.expiryDate IS NULL THEN NULL
                        ELSE bi.expiryDate
                    END as expiryDate,
                    bi.expiryThreshold,
                    b.branch_name,
                    batch.batch_number,
                    batch_items.lot_number,
                    CASE 
                        WHEN bi.expiryDate IS NULL OR bi.expiryDate = '0000-00-00' THEN NULL
                        WHEN bi.expiryDate < CURDATE() THEN 'expired'
                        WHEN DATEDIFF(bi.expiryDate, CURDATE()) <= bi.expiryThreshold THEN 'near_expiry'
                        ELSE 'ok'
                    END as expiry_status,
                    CASE 
                        WHEN bi.expiryDate IS NULL OR bi.expiryDate = '0000-00-00' THEN NULL
                        ELSE DATEDIFF(bi.expiryDate, CURDATE())
                    END as days_until_expiry
                FROM branch_inventory bi
                JOIN branches b ON bi.branch_id = b.branch_id
                LEFT JOIN batches batch ON bi.batch_id = batch.batch_id
                LEFT JOIN batch_items ON batch_items.batch_id = batch.batch_id AND batch_items.product_id = bi.product_id
                WHERE bi.product_id = ? AND bi.is_active = TRUE
            `,
          [product.medicineID]
        );

        // Create an enhanced product object with branch inventory data
        const enhancedProduct = { ...product };

        // Add branch-specific data
        branches.forEach((branch) => {
          const inventory = branchInventory.find(
            (bi) => bi.branch_id === branch.branch_id
          );
          enhancedProduct[`branch_${branch.branch_id}_stock`] =
            inventory?.stock?.toString() || "0";
          enhancedProduct[`branch_${branch.branch_id}_expiry`] =
            inventory?.expiryDate || null;
          enhancedProduct[`branch_${branch.branch_id}_expiry_status`] =
            inventory?.expiry_status || null;
          enhancedProduct[`branch_${branch.branch_id}_days_until_expiry`] =
            inventory?.days_until_expiry || null;
        });

        // Also include the raw branch_inventory array for frontend use
        enhancedProduct.branch_inventory = branchInventory;

        return enhancedProduct;
      })
    );

    res.json(productsWithInventory);
  } catch (error) {
    console.error("Error in getMedicineAvailable:", error);
    // Check if it's a connection error
    if (
      error.code === "ECONNRESET" ||
      error.code === "PROTOCOL_CONNECTION_LOST"
    ) {
      res
        .status(503)
        .json({ message: "Database connection error. Please try again." });
    } else {
      res
        .status(500)
        .json({ message: "Internal server error", error: error.message });
    }
  }
};

// Helper function to validate dates
const isValidDate = (dateString) => {
  if (!dateString) return false;
  if (dateString === '0000-00-00') return false;
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date.getTime());
};

// Add a new medicine
// Add a new medicine
exports.addMedicine = async (req, res) => {
  const {
    name,
    brand_name,
    barcode,
    category,
    description,
    sideEffects,
    requiresPrescription,
    VATExempt,
    dosage_amount,
    dosage_unit,
    critical,
    enable_packaging_conversion,
    packaging_unit,
    pieces_per_packaging,
    quantity_in_packaging_units,
    price_per_packaging,
    supplier_discount,
    branchInventory, // Array of { branchId, stock, expiryDate, expiryThreshold, lot_number, batch_number }
    unit_price_per_piece,
    total_pieces,
    retail_price,
    wholesale_price,
    is_manual_entry, // Flag to indicate this is a manual entry
  } = req.body;

  // Validate required fields
  if (
    !name ||
    !barcode ||
    !category ||
    !description ||
    !sideEffects
  ) {
    return res.status(400).json({
      success: false,
      message: "Required fields are missing",
      missingFields: {
        name: !name,
        barcode: !barcode,
        category: !category,
        description: !description,
        sideEffects: !sideEffects,
      },
    });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    console.log("Starting transaction for adding new medicine");

    // First get the category_id from the category table
    const [categoryResult] = await connection.query(
      "SELECT category_id FROM category WHERE name = ?",
      [category]
    );

    if (!categoryResult || categoryResult.length === 0) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Invalid category",
      });
    }

    const categoryId = categoryResult[0].category_id;
    const currentTimestamp = timeZoneUtil.getMySQLTimestamp();

    console.log('Inserting new medicine with data:', {
      name,
      brand_name,
      barcode,
      categoryId,
      description,
      sideEffects,
      dosage_amount,
      dosage_unit,
      critical,
      requiresPrescription,
      VATExempt,
      enable_packaging_conversion,
      packaging_unit,
      pieces_per_packaging,
      quantity_in_packaging_units,
      price_per_packaging,
      supplier_discount,
      retail_price, // NEW
      wholesale_price, // NEW
    });

    // Calculate packaging conversion values only if not provided
    let totalPieces = total_pieces;
    let unitPricePerPiece = unit_price_per_piece;
    if (typeof totalPieces === 'undefined' || typeof unitPricePerPiece === 'undefined') {
      totalPieces = 0;
      unitPricePerPiece = 0;
      if (enable_packaging_conversion && pieces_per_packaging && quantity_in_packaging_units && price_per_packaging) {
        const piecesPerPackaging = parseInt(pieces_per_packaging) || 0;
        const quantityInPackagingUnits = parseInt(quantity_in_packaging_units) || 0;
        const pricePerPackaging = parseFloat(price_per_packaging) || 0;
        totalPieces = piecesPerPackaging * quantityInPackagingUnits;
        unitPricePerPiece = totalPieces > 0 ? pricePerPackaging / totalPieces : 0;
      }
    }

    // Insert the new medicine into the database with timestamps
    const [result] = await connection.query(
      `INSERT INTO products (
        name, brand_name, barcode, category, description, 
        sideEffects, requiresPrescription, VATExempt, dosage_amount, dosage_unit,
        critical, enable_packaging_conversion, packaging_unit,
        pieces_per_packaging, quantity_in_packaging_units, price_per_packaging,
        total_pieces, unit_price_per_piece, retail_price, wholesale_price,
        supplier_discount,
        createdAt, updatedAt, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${currentTimestamp}, ${currentTimestamp}, TRUE)`,
      [
        name, brand_name, barcode, categoryId, description,
        sideEffects, requiresPrescription, VATExempt, dosage_amount, dosage_unit,
        critical, enable_packaging_conversion ? 1 : 0, packaging_unit,
        pieces_per_packaging, quantity_in_packaging_units, price_per_packaging,
        totalPieces, unitPricePerPiece, retail_price, wholesale_price,
        supplier_discount
      ]
    );

    const productId = result.insertId;
    console.log("Product added with ID:", productId);

    // Get all active branches
    const [branches] = await connection.query(
      "SELECT branch_id FROM branches WHERE is_active = TRUE"
    );

    console.log("Processing branch inventory for branches:", branches);

    // Store batch information to return to client
    const batchDetails = [];

    // Process all branch inventories (allowing multiple entries per branch)
    const allBranchInventories = [];

    // Collect all branch inventories from the request
    if (branchInventory && Array.isArray(branchInventory)) {
      // Process all inventory entries
      for (const inventoryEntry of branchInventory) {
        // Make sure we have a valid branch ID
        if (inventoryEntry.branchId) {
          // Check if this is a real branch ID (positive number) or a temporary ID (negative number)
          const isTempId = inventoryEntry.branchId < 0;

          // If it's a temporary ID, find the actual branch it belongs to
          let actualBranchId = inventoryEntry.branchId;
          if (isTempId && inventoryEntry.parentBranchId) {
            actualBranchId = inventoryEntry.parentBranchId;
          }

          // Add to our collection with appropriate metadata
          allBranchInventories.push({
            ...inventoryEntry,
            actualBranchId: isTempId ? actualBranchId : inventoryEntry.branchId,
            isTempId,
            entryLabel: inventoryEntry.entryLabel || ''
          });
        }
      }
    }

    // Initialize inventory for all branches and sub-branches
    for (const branchData of allBranchInventories) {
      const stock = branchData?.stock || 0;
      let expiryDate = null;
      const lot_number = branchData?.lot_number || null;

      // Skip if no stock
      if (stock <= 0) {
        continue;
      }

      // Validate expiry date
      if (branchData?.expiryDate && isValidDate(branchData.expiryDate)) {
        expiryDate = branchData.expiryDate;
      }

      const expiryThreshold = branchData?.expiryThreshold || 0; // Default to 0 if not specified

      // Create a batch for each inventory entry (only if stock > 0)
      let batchId = null;
      let actualBatchNumber = branchData?.batch_number || '';

      if (is_manual_entry && stock > 0) {
        try {
          // Generate batch number if not provided
          if (!actualBatchNumber) {
            const date = new Date();
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');

            // Get highest sequence number for today
            const [batchSeq] = await connection.query(
              `SELECT MAX(SUBSTRING_INDEX(batch_number, '-', -1)) as seq 
               FROM batches 
               WHERE batch_number LIKE ?`,
              [`BATCH-MANUAL-${year}${month}${day}-%`]
            );

            const seq = batchSeq[0].seq ? (parseInt(batchSeq[0].seq) + 1) : 1;
            actualBatchNumber = `BATCH-MANUAL-${year}${month}${day}-${String(seq).padStart(4, '0')}`;
          }

          // Insert batch record
          const userId = req.user?.userId || 1; // Default to 1 if no user context

          // Get the branch name
          const [branchResult] = await connection.query(
            "SELECT branch_name FROM branches WHERE branch_id = ?",
            [branchData.actualBranchId]
          );
          let branchName = branchResult[0]?.branch_name || "Branch";

          // Create batch notes
          const batchNotes = `Manual entry for product: ${name} in ${branchName}`;

          const [batchResult] = await connection.query(
            `INSERT INTO batches 
             (batch_number, order_number, supplier_id, received_date, notes, created_by, created_at)
             VALUES (?, NULL, 1, CURDATE(), ?, ?, NOW())`,
            [actualBatchNumber, batchNotes, userId]
          );

          batchId = batchResult.insertId;
          console.log(`Created new batch for branch ${branchData.actualBranchId}: ${actualBatchNumber} (ID: ${batchId})`);

          // Store batch info to return to client
          batchDetails.push({
            batchId: batchId,
            batchNumber: actualBatchNumber,
            branchId: branchData.actualBranchId,
            isTempId: branchData.isTempId || false,

            originalBranchId: branchData.branchId // Store the original ID (if temporary)
          });
        } catch (error) {
          console.error(`Error creating batch for branch ${branch.branch_id}:`, error);
          // Continue even if batch creation fails
        }
      }

      // Add metadata field to store additional inventory entry info if applicable
      const metadata = branchData.isTempId
        ? JSON.stringify({
          isTempId: branchData.isTempId || false,
          originalId: branchData.branchId // The generated ID from frontend
        })
        : null;

      console.log("Adding inventory for branch:", {
        branchId: branchData.actualBranchId,
        isTempId: branchData.isTempId || false,
        stock,
        expiryDate,
        expiryThreshold,
        lot_number,
        batch_id: batchId,
        batch_number: actualBatchNumber,
        metadata
      });

      // Insert branch inventory with batch_id (without storing metadata in the database)
      const [inventoryResult] = await connection.query(
        `INSERT INTO branch_inventory 
          (branch_id, product_id, batch_id, stock, expiryDate, expiryThreshold, is_active, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, TRUE, NOW(), NOW())`,
        [branchData.actualBranchId, productId, batchId, stock, expiryDate, expiryThreshold]
      );

      // If we have inventory created and batch ID, add to batch_items
      if (batchId && stock > 0 && inventoryResult.insertId) {
        try {
          await connection.query(
            `INSERT INTO batch_items 
             (batch_id, product_id, quantity, unit_cost, lot_number, created_at)
             VALUES (?, ?, ?, ?, ?, NOW())`,
            [
              batchId,
              productId,
              stock,
              unit_price_per_piece || 0,
              lot_number
            ]
          );

          // Add inventory history record
          await connection.query(
            `INSERT INTO inventory_history 
             (inventory_id, batch_id, transaction_type, quantity, previous_stock, 
              current_stock, remarks, created_at, created_by)
             VALUES (?, ?, 'MANUAL_ENTRY', ?, 0, ?, ?, NOW(), ?)`,
            [
              inventoryResult.insertId,
              batchId,
              stock,
              stock,
              `Manual inventory entry for batch ${actualBatchNumber}`,
              req.user?.userId || 1
            ]
          );
        } catch (error) {
          console.error(`Error creating batch_item for branch ${branch.branch_id}:`, error);
          // Continue even if batch item creation fails
        }
      }
    }

    await connection.commit();
    console.log("Transaction committed successfully");

    res.status(201).json({
      success: true,
      message: "Product added successfully",
      productId: productId,
      productName: name,
      batches: batchDetails, // Return all batch information by branch
    });
  } catch (error) {
    await connection.rollback();
    console.error("Error adding new product:", error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(400).json({
        success: false,
        message: "A product with the same barcode already exists",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to add product",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};


// Fetch all categories dynamically
exports.getCategories = async (req, res) => {
  try {
    const { includeInactive } = req.query;
    let query = `
            SELECT 
                c.category_id,
                c.name,
                c.prefix,
                c.is_active,
                COUNT(p.id) as product_count
            FROM category c
            LEFT JOIN products p ON p.category = c.category_id AND p.is_active = 1
        `;

    // By default, only show active categories unless includeInactive is true
    if (includeInactive !== "true") {
      query += " WHERE c.is_active = 1";
    }

    query +=
      " GROUP BY c.category_id, c.name, c.prefix, c.is_active ORDER BY c.name ASC";

    console.log("Executing query:", query); // For debugging
    const [rows] = await db.query(query);
    console.log("Found categories:", rows.length); // For debugging

    // Map the results to ensure proper number formatting
    const result = rows.map((category) => ({
      ...category,
      product_count: Number(category.product_count) || 0,
    }));

    res.status(200).json(result);
  } catch (error) {
    console.error("Error fetching categories:", error);
    // Check if it's a connection error
    if (
      error.code === "ECONNRESET" ||
      error.code === "PROTOCOL_CONNECTION_LOST"
    ) {
      res
        .status(503)
        .json({ message: "Database connection error. Please try again." });
    } else {
      res
        .status(500)
        .json({ message: "Error fetching categories", error: error.message });
    }
  }
};

// Delete a medicine based on its barcode
exports.deleteMedicine = async (req, res) => {
  const { barcode } = req.params; // Barcode passed in the URL

  if (!barcode) {
    return res.status(400).json({ message: "Barcode is required" });
  }

  try {
    // Delete the medicine from the database using the barcode
    const [result] = await db.query("DELETE FROM products WHERE barcode = ?", [
      barcode,
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Medicine not found" });
    }

    res.status(200).json({ message: "Medicine deleted successfully" });
  } catch (error) {
    console.error("Error deleting medicine:", error);
    res.status(500).json({ message: "Failed to delete medicine", error });
  }
};

// Delete multiple medicines based on an array of barcodes
exports.deleteMedicines = async (req, res) => {
  const { barcodes } = req.body; // Array of barcodes passed in the request body

  if (!barcodes || barcodes.length === 0) {
    return res.status(400).json({ message: "No barcodes provided" });
  }

  try {
    // Convert barcodes array into a comma-separated string for the SQL query
    const placeholders = barcodes.map(() => "?").join(",");

    // Delete the medicines from the database using the array of barcodes
    const [result] = await db.query(
      `DELETE FROM products WHERE barcode IN (${placeholders})`,
      barcodes
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ message: "No medicines found for the provided barcodes" });
    }

    res.status(200).json({ message: "Medicines deleted successfully" });
  } catch (error) {
    console.error("Error deleting medicines:", error);
    res.status(500).json({ message: "Failed to delete medicines", error });
  }
};

// Fetch medicine details based on medicineName
// Fetch medicine details based on medicineName
exports.getMedicineByName = async (req, res) => {
  const { medicineName } = req.params;
  const { branchId } = req.query; // Optional branch ID for branch-specific details

  if (!medicineName) {
    return res.status(400).json({ message: "Medicine barcode is required" });
  }

  try {
    // Get basic product information
    const [product] = await db.query(
      `
            SELECT 
                p.id,
                p.name,
                COALESCE(p.brand_name, '') as brand_name,
                COALESCE(p.barcode, '') as barcode,
                (SELECT COALESCE(b.batch_number, '') 
                 FROM branch_inventory bi 
                 JOIN batches b ON bi.batch_id = b.batch_id 
                 WHERE bi.product_id = p.id AND bi.is_active = TRUE 
                 LIMIT 1) as batch_number,
                p.category,
                c.name as category_name,
                COALESCE(p.description, '') as description,
                COALESCE(p.sideEffects, '') as sideEffects,
                COALESCE(p.dosage_amount, 0) as dosage_amount,
                COALESCE(p.dosage_unit, '') as dosage_unit,
                COALESCE(p.price, 0) as price,
                COALESCE(p.pieces_per_box, 0) as pieces_per_box,
                COALESCE(p.expiryDate, NULL) as expiryDate,
                COALESCE(p.requiresPrescription, 0) as requiresPrescription,
                COALESCE(p.VATExempt, 0) as VATExempt,
                COALESCE(p.critical, 0) as critical,
                COALESCE(p.enable_packaging_conversion, 0) as enable_packaging_conversion,
                COALESCE(p.packaging_unit, '') as packaging_unit,
                COALESCE(p.pieces_per_packaging, 0) as pieces_per_packaging,
                COALESCE(p.quantity_in_packaging_units, 0) as quantity_in_packaging_units,
                COALESCE(p.price_per_packaging, 0) as price_per_packaging,
                COALESCE(p.supplier_discount, 0) as supplier_discount,
                COALESCE(p.total_pieces, 0) as total_pieces,
                COALESCE(p.unit_price_per_piece, 0) as unit_price_per_piece,
                p.is_active,
                p.createdAt,
                p.updatedAt
            FROM products p
            LEFT JOIN category c ON p.category = c.category_id
            WHERE p.barcode = ? AND p.is_active = TRUE
        `,
      [medicineName]
    );

    if (product.length === 0) {
      return res.status(404).json({ message: "Medicine not found" });
    }

    // Get branch inventory information
    const [branchInventory] = await db.query(
      `
            SELECT 
                b.branch_id,
                b.branch_name,
                COALESCE(bi.stock, 0) as stock,
                bi.expiryDate,
                bi.expiryThreshold as expiryWarningDays,
                COALESCE(bt.batch_number, '') as batch_number,
                COALESCE(bil.lot_number, '') as lot_number,
                COALESCE(bi.createdAt, NOW()) as createdAt,
                COALESCE(bi.updatedAt, NOW()) as updatedAt
            FROM branches b
            LEFT JOIN branch_inventory bi ON b.branch_id = bi.branch_id 
                AND bi.product_id = ? AND bi.is_active = TRUE
            LEFT JOIN batches bt ON bi.batch_id = bt.batch_id
            LEFT JOIN batch_items bil ON bt.batch_id = bil.batch_id AND bil.product_id = ?
            WHERE b.is_active = TRUE
            ORDER BY b.branch_name ASC
        `,
      [product[0].id, product[0].id]
    );

    // Calculate total stock from all branches
    const totalStock = branchInventory.reduce(
      (sum, branch) => sum + (branch.stock || 0),
      0
    );

    // Get earliest expiry date across all branches
    const earliestExpiry =
      branchInventory
        .filter((b) => b.expiryDate)
        .sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate))[0]
        ?.expiryDate || null;

    // Format the response
    const response = {
      medicineInfo: {
        ...product[0],
        price: `₱${parseFloat(product[0].price).toFixed(2)}`,
        total_stock: totalStock,
        earliest_expiry: earliestExpiry,
      },
      branchInventory: branchInventory.map((branch) => ({
        branch_id: branch.branch_id,
        branch_name: branch.branch_name,
        stock: branch.stock || 0,
        expiryDate: branch.expiryDate || null,
        expiryWarningDays: branch.expiryWarningDays ?? 0,
        createdAt: branch.createdAt,
        updatedAt: branch.updatedAt,
      })),
    };

    res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching medicine details:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch medicine details", error });
  }
};

// Delete Medicine by name
exports.deleteInEditMedicine = async (req, res) => {
  const { medicineName } = req.params; // Get the medicine name from the URL parameters

  try {
    // SQL query to delete the medicine from the database based on the name
    const deleteQuery = 'DELETE FROM products WHERE name = ?';
    const [deleteResult] = await db.query(deleteQuery, [medicineName]);

    // If no rows were affected, the medicine was not found
    if (deleteResult.affectedRows === 0) {
      return res.status(404).json({ message: 'Medicine not found for deletion' });
    }

    // Return success message upon successful deletion
    res.status(200).json({ message: `Medicine with name ${medicineName} deleted successfully` });
  } catch (error) {
    console.error('Error deleting medicine:', error);
    res.status(500).json({ message: 'Error deleting medicine' });
  }
};




exports.updateMedicineDescription = async (req, res) => {
  const { medicineName } = req.params;
  const {
    name,
    brand_name,
    barcode,
    category,
    price,
    description,
    sideEffects,
    dosage_amount,
    dosage_unit,
    pieces_per_box,
    requiresPrescription,
    VATExempt,
    critical,
    enable_packaging_conversion,
    packaging_unit,
    pieces_per_packaging,
    quantity_in_packaging_units,
    price_per_packaging,
    supplier_discount,
  } = req.body;

  try {
    // Get category_id from category name
    const [categoryResult] = await db.query(
      "SELECT category_id FROM category WHERE name = ?",
      [category]
    );

    if (!categoryResult || categoryResult.length === 0) {
      return res.status(400).json({ message: "Invalid category" });
    }

    const categoryId = categoryResult[0].category_id;
    const currentTimestamp = timeZoneUtil.getMySQLTimestamp();

    // Calculate packaging conversion values
    let total_pieces = 0;
    let unit_price_per_piece = 0;

    if (
      enable_packaging_conversion &&
      pieces_per_packaging &&
      quantity_in_packaging_units &&
      price_per_packaging
    ) {
      const piecesPerPackaging = parseInt(pieces_per_packaging) || 0;
      const quantityInPackagingUnits =
        parseInt(quantity_in_packaging_units) || 0;
      const pricePerPackaging = parseFloat(price_per_packaging) || 0;

      total_pieces = piecesPerPackaging * quantityInPackagingUnits;
      unit_price_per_piece =
        total_pieces > 0
          ? pricePerPackaging / total_pieces
          : 0;
    }

    // Update the medicine details
    const [result] = await db.query(
      `UPDATE products 
        SET name = ?, 
            brand_name = ?, 
            barcode = ?, 
            category = ?, 
            price = ?, 
            description = ?, 
            sideEffects = ?, 
            dosage_amount = ?, 
            dosage_unit = ?, 
            pieces_per_box = ?, 
            requiresPrescription = ?,
            VATExempt = ?,
            critical = ?,
            enable_packaging_conversion = ?,
            packaging_unit = ?,
            pieces_per_packaging = ?,
            quantity_in_packaging_units = ?,
            price_per_packaging = ?,
            supplier_discount = ?,
            total_pieces = ?,
            unit_price_per_piece = ?,
            updatedAt = ${currentTimestamp}
        WHERE barcode = ?`,
      [
        name,
        brand_name,
        barcode,
        categoryId,
        price,
        description,
        sideEffects,
        dosage_amount,
        dosage_unit,
        pieces_per_box,
        requiresPrescription,
        VATExempt,
        critical,
        enable_packaging_conversion ? 1 : 0,
        packaging_unit,
        pieces_per_packaging,
        quantity_in_packaging_units,
        price_per_packaging,
        supplier_discount,
        total_pieces,
        unit_price_per_piece,
        medicineName,
      ]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ message: "Medicine not found or no changes made." });
    }

    res.status(200).json({ message: "Medicine details updated successfully." });
  } catch (error) {
    console.error("Error updating medicine details:", error);
    res.status(500).json({ message: "Error updating medicine details", error });
  }
};


// Add new function to get archived products
exports.getArchivedProducts = async (req, res) => {
  try {
    const { orderBy = "archived_at", sortDirection = "desc" } = req.query;
    const validColumns = [
      "name",
      "brand_name",
      "barcode",
      "category",
      "archived_at",
    ];
    const timeZoneUtil = require("../utils/timeZoneUtil");

    const sortColumn = validColumns.includes(orderBy) ? orderBy : "archived_at";
    const direction = sortDirection === "desc" ? "DESC" : "ASC";

    // First get the archived products with timezone-adjusted archived_at
    const query = `
          SELECT 
            pa.*,
            c.name as category_name,
            u.name as archived_by_name,
            ${timeZoneUtil.getConvertTZString("pa.archived_at")} as archived_at
          FROM products_archive pa
          LEFT JOIN category c ON pa.category = c.category_id
          LEFT JOIN users u ON pa.archived_by = u.user_id
          ORDER BY ${sortColumn} ${direction}
        `;

    const [products] = await db.query(query);

    // Get branch inventory data for each product
    const productsWithInventory = await Promise.all(
      products.map(async (product) => {
        const [branchInventory] = await db.query(
          `
                SELECT 
                    bia.branch_id,
                    bia.stock,
                    bia.expiryDate,
                    b.branch_name
                FROM branch_inventory_archive bia
                JOIN branches b ON bia.branch_id = b.branch_id
                WHERE bia.product_id = ?
                ORDER BY bia.archived_at DESC
            `,
          [product.product_id]
        );

        return {
          ...product,
          branch_inventory: branchInventory,
        };
      })
    );

    res.json(productsWithInventory);
  } catch (error) {
    console.error("Error in getArchivedProducts:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Update delete function to archive instead
exports.archiveProduct = async (req, res) => {
  console.log("Archive request received:", {
    params: req.params,
    body: req.body,
  });

  const { barcode } = req.params;
  const { employee_id, userName, reason } = req.body;

  if (!reason) {
    console.log("Archive failed: Missing reason");
    return res.status(400).json({ message: "Archive reason is required" });
  }

  if (!employee_id) {
    console.log("Archive failed: Missing employee_id");
    return res.status(400).json({ message: "Employee ID is required" });
  }

  console.log("Starting archive process for:", {
    barcode,
    employee_id,
    reason,
  });

  const connection = await db.getConnection();
  console.log("Database connection established");

  try {
    await connection.beginTransaction();
    console.log("Transaction started");

    // Get product details and verify it exists and is active
    console.log("Querying product details for barcode:", barcode);
    const [product] = await connection.query(
      "SELECT * FROM products WHERE barcode = ? AND is_active = TRUE FOR UPDATE",
      [barcode]
    );
    console.log("Product query result:", product);

    if (!product || product.length === 0) {
      console.log("Product not found or already archived");
      await connection.rollback();
      return res
        .status(404)
        .json({ message: "Product not found or already archived" });
    }

    // Get branch inventory details before archiving
    const [branchInventory] = await connection.query(
      `
            SELECT bi.*, b.branch_name 
            FROM branch_inventory bi 
            JOIN branches b ON bi.branch_id = b.branch_id 
            WHERE bi.product_id = ? AND bi.is_active = TRUE`,
      [product[0].id]
    );
    console.log("Branch inventory details:", branchInventory);

    // Verify the user exists and get their user_id
    console.log("Verifying employee ID:", employee_id);
    const [user] = await connection.query(
      "SELECT user_id FROM users WHERE employee_id = ?",
      [employee_id]
    );
    console.log("User query result:", user);

    if (!user || user.length === 0) {
      console.log("Invalid employee ID");
      await connection.rollback();
      return res.status(404).json({ message: "Invalid employee ID" });
    }

    try {
      // Archive branch inventory records
      console.log("Archiving branch inventory records");
      await connection.query(
        `
                INSERT INTO branch_inventory_archive (
                    branch_id, product_id, stock, expiryDate, 
                    archived_by, archive_reason, archived_at
                )
                SELECT 
                    branch_id, product_id, stock, expiryDate,
                    ?, ?, ${timeZoneUtil.getMySQLTimestamp()}
                FROM branch_inventory
                WHERE product_id = ? AND is_active = TRUE`,
        [employee_id, reason, product[0].id]
      );

      // Deactivate branch inventory records
      await connection.query(
        "UPDATE branch_inventory SET is_active = FALSE WHERE product_id = ?",
        [product[0].id]
      );

      // Insert into products archive with proper timezone
      console.log("Inserting into products_archive");
      const archiveResult = await connection.query(
        `INSERT INTO products_archive (
                    product_id, barcode, name, brand_name, category, description, 
                    sideEffects, dosage_amount, dosage_unit, price, 
                    pieces_per_box, critical, requiresPrescription, VATExempt, expiryDate,
                    archived_by, archive_reason, archived_at
                ) VALUES  (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          product[0].id,
          product[0].barcode,
          product[0].name,
          product[0].brand_name,
          product[0].category,
          product[0].description,
          product[0].sideEffects,
          product[0].dosage_amount,
          product[0].dosage_unit,
          product[0].price,
          product[0].pieces_per_box,
          product[0].critical,
          product[0].requiresPrescription,
          product[0].VATExempt,
          product[0].expiryDate,
          user[0].user_id,
          reason,
          timeZoneUtil.getMySQLTimestamp()
        ]
      );
      console.log("Archive insert result:", archiveResult);

      // Update product status
      console.log("Updating product status to inactive");
      const updateResult = await connection.query(
        "UPDATE products SET is_active = FALSE, updatedAt = NOW() WHERE barcode = ?",
        [barcode]
      );
      console.log("Product update result:", updateResult);

      await connection.commit();
      console.log("Transaction committed successfully");

      const response = {
        success: true,
        message: `Product "${product[0].name}" has been archived successfully`,
        productName: product[0].name,
        productId: product[0].id,
        branchInventoryCount: branchInventory.length,
      };
      console.log("Sending success response:", response);
      res.json(response);
    } catch (error) {
      console.error("Database error during archive operations:", error);
      await connection.rollback();
      console.log("Transaction rolled back due to database error");
      res.status(500).json({
        success: false,
        message: "Database error while archiving product",
        error: error.message,
      });
    }
  } catch (error) {
    console.error("Error in archive process:", error);
    if (connection) {
      await connection.rollback();
      console.log("Transaction rolled back due to error");
    }
    res.status(500).json({
      success: false,
      message: "Failed to archive product",
      error: error.message,
    });
  } finally {
    if (connection) {
      connection.release();
      console.log("Database connection released");
    }
  }
};

// Add function to restore archived product
exports.restoreProduct = async (req, res) => {
  const { productId } = req.params;
  const { employee_id, userName } = req.body;

  if (!employee_id) {
    return res.status(400).json({ message: "Employee ID is required" });
  }

  const connection = await db.getConnection();
  console.log("Starting restore process for product ID:", productId);

  try {
    await connection.beginTransaction();
    console.log("Transaction started");

    // Verify the user exists
    console.log("Verifying employee ID:", employee_id);
    const [user] = await connection.query(
      "SELECT employee_id FROM users WHERE employee_id = ?",
      [employee_id]
    );
    console.log("User query result:", user);

    if (!user || user.length === 0) {
      console.log("Invalid employee ID");
      await connection.rollback();
      return res.status(404).json({ message: "Invalid employee ID" });
    }

    // Check if product exists in archive
    const [archived] = await connection.query(
      `SELECT pa.*, c.name as category_name 
             FROM products_archive pa
             LEFT JOIN category c ON pa.category = c.category_id
             WHERE pa.product_id = ?`,
      [productId]
    );
    console.log("Archived product data:", archived[0]);

    if (!archived || archived.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Archived product not found" });
    }

    // Check if product exists and is inactive
    const [existingProduct] = await connection.query(
      "SELECT * FROM products WHERE id = ?",
      [productId]
    );
    console.log("Existing product data:", existingProduct[0]);

    if (!existingProduct || existingProduct.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Product record not found" });
    }

    if (existingProduct[0].is_active) {
      await connection.rollback();
      return res.status(400).json({ message: "Product is already active" });
    }

    // Get archived branch inventory
    const [archivedInventory] = await connection.query(
      `SELECT bia.*, b.branch_name 
             FROM branch_inventory_archive bia
             JOIN branches b ON bia.branch_id = b.branch_id
             WHERE bia.product_id = ?
             ORDER BY bia.archived_at DESC`,
      [productId]
    );
    console.log("Archived branch inventory data:", archivedInventory);

    // Get all active branches
    const [activeBranches] = await connection.query(
      "SELECT branch_id FROM branches WHERE is_active = TRUE"
    );
    console.log("Active branches:", activeBranches);

    // Restore branch inventory for all active branches
    for (const branch of activeBranches) {
      const archivedBranchData = archivedInventory.find(
        (inv) => inv.branch_id === branch.branch_id
      );

      await connection.query(
        `
                INSERT INTO branch_inventory 
                (branch_id, product_id, stock, expiryDate, is_active, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, TRUE, NOW(), NOW())
                ON DUPLICATE KEY UPDATE 
                stock = VALUES(stock),
                expiryDate = VALUES(expiryDate),
                is_active = TRUE,
                updatedAt = NOW()`,
        [
          branch.branch_id,
          productId,
          archivedBranchData?.stock || 0,
          archivedBranchData?.expiryDate || null,
        ]
      );
      console.log(`Restored inventory for branch ${branch.branch_id}`);
    }

    // Restore product
    await connection.query(
      `UPDATE products SET 
                is_active = TRUE,
                name = ?,
                brand_name = ?,
                barcode = ?,
                category = ?,
                description = ?,
                sideEffects = ?,
                dosage_amount = ?,
                dosage_unit = ?,
                price = ?,
                pieces_per_box = ?,
                critical = ?,
                requiresPrescription = ?,
                VATExempt = ?,
                expiryDate = ?,
                updatedAt = NOW()
            WHERE id = ?`,
      [
        archived[0].name,
        archived[0].brand_name,
        archived[0].barcode,
        archived[0].category,
        archived[0].description,
        archived[0].sideEffects,
        archived[0].dosage_amount,
        archived[0].dosage_unit,
        archived[0].price,
        archived[0].pieces_per_box,
        archived[0].critical,
        archived[0].requiresPrescription,
        archived[0].VATExempt,
        archived[0].expiryDate,
        productId,
      ]
    );
    console.log("Product restored to active state");

    // Remove from archives
    await connection.query(
      "DELETE FROM products_archive WHERE product_id = ?",
      [productId]
    );
    console.log("Removed from products_archive");

    await connection.query(
      "DELETE FROM branch_inventory_archive WHERE product_id = ?",
      [productId]
    );
    console.log("Removed from branch_inventory_archive");

    await connection.commit();
    console.log("Restore transaction committed successfully");

    res.json({
      success: true,
      message: `Product "${archived[0].name}" has been restored successfully`,
      productName: archived[0].name,
      productId: productId,
      categoryName: archived[0].category_name,
      restoredInventoryCount: archivedInventory.length,
    });
  } catch (error) {
    console.error("Error in restore process:", error);
    await connection.rollback();
    res.status(500).json({
      success: false,
      message: "Failed to restore product",
      error: error.message,
    });
  } finally {
    connection.release();
    console.log("Database connection released");
  }
};

// Get all suppliers
exports.getSuppliers = async (req, res) => {
  try {
    const [suppliers] = await db.query(
      'SELECT supplier_id, supplier_name, contact_person, email, phone FROM suppliers WHERE is_archived = 0'
    );
    res.json(suppliers);
  } catch (error) {
    console.error('Error fetching suppliers:', error);
    res.status(500).json({ message: 'Error fetching suppliers' });
  }
};

// Get all branches
exports.getBranches = async (req, res) => {
  try {
    const [branches] = await db.query(
      "SELECT * FROM branches WHERE is_active = TRUE ORDER BY branch_name"
    );
    res.json(branches);
  } catch (error) {
    console.error("Error fetching branches:", error);
    res.status(500).json({ message: "Failed to fetch branches", error });
  }
};

// Update branch inventory
// Update branch inventory
exports.updateBranchInventory = async (req, res) => {
  const { branchId, productId, stock, expiryDate, expiryWarningDays, supplierId, batchNumber, lotNumber } = req.body;

  if (!branchId || !productId || stock === undefined || !supplierId) {
    return res.status(400).json({ message: "Branch ID, Product ID, and stock are required" });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    let batchId = null;

    // If batch number is provided, find or create batch
    if (batchNumber && batchNumber.trim() !== '') {
      const [existingBatch] = await connection.query(
        "SELECT batch_id FROM batches WHERE batch_number = ? LIMIT 1",
        [batchNumber.trim()]
      );

      if (existingBatch.length > 0) {
        batchId = existingBatch[0].batch_id;
      } else {
        // Create new batch
        const [newBatch] = await connection.query(
          "INSERT INTO batches (batch_number, order_number, supplier_id, received_date, notes, created_by, created_at) VALUES (?, NULL, ?, CURDATE(), 'Created from inventory update', 1, NOW())",
          [batchNumber.trim(), supplierId]
        );
        batchId = newBatch.insertId;
      }
    }

    // Check if inventory record exists
    const [existing] = await connection.query(
      "SELECT * FROM branch_inventory WHERE branch_id = ? AND product_id = ? AND is_active = TRUE",
      [branchId, productId]
    );

    if (existing.length > 0) {
      // Update existing record, including batch information
      await connection.query(
        "UPDATE branch_inventory SET stock = ?, expiryDate = ?, expiryThreshold = ?, batch_id = ?, updatedAt = NOW() WHERE branch_id = ? AND product_id = ?",
        [stock, expiryDate, expiryWarningDays, batchId, branchId, productId]
      );
    } else {
      // Create new record, including batch information
      await connection.query(
        "INSERT INTO branch_inventory (branch_id, product_id, stock, expiryDate, expiryThreshold, batch_id) VALUES (?, ?, ?, ?, ?, ?)",
        [branchId, productId, stock, expiryDate, expiryWarningDays, batchId]
      );
    }

    // If we have a batch and lot number, update the batch_items table
    if (batchId && lotNumber && lotNumber.trim() !== '') {
      // Check if batch_items record exists for this batch and product
      const [existingBatchItem] = await connection.query(
        "SELECT * FROM batch_items WHERE batch_id = ? AND product_id = ?",
        [batchId, productId]
      );

      if (existingBatchItem.length > 0) {
        // Update existing batch_items record
        await connection.query(
          "UPDATE batch_items SET lot_number = ? WHERE batch_id = ? AND product_id = ?",
          [lotNumber, batchId, productId]
        );
      } else {
        // Create new batch_items record
        await connection.query(
          "INSERT INTO batch_items (batch_id, product_id, quantity, lot_number, created_at) VALUES (?, ?, ?, ?, NOW())",
          [batchId, productId, stock, lotNumber]
        );
      }
    }

    await connection.commit();
    res.json({ message: "Branch inventory updated successfully" });
  } catch (error) {
    await connection.rollback();
    console.error("Error updating branch inventory:", error);
    res.status(500).json({ message: "Failed to update branch inventory", error });
  } finally {
    connection.release();
  }
};


exports.getCriticalProducts = async (req, res) => {
  try {
    const timeZoneUtil = require("../utils/timeZoneUtil");

    // Get products with stock below critical level in any branch
    const [products] = await db.query(`
            SELECT DISTINCT
            p.id,
            p.name,
            p.brand_name,
            p.barcode,
            p.category,
            c.name AS category_name,
            p.critical,
            p.price,
            p.createdAt,
            p.updatedAt,
            ${timeZoneUtil.getConvertTZString("p.createdAt")} AS created_at,
            ${timeZoneUtil.getConvertTZString("p.updatedAt")} AS updated_at
        FROM 
            products p
        JOIN 
            branch_inventory bi ON p.id = bi.product_id
        LEFT JOIN 
            category c ON p.category = c.category_id
        WHERE 
            p.is_active = TRUE 
            AND bi.is_active = TRUE
            AND bi.stock <= p.critical;
        `);

    // Get branch inventory for each product
    const productsWithInventory = await Promise.all(
      products.map(async (product) => {
        const [branchInventory] = await db.query(
          `
                SELECT 
                    bi.branch_id,
                    bi.stock,
                    bi.expiryDate,
                    b.branch_name
                FROM branch_inventory bi
                JOIN branches b ON bi.branch_id = b.branch_id
                WHERE bi.product_id = ? AND bi.is_active = TRUE
            `,
          [product.id]
        );

        return {
          ...product,
          branch_inventory: branchInventory,
        };
      })
    );

    res.json(productsWithInventory);
  } catch (error) {
    console.error("Error getting critical products:", error);
    res.status(500).json({ message: "Error getting critical products" });
  }
};

exports.getCriticalProductsByBranch = async (req, res) => {
  try {
    const { branchId } = req.query;
    const timeZoneUtil = require("../utils/timeZoneUtil");

    if (!branchId) {
      return res.status(400).json({ message: "Branch ID is required" });
    }

    // Get products with stock below critical level for the specific branch
    const [products] = await db.query(
      `
            SELECT DISTINCT
                p.id,
                p.name,
                p.brand_name,
                p.barcode,
                p.category,
                c.name AS category_name,
                p.critical,
                p.price,
                p.createdAt,
                p.updatedAt,
                ${timeZoneUtil.getConvertTZString("p.createdAt")} AS created_at,
                ${timeZoneUtil.getConvertTZString("p.updatedAt")} AS updated_at
            FROM 
                products p
            JOIN 
                branch_inventory bi ON p.id = bi.product_id
            LEFT JOIN 
                category c ON p.category = c.category_id
            WHERE 
                p.is_active = TRUE 
                AND bi.is_active = TRUE
                AND bi.branch_id = ?
                AND bi.stock <= p.critical;
        `,
      [branchId]
    );

    // Get branch inventory for each product (only for the specified branch)
    const productsWithInventory = await Promise.all(
      products.map(async (product) => {
        const [branchInventory] = await db.query(
          `
                SELECT 
                    bi.branch_id,
                    bi.stock,
                    bi.expiryDate,
                    b.branch_name
                FROM branch_inventory bi
                JOIN branches b ON bi.branch_id = b.branch_id
                WHERE bi.product_id = ? 
                AND bi.branch_id = ?
                AND bi.is_active = TRUE
            `,
          [product.id, branchId]
        );

        return {
          ...product,
          branch_inventory: branchInventory,
        };
      })
    );

    res.json(productsWithInventory);
  } catch (error) {
    console.error("Error getting critical products by branch:", error);
    res
      .status(500)
      .json({ message: "Error getting critical products by branch" });
  }
};

// Archive a category
exports.archiveCategory = async (req, res) => {
  const { categoryId } = req.params;
  const { archivedBy } = req.body;

  if (!categoryId || !archivedBy) {
    return res
      .status(400)
      .json({ message: "Category ID and user ID are required" });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // Get category details before archiving
    const [category] = await connection.query(
      "SELECT * FROM category WHERE category_id = ? AND is_active = 1",
      [categoryId]
    );

    if (category.length === 0) {
      await connection.rollback();
      return res
        .status(404)
        .json({ message: "Category not found or already archived" });
    }

    // Insert into category_archive
    await connection.query(
      `INSERT INTO category_archive (
                category_id, name, prefix, archived_by, archived_at
            ) VALUES (?, ?, ?, ?, ${timeZoneUtil.getMySQLTimestamp()})`,
      [categoryId, category[0].name, category[0].prefix, archivedBy]
    );

    // Update products to set category to NULL
    await connection.query(
      "UPDATE products SET category = NULL WHERE category = ?",
      [categoryId]
    );

    // Update category to inactive instead of deleting
    await connection.query(
      "UPDATE category SET is_active = 0 WHERE category_id = ?",
      [categoryId]
    );

    await connection.commit();
    res.json({ message: "Category archived successfully" });
  } catch (error) {
    await connection.rollback();
    console.error("Error archiving category:", error);
    res.status(500).json({ message: "Failed to archive category" });
  } finally {
    connection.release();
  }
};

// Get archived categories
exports.getArchivedCategories = async (req, res) => {
  try {
    const query = `
            SELECT 
                ca.*,
                u.name as archived_by_name,
                ${timeZoneUtil.getConvertTZString(
      "ca.archived_at"
    )} as archived_at
            FROM category_archive ca
            LEFT JOIN users u ON ca.archived_by = u.user_id
            ORDER BY ca.archived_at DESC
        `;

    const [categories] = await db.query(query);
    res.json(categories);
  } catch (error) {
    console.error("Error getting archived categories:", error);
    res.status(500).json({ message: "Failed to get archived categories" });
  }
};

// Restore archived category
exports.restoreCategory = async (req, res) => {
  const { categoryId } = req.params;

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // Get archived category details
    const [archivedCategory] = await connection.query(
      "SELECT * FROM category_archive WHERE category_id = ?",
      [categoryId]
    );

    if (archivedCategory.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Archived category not found" });
    }

    // Update category to active if it exists, or insert if it doesn't
    await connection.query(
      `INSERT INTO category (category_id, name, prefix, is_active) 
             VALUES (?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE 
             name = VALUES(name),
             prefix = VALUES(prefix),
             is_active = 1`,
      [categoryId, archivedCategory[0].name, archivedCategory[0].prefix]
    );

    // Delete from archive
    await connection.query(
      "DELETE FROM category_archive WHERE category_id = ?",
      [categoryId]
    );

    await connection.commit();
    res.json({ message: "Category restored successfully" });
  } catch (error) {
    await connection.rollback();
    console.error("Error restoring category:", error);
    res.status(500).json({ message: "Failed to restore category" });
  } finally {
    connection.release();
  }
};

// Restore expired product
exports.restoreExpiredProduct = async (req, res) => {

  const connection = await db.getConnection();

  try {
    let barcodes = [];

    // Check if barcode is provided in URL params (single restore)
    if (req.params.productId) {
      barcodes = [req.params.productId];
    }
    // Check if barcodes are provided in request body (bulk restore)
    else if (req.body && req.body.barcodes) {
      barcodes = req.body.barcodes;
    }

    if (!Array.isArray(barcodes) || barcodes.length === 0) {
      return res.status(400).json({ message: 'No barcodes provided' });
    }

    console.log('Starting restore process for expired products barcodes:', barcodes);

    // Restore products in branch_inventory where barcode matches and is archived
    const [result] = await connection.query(`
            UPDATE branch_inventory 
            SET is_active = 1 
            WHERE product_id IN (
                SELECT id FROM products WHERE barcode IN (?)
            ) AND is_active = 0

        `, [barcodes]);

    console.log('Restore result:', result);

    res.json({
      message: 'Expired products restored successfully',
      restoredCount: result.affectedRows
    });
  } catch (error) {
    console.error('Error restoring expired products:', error);
    res.status(500).json({
      message: 'Error restoring expired products',
      error: error.message
    });
  } finally {
    connection.release();
  }
};

// Add this new controller function
exports.getMedicineAvailableByBranch = async (req, res) => {
  try {
    const {
      orderBy = "updatedAt",
      sortDirection = "asc",
      createdStartDate,
      createdEndDate,
      updatedStartDate,
      updatedEndDate,
      branch_id,
    } = req.query;

    if (!branch_id) {
      return res.status(400).json({ message: "Branch ID is required" });
    }

    const validColumns = [
      "name",
      "brand_name",
      "barcode",
      "category",
      "price",
      "stock",
      "createdAt",
    ];
    const sortColumn = validColumns.includes(orderBy) ? orderBy : "updatedAt";
    const direction = sortDirection === "desc" ? "DESC" : "ASC";

    let query = `
            SELECT 
                p.id as medicineID, 
                p.name, 
                p.brand_name, 
                p.barcode, 
                c.name as category,
                p.price,
                bi.stock,
                (SELECT GROUP_CONCAT(DISTINCT batch.batch_number)
                    FROM branch_inventory bi2
                    LEFT JOIN batches batch ON bi2.batch_id = batch.batch_id
                    WHERE bi2.product_id = p.id AND bi2.is_active = TRUE) as batch_number,
                CASE 
                    WHEN bi.expiryDate IS NULL OR bi.expiryDate = '0000-00-00' OR STR_TO_DATE(bi.expiryDate, '%Y-%m-%d') IS NULL THEN NULL
                    ELSE bi.expiryDate
                END as expiryDate,
                bi.expiryThreshold,
                CASE 
                    WHEN bi.expiryDate IS NULL OR bi.expiryDate = '0000-00-00' THEN NULL
                    ELSE DATEDIFF(bi.expiryDate, CURDATE())
                END as days_until_expiry,
                CASE 
                    WHEN bi.expiryDate IS NULL OR bi.expiryDate = '0000-00-00' THEN 'no_date'
                    WHEN bi.expiryDate < CURDATE() THEN 'expired'
                    WHEN DATEDIFF(bi.expiryDate, CURDATE()) <= bi.expiryThreshold THEN 'near_expiry'
                    ELSE 'ok'
                END as expiry_status,
                ${timeZoneUtil.getConvertTZString("p.createdAt")} as createdAt,
                ${timeZoneUtil.getConvertTZString("p.updatedAt")} as updatedAt
            FROM products p
            LEFT JOIN category c ON p.category = c.category_id
            LEFT JOIN branch_inventory bi ON p.id = bi.product_id AND bi.branch_id = ? AND bi.is_active = TRUE
            LEFT JOIN batches batch ON bi.batch_id = batch.batch_id
            WHERE p.is_active = TRUE
        `;

    const queryParams = [branch_id];

    // Add date filters if provided
    if (createdStartDate) {
      query += ` AND p.createdAt >= ?`;
      queryParams.push(createdStartDate);
    }
    if (createdEndDate) {
      query += ` AND p.createdAt <= ?`;
      queryParams.push(createdEndDate);
    }
    if (updatedStartDate) {
      query += ` AND p.updatedAt >= ?`;
      queryParams.push(updatedStartDate);
    }
    if (updatedEndDate) {
      query += ` AND p.updatedAt <= ?`;
      queryParams.push(updatedEndDate);
    }

    query += ` ORDER BY ${sortColumn} ${direction}`;

    console.log("Fetching products for branch:", branch_id);
    const [products] = await db.query(query, queryParams);

    res.json(products);
  } catch (error) {
    console.error("Error in getMedicineAvailableByBranch:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.getInventoryStatsByBranch = async (req, res) => {
  try {
    const { branchId } = req.query;

    if (!branchId) {
      return res.status(400).json({ message: "Branch ID is required" });
    }

    console.log("Getting inventory stats for branch:", branchId);

    // Get total active products for this branch
    const [productsCount] = await db.query(`
            SELECT COUNT(DISTINCT p.id) as count 
            FROM products p
            WHERE p.is_active = TRUE
        `);

    // Get total categories
    const [categoriesCount] = await db.query(
      "SELECT COUNT(*) as count FROM category WHERE is_active = TRUE"
    );

    // Get count of products with stock below critical level in this branch
    const [criticalCount] = await db.query(
      `
            SELECT COUNT(DISTINCT p.id) as count
            FROM products p
            JOIN branch_inventory bi ON p.id = bi.product_id
            WHERE p.is_active = TRUE 
            AND bi.is_active = TRUE
            AND bi.stock <= p.critical
            AND bi.branch_id = ?
        `,
      [branchId]
    );

    // Get count of expired products in this branch
    const [expiredCount] = await db.query(
      `
            SELECT COUNT(*) AS count
            FROM branch_inventory bi
            JOIN products p ON bi.product_id = p.id
            JOIN category c ON p.category = c.category_id
            WHERE 
            bi.is_active = TRUE
            AND bi.expiryDate IS NOT NULL
            AND bi.expiryDate != '0000-00-00'
            AND bi.branch_id = ?
            AND bi.expiryDate < CURDATE()
        `, [branchId]);



    console.log('Branch inventory stats retrieved:', {
      productsAvailable: productsCount[0].count,
      medicineGroups: categoriesCount[0].count,
      medicineShortage: criticalCount[0].count,
      expiredProducts: expiredCount[0].count
    });

    return res.json({
      productsAvailable: productsCount[0].count,
      medicineGroups: categoriesCount[0].count,
      medicineShortage: criticalCount[0].count,
      expiredProducts: expiredCount[0].count,
    });
  } catch (error) {
    console.error("Error getting inventory stats:", error);
    res.status(500).json({
      message: "Error getting inventory stats",
      error: error.message,
    });
  }
};

// Add new function to get archived products by branch
exports.getArchivedProductsByBranch = async (req, res) => {
  try {
    const { branch_id } = req.query;

    if (!branch_id) {
      return res.status(400).json({ message: "Branch ID is required" });
    }

    console.log("Getting archived products for branch:", branch_id);

    // Get archived products where archiver is from the same branch
    const query = `
            SELECT 
                pa.*,
                c.name as category_name,
                u.name as archived_by_name,
                u.branch_id as archiver_branch_id,
                ${timeZoneUtil.getConvertTZString(
      "pa.archived_at"
    )} as archived_at,
                bia.stock,
                bia.expiryDate
            FROM products_archive pa
            LEFT JOIN category c ON pa.category = c.category_id
            LEFT JOIN users u ON pa.archived_by = u.user_id
            LEFT JOIN branch_inventory_archive bia ON pa.product_id = bia.product_id 
                AND bia.branch_id = ?
            WHERE u.branch_id = ?  -- Filter by archiver's branch
            ORDER BY pa.archived_at DESC
        `;

    const [products] = await db.query(query, [branch_id, branch_id]);

    console.log("Found archived products:", products.length);

    // Format the response
    const formattedProducts = products.map((product) => ({
      ...product,
      price: `₱${parseFloat(product.price).toFixed(2)}`,
      branch_inventory: [
        {
          branch_id: parseInt(branch_id),
          stock: product.stock || 0,
          expiryDate: product.expiryDate,
        },
      ],
    }));

    res.json(formattedProducts);
  } catch (error) {
    console.error("Error in getArchivedProductsByBranch:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Add new function to get medicine details by name and branch
exports.getMedicineByNameAndBranch = async (req, res) => {
  const { medicineName } = req.params;
  const { branch_id } = req.query;

  if (!medicineName || !branch_id) {
    return res
      .status(400)
      .json({ message: "Medicine name and branch ID are required" });
  }

  try {
    // Get basic product information with branch-specific inventory
    const [product] = await db.query(
      `
            SELECT 
                p.id,
                p.name,
                COALESCE(p.brand_name, '') as brand_name,
                COALESCE(p.barcode, '') as barcode,
                (SELECT COALESCE(b.batch_number, '') 
                 FROM branch_inventory bi 
                 JOIN batches b ON bi.batch_id = b.batch_id 
                 WHERE bi.product_id = p.id AND bi.branch_id = ? AND bi.is_active = TRUE 
                 LIMIT 1) as batch_number,
                p.category,
                c.name as category_name,
                COALESCE(p.description, '') as description,
                COALESCE(p.sideEffects, '') as sideEffects,
                COALESCE(p.dosage_amount, 0) as dosage_amount,
                COALESCE(p.dosage_unit, '') as dosage_unit,
                COALESCE(p.price, 0) as price,
                COALESCE(p.pieces_per_box, 0) as pieces_per_box,
                COALESCE(p.expiryDate, NULL) as expiryDate,
                COALESCE(p.requiresPrescription, 0) as requiresPrescription,
                COALESCE(p.VATExempt, 0) as VATExempt,
                COALESCE(p.critical, 0) as critical,
                COALESCE(p.enable_packaging_conversion, 0) as enable_packaging_conversion,
                COALESCE(p.packaging_unit, '') as packaging_unit,
                COALESCE(p.pieces_per_packaging, 0) as pieces_per_packaging,
                COALESCE(p.quantity_in_packaging_units, 0) as quantity_in_packaging_units,
                COALESCE(p.price_per_packaging, 0) as price_per_packaging,
                COALESCE(p.total_pieces, 0) as total_pieces,
                COALESCE(p.unit_price_per_piece, 0) as unit_price_per_piece,
                p.is_active,
                p.createdAt,
                p.updatedAt,
                bi.stock as branch_stock,
                bi.expiryDate as branch_expiryDate
            FROM products p
            LEFT JOIN category c ON p.category = c.category_id
            LEFT JOIN branch_inventory bi ON p.id = bi.product_id AND bi.branch_id = ? AND bi.is_active = TRUE
            WHERE p.barcode = ? AND p.is_active = TRUE
        `,
      [branch_id, branch_id, medicineName]
    );

    if (product.length === 0) {
      return res.status(404).json({ message: "Medicine not found" });
    }

    // Get branch information
    const [branch] = await db.query(
      `
            SELECT branch_id, branch_name
            FROM branches
            WHERE branch_id = ? AND is_active = TRUE
        `,
      [branch_id]
    );

    if (branch.length === 0) {
      return res.status(404).json({ message: "Branch not found" });
    }

    // Format the response
    const response = {
      medicineInfo: {
        ...product[0],
        price: `₱${parseFloat(product[0].price).toFixed(2)}`,
        total_stock: product[0].branch_stock || 0,
        earliest_expiry: product[0].branch_expiryDate,
      },
      branchInventory: [
        {
          branch_id: branch[0].branch_id,
          branch_name: branch[0].branch_name,
          stock: product[0].branch_stock || 0,
          expiryDate: product[0].branch_expiryDate || null,
          createdAt: product[0].createdAt,
          updatedAt: product[0].updatedAt,
        },
      ],
    };

    res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching medicine details by branch:", error);
    res
      .status(500)
      .json({ message: "Failed to fetch medicine details", error });
  }
};

exports.getExpiredProducts = async (req, res) => {
  try {
    console.log("Getting expired and near-expiry products");

    // Get products that have expired or are near expiry across all branches
    const [products] = await db.query(`
            SELECT 
                p.barcode,
                p.name,
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
            JOIN products p 
                ON bi.product_id = p.id
            JOIN category c 
                ON p.category = c.category_id
            JOIN branches b 
                ON bi.branch_id = b.branch_id
            WHERE bi.is_active = TRUE
            AND bi.expiryDate IS NOT NULL
            AND bi.expiryDate != '0000-00-00'
            AND (
                bi.expiryDate <= CURDATE() 
                OR DATEDIFF(bi.expiryDate, CURDATE()) <= bi.expiryThreshold
            )
            ORDER BY 
                CASE    
                    WHEN bi.expiryDate <= CURDATE() THEN 0
                    ELSE 1
                END,
                bi.expiryDate ASC;
        `);

    console.log("Found products:", products.length);
    res.json(products);
  } catch (error) {
    console.error("Error getting expired products:", error);
    res.status(500).json({ message: "Failed to get expired products", error });
  }
};

exports.getExpiredProductsByBranch = async (req, res) => {
  try {
    const { branch_id } = req.params;
    console.log(
      "Getting expired and near-expiry products for branch:",
      branch_id
    );

    // Get products that have expired or are near expiry for specific branch
    const [products] = await db.query(
      `
            SELECT 
                p.barcode,
                p.name,
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
            JOIN products p 
                ON bi.product_id = p.id
            JOIN category c 
                ON p.category = c.category_id
            JOIN branches b 
                ON bi.branch_id = b.branch_id
            WHERE bi.branch_id = ?
                AND bi.is_active = TRUE
                AND bi.expiryDate IS NOT NULL
                AND bi.expiryDate != '0000-00-00'
                AND (
                    bi.expiryDate <= CURDATE() 
                    OR DATEDIFF(bi.expiryDate, CURDATE()) <= bi.expiryThreshold
                )
            ORDER BY 
                CASE 
                    WHEN bi.expiryDate <= CURDATE() THEN 0
                    ELSE 1
                END,
                bi.expiryDate ASC;
        `,
      [branch_id]
    );

    console.log("Found products:", products.length);
    res.json(products);
  } catch (error) {
    console.error("Error getting expired products by branch:", error);
    res.status(500).json({ message: "Failed to get expired products", error });
  }
};

exports.deleteExpiredProducts = async (req, res) => {
  try {
    const { barcodes } = req.body;
    if (!Array.isArray(barcodes) || barcodes.length === 0) {
      return res.status(400).json({ message: "No barcodes provided" });
    }
    // Delete from branch_inventory where barcode matches and expired
    const [result] = await db.query(
      `
            UPDATE branch_inventory 
            SET is_active = 0 
            WHERE product_id IN (
                SELECT * FROM (
                    SELECT id FROM products WHERE barcode IN (?)
                ) AS temp_ids
            )
        `,
      [barcodes]
    );
    res.json({
      message: "Expired products deleted successfully",
      deletedCount: result.affectedRows,
    });
  } catch (error) {
    console.error("Error deleting expired products:", error);
    res.status(500).json({
      message: "Error deleting expired products",
      error: error.message,
    });
  }
};

// Get archived expired products
exports.getArchivedExpiredProducts = async (req, res) => {
  try {
    console.log("Getting archived expired products");

    // Get products that have expired across all branches
    const [products] = await db.query(`
            SELECT 
                p.barcode,
                p.name,
                bi.batch_id,
                p.brand_name,
                c.name AS category_name,
                b.branch_name,
                DATE_FORMAT(bi.expiryDate, '%Y-%m-%d') AS expiryDate
            FROM branch_inventory bi
            JOIN products p 
                ON bi.product_id = p.id
            JOIN category c 
                ON p.category = c.category_id
            JOIN branches b 
                ON bi.branch_id = b.branch_id
            WHERE 
                bi.is_active = FALSE
                AND bi.expiryDate < CURDATE()
            ORDER BY 
                bi.expiryDate ASC;
        `);

    console.log(`Found ${products.length} expired products`);

    // No need to format dates since they're already formatted by MySQL
    res.json(products);
  } catch (error) {
    console.error("Error getting expired products:", error);
    res.status(500).json({
      message: "Error getting expired products",
      error: error.message,
    });
  }
};

exports.getArchivedExpiredProductsByBranch = async (req, res) => {
  try {
    const { branch_id } = req.params;
    if (!branch_id) {
      return res.status(400).json({ message: "Branch ID is required" });
    }

    console.log("Getting archived expired products");

    // Get products that have expired across all branches
    const [products] = await db.query(
      `
            SELECT 
                p.barcode,
                p.name,
                bi.batch_id,
                p.brand_name,
                c.name AS category_name,
                b.branch_name,
                DATE_FORMAT(bi.expiryDate, '%Y-%m-%d') AS expiryDate
            FROM branch_inventory bi
            JOIN products p 
                ON bi.product_id = p.id
            JOIN category c 
                ON p.category = c.category_id
            JOIN branches b 
                ON bi.branch_id = b.branch_id
            WHERE 
                bi.is_active = FALSE
                AND bi.expiryDate < CURDATE()
                AND bi.branch_id = ?
            ORDER BY 
                bi.expiryDate ASC;
        `,
      [branch_id]
    );

    console.log(`Found ${products.length} expired products`);

    // No need to format dates since they're already formatted by MySQL
    res.json(products);
  } catch (error) {
    console.error("Error getting archived expired products by branch:", error);
    res.status(500).json({
      message: "Error getting archived expired products by branch",
      error: error.message,
    });
  }
};

// Fetch all products that are critical or near shortage
exports.getShortageProducts = async (req, res) => {
  try {
    // Get products with stock below or near critical level in any branch
    const [products] = await db.query(`
            SELECT DISTINCT
                p.id,
                p.name,
                p.brand_name,
                p.barcode,
                p.category,
                c.name AS category_name,
                p.critical,
                p.price,
                p.createdAt,
                p.updatedAt
            FROM 
                products p
            JOIN 
                branch_inventory bi ON p.id = bi.product_id
            LEFT JOIN 
                category c ON p.category = c.category_id
            WHERE 
                p.is_active = TRUE 
                AND bi.is_active = TRUE
                AND bi.stock <= (p.critical + 20);
        `);

    // Get branch inventory for each product
    const productsWithInventory = await Promise.all(products.map(async (product) => {
      const [branchInventory] = await db.query(`
                SELECT 
                    bi.branch_id,
                    bi.stock,
                    bi.expiryDate,
                    b.branch_name
                FROM branch_inventory bi
                JOIN branches b ON bi.branch_id = b.branch_id
                WHERE bi.product_id = ? AND bi.is_active = TRUE
            `, [product.id]);

      return {
        ...product,
        branch_inventory: branchInventory
      };
    }));

    res.json(productsWithInventory);
  } catch (error) {
    console.error('Error getting shortage products:', error);
    res.status(500).json({ message: 'Error getting shortage products' });
  }
};

exports.getShortageProductsByBranch = async (req, res) => {
  try {
    const { branchId } = req.query;
    const timeZoneUtil = require('../utils/timeZoneUtil');

    if (!branchId) {
      return res.status(400).json({ message: 'Branch ID is required' });
    }

    // Get products with stock below or near critical level for the specific branch
    const [products] = await db.query(`
            SELECT DISTINCT
                p.id,
                p.name,
                p.brand_name,
                p.barcode,
                p.category,
                c.name AS category_name,
                p.critical,
                p.price,
                p.createdAt,
                p.updatedAt,
                ${timeZoneUtil.getConvertTZString('p.createdAt')} AS created_at,
                ${timeZoneUtil.getConvertTZString('p.updatedAt')} AS updated_at
            FROM 
                products p
            JOIN 
                branch_inventory bi ON p.id = bi.product_id
            LEFT JOIN 
                category c ON p.category = c.category_id
            WHERE 
                p.is_active = TRUE 
                AND bi.is_active = TRUE
                AND bi.branch_id = ?
                AND bi.stock <= (p.critical + 20);
        `, [branchId]);

    // Get branch inventory for each product (only for the specified branch)
    const productsWithInventory = await Promise.all(products.map(async (product) => {
      const [branchInventory] = await db.query(`
                SELECT 
                    bi.branch_id,
                    bi.stock,
                    bi.expiryDate,
                    b.branch_name
                FROM branch_inventory bi
                JOIN branches b ON bi.branch_id = b.branch_id
                WHERE bi.product_id = ? 
                AND bi.branch_id = ?
                AND bi.is_active = TRUE
            `, [product.id, branchId]);

      return {
        ...product,
        branch_inventory: branchInventory
      };
    }));

    res.json(productsWithInventory);
  } catch (error) {
    console.error('Error getting shortage products by branch:', error);
    res.status(500).json({ message: 'Error getting shortage products by branch' });
  }
};

/** 
 
*/

exports.getCompetitivePriceChecker = async (req, res) => {
  // --- THIS IS THE ONLY LINE THAT CHANGES ---
  // We now get the search term from `req.params` instead of `req.query`
  const searchTerm = req.params.searchTerm;
  // ------------------------------------------

  // Validate the input (this logic remains the same)
  if (!searchTerm || typeof searchTerm !== 'string' || searchTerm.trim() === '') {
    return res.status(400).json({
      status: 'error',
      message: 'Search term is required in the URL and must be a string.'
    });
  }

  try {
    // Prepare the SQL query (this logic remains the same)
    const searchWords = searchTerm.trim().split(/\s+/);
    const likeClauses = searchWords.map(() => 'product_title LIKE ?').join(' AND ');
    const queryArgs = searchWords.map(word => `%${word}%`);

    const sql = `
            SELECT price
            FROM price_checker_entries
            WHERE ${likeClauses}
            AND scraped_at > NOW() - INTERVAL 30 DAY
            LIMIT 50;
        `;

    // Execute the query
    const [rows] = await db.query(sql, queryArgs);

    // Handle the case where no results are found
    if (rows.length === 0) {
      return res.status(200).json({
        status: 'success',
        message: 'No competitor data found for this product.',
        data: { count: 0 }
      });
    }

    // Perform the analysis
    const prices = rows.map(row => parseFloat(row.price));
    const count = prices.length;
    const sum = prices.reduce((a, b) => a + b, 0);
    const avgPrice = sum / count;
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);

    // Send the successful response
    res.status(200).json({
      status: 'success',
      data: {
        count,
        avgPrice: parseFloat(avgPrice.toFixed(2)),
        minPrice,
        maxPrice
      }
    });

  } catch (error) {
    console.error('Error in getCompetitivePriceChecker:', error);
    res.status(500).json({ status: 'error', message: 'Internal Server Error' });
  }
};

// Generate a unique barcode for a category
exports.generateUniqueBarcode = async (req, res) => {
  try {
    const { category } = req.query;
    if (!category) {
      return res.status(400).json({ success: false, message: "Category is required" });
    }
    // Get the prefix for the category
    const [catResult] = await db.query("SELECT prefix FROM category WHERE name = ?", [category]);
    if (!catResult || catResult.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid category" });
    }
    const prefix = catResult[0].prefix;
    // Try generating a unique barcode
    let unique = false;
    let barcode = "";
    let attempts = 0;
    while (!unique && attempts < 20) {
      const digits = Math.floor(100000 + Math.random() * 900000);
      barcode = `RX-${prefix}-${digits}`;
      const [existing] = await db.query("SELECT id FROM products WHERE barcode = ?", [barcode]);
      if (!existing || existing.length === 0) {
        unique = true;
      }
      attempts++;
    }
    if (!unique) {
      return res.status(500).json({ success: false, message: "Failed to generate unique barcode" });
    }
    res.json({ success: true, barcode });
  } catch (error) {
    console.error("Error generating unique barcode:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Get batch and lot number options for a specific product
exports.getBatchLotOptions = async (req, res) => {
  const { productId } = req.params;

  if (!productId) {
    return res.status(400).json({ message: "Product ID is required" });
  }

  try {
    // Get existing batch numbers from batches table where batch_items contains this product
    const [batchOptions] = await db.query(`
      SELECT DISTINCT b.batch_id, b.batch_number 
      FROM batches b
      JOIN batch_items bi ON b.batch_id = bi.batch_id
      WHERE bi.product_id = ? AND b.batch_number IS NOT NULL
      ORDER BY b.batch_number ASC
    `, [productId]);

    // Get existing lot numbers from batch_items for this product
    const [lotOptions] = await db.query(`
      SELECT DISTINCT lot_number 
      FROM batch_items 
      WHERE product_id = ? AND lot_number IS NOT NULL AND lot_number != ''
      ORDER BY lot_number ASC
    `, [productId]);

    res.json({
      batches: batchOptions.map(row => ({
        batch_id: row.batch_id,
        batch_number: row.batch_number
      })),
      lotNumbers: lotOptions.map(row => row.lot_number)
    });
  } catch (error) {
    console.error("Error fetching batch/lot options:", error);
    res.status(500).json({ message: "Failed to fetch batch/lot options", error });
  }
};
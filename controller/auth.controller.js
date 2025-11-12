const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { sendPasswordResetEmail } = require('../utils/emailService');
const { getMySQLTimestamp, getCurrentTimestamp, getConvertTZString } = require('../utils/timeZoneUtil');

// PMS Login (Admin/Manager)
const pmsLogin = async (req, res) => {
    try {
        const { employee_id, password } = req.body;
        console.log('Attempting PMS login for employee_id:', employee_id);

        // Get user from database with converted timestamps
        const [users] = await db.pool.query(
            `SELECT u.*, b.branch_name,
             ${getConvertTZString('u.created_at')} as created_at,
             ${getConvertTZString('u.updated_at')} as updated_at,
             ${getConvertTZString('u.hired_at')} as hired_at,
             CASE 
                WHEN u.image_data IS NOT NULL THEN TO_BASE64(u.image_data)
                ELSE NULL 
             END as image_data,
             u.image_type
             FROM users u
             LEFT JOIN branches b ON u.branch_id = b.branch_id
             WHERE u.employee_id = ? AND u.is_active = 1`,
            [employee_id]
        );

        if (users.length === 0) {
            console.log('No user found with employee_id:', employee_id);
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const user = users[0];

        // Verify password
        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            console.log('Invalid password for employee_id:', employee_id);
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Update last login timestamp
        await db.pool.query(
            `UPDATE users 
             SET updated_at = ${getMySQLTimestamp()}
             WHERE user_id = ?`,
            [user.user_id]
        );

        // Generate JWT token
        const token = jwt.sign(
            {
                userId: user.user_id,
                role: user.role,
                employeeId: user.employee_id,
                name: user.name,
                branchId: user.branch_id,
                is_permitted: user.is_permitted
            },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        // Get current timestamp for login time
        const loginTimestamp = getCurrentTimestamp();

        console.log('Successful PMS login for employee_id:', employee_id);
        res.json({
            token,
            user: {
                name: user.name,
                role: user.role,
                employeeId: user.employee_id,
                branchId: user.branch_id,
                branch_name: user.branch_name,
                is_permitted: user.is_permitted,
                loginTime: loginTimestamp,
                created_at: user.created_at,
                updated_at: user.updated_at,
                hired_at: user.hired_at,
                user_id: user.user_id,
                email: user.email,
                phone: user.phone,
                image_data: user.image_data,
                image_type: user.image_type
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

// POS Login (Pharmacist)
const posLogin = async (req, res) => {
    try {
        const { pin_code, starting_cash, cash_notes } = req.body;
        console.log('Attempting POS login with PIN:', pin_code);

        // Get pharmacist from database with branch name FIRST (validate PIN before cash)
        const [pharmacists] = await db.pool.query(
            `SELECT p.*, b.branch_name, b.branch_code
             FROM pharmacist p 
             JOIN branches b ON p.branch_id = b.branch_id 
             WHERE p.pin_code = ? AND p.is_active = 1`,
            [pin_code]
        );

        console.log('Query result:', pharmacists);

        if (pharmacists.length === 0) {
            console.log('No pharmacist found with PIN:', pin_code);
            return res.status(401).json({ message: 'Invalid PIN code' });
        }

        // Validate required fields AFTER PIN validation
        if (!starting_cash || starting_cash < 0) {
            return res.status(400).json({
                message: 'Starting cash amount is required and must be ₱0.00 or more'
            });
        }

        const pharmacist = pharmacists[0];
        console.log('Found pharmacist:', pharmacist.name);

        // Start a database transaction
        await db.pool.query('START TRANSACTION');

        try {
            // Create sales session with explicit timestamp
            const [salesSessionResult] = await db.pool.query(
                `INSERT INTO sales_sessions (branch_id, start_time, created_at, updated_at) 
                 VALUES (?, ${getMySQLTimestamp()}, ${getMySQLTimestamp()}, ${getMySQLTimestamp()})`,
                [pharmacist.branch_id]
            );

            const sessionId = salesSessionResult.insertId;

            // Create pharmacist session with timestamp and petty cash
            const [pharmacistSessionResult] = await db.pool.query(
                `INSERT INTO pharmacist_sessions (session_id, staff_id, share_percentage, petty_cash, cash_notes, created_at) 
                 VALUES (?, ?, 100.00, ?, ?, ${getMySQLTimestamp()})`,
                [sessionId, pharmacist.staff_id, starting_cash, cash_notes || null]
            );

            // If everything is successful, commit the transaction
            await db.pool.query('COMMIT');

            // Log session start with detailed information
            console.log('POS Session Started:', {
                sessionId: sessionId,
                pharmacistId: pharmacist.staff_id,
                pharmacistName: pharmacist.name,
                branchId: pharmacist.branch_id,
                branchName: pharmacist.branch_name,
                branchCode: pharmacist.branch_code,
                startingCash: starting_cash,
                cashNotes: cash_notes,
                timestamp: new Date().toISOString()
            });

            // Get the current timestamp for the response
            const loginTimestamp = getCurrentTimestamp();

            // Generate JWT token
            const token = jwt.sign(
                {
                    staffId: pharmacist.staff_id,
                    name: pharmacist.name,
                    branchId: pharmacist.branch_id,
                    branchCode: pharmacist.branch_code,
                    salesSessionId: sessionId,
                    pharmacistSessionId: pharmacistSessionResult.insertId
                },
                process.env.JWT_SECRET,
                { expiresIn: '12h' }
            );

            console.log('Pharmacist session data:', {
                staffId: pharmacist.staff_id,
                branchId: pharmacist.branch_id,
                branchCode: pharmacist.branch_code,
                sessionId: sessionId,
                pharmacistSessionId: pharmacistSessionResult.insertId
            });

            console.log('Successful POS login for pharmacist:', pharmacist.name);
            res.json({
                token,
                pharmacist: {
                    name: pharmacist.name,
                    staffId: pharmacist.staff_id,
                    branchId: pharmacist.branch_id,
                    branchCode: pharmacist.branch_code,
                    sessionId: sessionId,
                    salesSessionId: sessionId,
                    pharmacistSessionId: pharmacistSessionResult.insertId,
                    branch_name: pharmacist.branch_name,
                    startingCash: starting_cash,
                    cashNotes: cash_notes,
                    loginTime: loginTimestamp
                }
            });
        } catch (error) {
            // If there's an error, rollback the transaction
            await db.pool.query('ROLLBACK');
            throw error;
        }
    } catch (error) {
        console.error('POS Login error:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

// Generate a random 6-digit token
const generateResetToken = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

// Store reset tokens with expiry (15 minutes)
const resetTokens = new Map();

const forgotPassword = async (req, res) => {
    const { employee_id, email } = req.body;

    try {
        // Check if user exists with given employee_id and email
        const [users] = await db.pool.query(
            'SELECT * FROM users WHERE employee_id = ? AND email = ?',
            [employee_id, email]
        );

        if (!users || users.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No user found with the provided employee ID and email'
            });
        }

        // Generate reset token
        const resetToken = generateResetToken();

        // Store token with expiry
        resetTokens.set(employee_id, {
            token: resetToken,
            expiry: Date.now() + 15 * 60 * 1000 // 15 minutes
        });

        // Send reset email
        await sendPasswordResetEmail(email, resetToken);

        res.json({
            success: true,
            message: 'Password reset instructions have been sent to your email'
        });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({
            success: false,
            message: 'Error processing password reset request'
        });
    }
};

const verifyResetToken = async (req, res) => {
    const { employee_id, token } = req.body;

    const storedReset = resetTokens.get(employee_id);
    if (!storedReset || storedReset.token !== token) {
        return res.status(400).json({
            success: false,
            message: 'Invalid or expired reset token'
        });
    }

    if (Date.now() > storedReset.expiry) {
        resetTokens.delete(employee_id);
        return res.status(400).json({
            success: false,
            message: 'Reset token has expired'
        });
    }

    res.json({
        success: true,
        message: 'Token verified successfully'
    });
};

const resetPassword = async (req, res) => {
    const { employee_id, token, new_password } = req.body;

    const storedReset = resetTokens.get(employee_id);
    if (!storedReset || storedReset.token !== token) {
        return res.status(400).json({
            success: false,
            message: 'Invalid or expired reset token'
        });
    }

    try {
        // Hash the new password
        const hashedPassword = await bcrypt.hash(new_password, 10);

        // Update password and updated_at timestamp
        await db.pool.query(
            `UPDATE users 
             SET password = ?, 
                 updated_at = ${getMySQLTimestamp()}
             WHERE employee_id = ?`,
            [hashedPassword, employee_id]
        );

        // Clear the reset token
        resetTokens.delete(employee_id);

        res.json({
            success: true,
            message: 'Password has been reset successfully'
        });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({
            success: false,
            message: 'Error resetting password'
        });
    }
};

// End pharmacist session
const endPharmacistSession = async (req, res) => {
    const connection = await db.pool.getConnection();
    try {
        const { salesSessionId, pharmacistSessionId } = req.body;

        console.log('Ending pharmacist session with data:', {
            pharmacistSessionId,
            salesSessionId,
            staffId: req.user.staffId
        });

        // Get session info first
        const [session] = await connection.query(
            'SELECT * FROM sales_sessions WHERE session_id = ?',
            [salesSessionId]
        );

        if (session.length === 0) {
            console.log('No active session found for:', salesSessionId);
            return res.status(400).json({
                success: false,
                message: 'No active session found'
            });
        }

        await connection.beginTransaction();

        // 1. Calculate total sales for the session
        const [sales] = await connection.query(
            `SELECT COALESCE(SUM(total_amount), 0) as total 
             FROM sales 
             WHERE pharmacist_session_id = ?`,
            [pharmacistSessionId]
        );

        const totalSales = sales[0].total || 0;

        // 2. Update sales session end time
        await connection.query(
            `UPDATE sales_sessions 
             SET end_time = ${getMySQLTimestamp()},
                 total_sales = ?,
                 updated_at = ${getMySQLTimestamp()}
             WHERE session_id = ?`,
            [totalSales, salesSessionId]
        );

        // 3. Update pharmacist session end time
        await connection.query(
            `UPDATE pharmacist_sessions 
             SET end_time = ${getMySQLTimestamp()}
             WHERE pharmacist_session_id = ?`,
            [pharmacistSessionId]
        );

        await connection.commit();

        console.log('Session ended successfully:', {
            pharmacistSessionId,
            salesSessionId,
            totalSales
        });

        res.json({
            success: true,
            message: 'Session ended successfully'
        });

    } catch (error) {
        await connection.rollback();
        console.error('Session end error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to end session',
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// Verify PIN for admin/manager operations
const verifyPin = async (req, res) => {
    try {
        const { pin_code, role_required } = req.body;

        if (!pin_code) {
            return res.status(400).json({
                success: false,
                message: 'PIN code is required'
            });
        }

        // Check if PIN belongs to a pharmacist (POS PIN)
        const [pharmacists] = await db.pool.query(
            `SELECT p.*, b.branch_name, b.branch_code
             FROM pharmacist p 
             JOIN branches b ON p.branch_id = b.branch_id 
             WHERE p.pin_code = ? AND p.is_active = 1`,
            [pin_code]
        );

        // Check if PIN belongs to a user (PMS - Admin/Manager)
        const [users] = await db.pool.query(
            `SELECT u.*, b.branch_name
             FROM users u
             LEFT JOIN branches b ON u.branch_id = b.branch_id
             WHERE u.employee_id = ? AND u.is_active = 1 AND u.role IN ('ADMIN', 'MANAGER')`,
            [pin_code]
        );

        let verifiedUser = null;

        // If pharmacist found, check if they have admin/manager role equivalent
        if (pharmacists.length > 0) {
            const pharmacist = pharmacists[0];
            // For this implementation, we'll assume pharmacists don't have admin privileges
            // You can modify this logic based on your business rules
            return res.status(403).json({
                success: false,
                message: 'Insufficient permissions. Admin or Manager access required.'
            });
        }

        // If user found, verify they have the required role
        if (users.length > 0) {
            const user = users[0];
            const requiredRoles = role_required || ['ADMIN', 'MANAGER'];

            if (requiredRoles.includes(user.role)) {
                verifiedUser = user;
            } else {
                return res.status(403).json({
                    success: false,
                    message: 'Insufficient permissions. Admin or Manager access required.'
                });
            }
        }

        if (!verifiedUser) {
            return res.status(401).json({
                success: false,
                message: 'Invalid PIN code'
            });
        }

        res.json({
            success: true,
            message: 'PIN verified successfully',
            user: {
                name: verifiedUser.name,
                role: verifiedUser.role,
                employeeId: verifiedUser.employee_id
            }
        });

    } catch (error) {
        console.error('PIN verification error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error during PIN verification'
        });
    }
};

module.exports = {
    pmsLogin,
    posLogin,
    forgotPassword,
    verifyResetToken,
    resetPassword,
    endPharmacistSession,
    verifyPin
}; 
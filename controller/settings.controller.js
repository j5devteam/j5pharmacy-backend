const db = require('../config/database');
const bcrypt = require('bcryptjs');
const { getMySQLTimestamp, getConvertTZString } = require('../utils/timeZoneUtil');

// Get user profile
const getProfile = async (req, res) => {
    try {
        const userId = req.user.user_id; // Get from auth token

        const [users] = await db.pool.query(
            `SELECT 
                u.user_id,
                u.employee_id,
                u.name,
                u.role,
                u.email,
                u.phone,
                u.branch_id,
                u.remarks,
                u.is_active,
                u.is_permitted,
                b.branch_name,
                CASE 
                    WHEN u.image_data IS NOT NULL 
                    THEN TO_BASE64(u.image_data)
                    ELSE NULL 
                END as image_data,
                u.image_type,
                ${getConvertTZString('u.created_at')} as created_at,
                ${getConvertTZString('u.updated_at')} as updated_at,
                ${getConvertTZString('u.hired_at')} as hired_at
            FROM users u
            LEFT JOIN branches b ON u.branch_id = b.branch_id
            WHERE u.user_id = ?`,
            [userId]
        );

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.json({
            success: true,
            user: users[0]
        });
    } catch (error) {
        console.error('Error fetching user profile:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching user profile'
        });
    }
};

// Update profile
const updateProfile = async (req, res) => {
    console.log('Updating profile with data:', req.body);
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        const userId = req.user.user_id; // Get from auth token
        console.log('User ID from token:', userId);
        console.log('Full user object from token:', req.user);

        if (!userId) {
            throw new Error('User ID not found in token');
        }

        const {
            name,
            email,
            phone,
            remarks,
            current_password,
            new_password
        } = req.body;

        // Start building the update query
        let updateFields = [];
        let updateValues = [];

        // Add basic fields
        if (name) {
            updateFields.push('name = ?');
            updateValues.push(name.trim());
        }
        if (email) {
            updateFields.push('email = ?');
            updateValues.push(email.trim());
        }
        if (phone) {
            updateFields.push('phone = ?');
            updateValues.push(phone.trim());
        }
        if (remarks !== undefined) {
            updateFields.push('remarks = ?');
            updateValues.push(remarks.trim());
        }

        // Handle password change if provided
        if (current_password && new_password) {
            console.log('Password change requested');
            // Verify current password
            const [users] = await connection.query(
                'SELECT password FROM users WHERE user_id = ?',
                [userId]
            );

            if (users.length === 0) {
                throw new Error('User not found');
            }

            const isValidPassword = await bcrypt.compare(current_password, users[0].password);
            if (!isValidPassword) {
                throw new Error('Current password is incorrect');
            }

            // Hash new password
            const hashedPassword = await bcrypt.hash(new_password, 10);
            updateFields.push('password = ?');
            updateValues.push(hashedPassword);
        }

        // Handle image upload if provided
        if (req.file) {
            updateFields.push('image_data = ?');
            updateValues.push(req.file.buffer);
            updateFields.push('image_type = ?');
            updateValues.push(req.file.mimetype);
        }

        // Add updated_at timestamp
        updateFields.push(`updated_at = ${getMySQLTimestamp()}`);

        // If there are fields to update
        if (updateFields.length > 0) {
            const query = `
                UPDATE users 
                SET ${updateFields.join(', ')}
                WHERE user_id = ?
            `;
            updateValues.push(userId);

            console.log('Executing update query:', query);
            console.log('Update values:', updateValues);

            const [updateResult] = await connection.query(query, updateValues);
            console.log('Update result:', updateResult);

            if (updateResult.affectedRows === 0) {
                throw new Error('No user found with ID: ' + userId);
            }
        }

        // Get updated user data
        const selectQuery = `
            SELECT 
                u.user_id, 
                u.employee_id, 
                u.name, 
                u.role, 
                u.email, 
                u.phone,
                u.branch_id, 
                u.remarks, 
                u.is_active, 
                u.is_permitted,
                b.branch_name,
                CASE WHEN u.image_data IS NOT NULL 
                    THEN TO_BASE64(u.image_data)
                    ELSE NULL 
                END as image_data,
                u.image_type,
                ${getConvertTZString('u.created_at')} as created_at,
                ${getConvertTZString('u.updated_at')} as updated_at,
                ${getConvertTZString('u.hired_at')} as hired_at
            FROM users u
            LEFT JOIN branches b ON u.branch_id = b.branch_id
            WHERE u.user_id = ?`;

        console.log('Executing select query:', selectQuery);
        console.log('Select values:', [userId]);

        const [updatedUser] = await connection.query(selectQuery, [userId]);
        console.log('Select result:', updatedUser);

        if (!updatedUser[0]) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: 'Failed to retrieve updated user data'
            });
        }

        await connection.commit();
        console.log('User updated successfully:', updatedUser[0]);

        res.json({
            success: true,
            message: 'Profile updated successfully',
            user: updatedUser[0]
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error updating profile:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error updating profile'
        });
    } finally {
        connection.release();
    }
};

// Update password
const updatePassword = async (req, res) => {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        const userId = req.user.user_id; // Get from auth token
        const { current_password, new_password } = req.body;

        // Verify current password
        const [users] = await connection.query(
            'SELECT password FROM users WHERE user_id = ?',
            [userId]
        );

        if (users.length === 0) {
            throw new Error('User not found');
        }

        const isValidPassword = await bcrypt.compare(current_password, users[0].password);
        if (!isValidPassword) {
            return res.status(400).json({
                success: false,
                message: 'Current password is incorrect'
            });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(new_password, 10);

        // Update password
        await connection.query(
            `UPDATE users 
             SET password = ?,
                 updated_at = ${getMySQLTimestamp()}
             WHERE user_id = ?`,
            [hashedPassword, userId]
        );

        await connection.commit();

        res.json({
            success: true,
            message: 'Password updated successfully'
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error updating password:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error updating password'
        });
    } finally {
        connection.release();
    }
};

// Update profile picture
const updateProfilePicture = async (req, res) => {
    console.log('Updating profile picture...');
    console.log('Full req.user object:', req.user);
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        const userId = req.user.user_id; // Get from auth token
        console.log('User ID from token:', userId);

        if (!userId) {
            throw new Error('User ID not found in token');
        }

        if (!req.file) {
            throw new Error('No image file provided');
        }

        console.log('File details:', {
            size: req.file.size,
            mimetype: req.file.mimetype,
            originalName: req.file.originalname
        });

        // First, verify the user exists
        const [existingUser] = await connection.query(
            'SELECT user_id FROM users WHERE user_id = ?',
            [userId]
        );

        if (existingUser.length === 0) {
            throw new Error('User not found');
        }

        console.log('User found, proceeding with update...');

        // Update the profile picture
        const updateResult = await connection.query(
            `UPDATE users 
             SET image_data = ?,
                 image_type = ?,
                 updated_at = ${getMySQLTimestamp()}
             WHERE user_id = ?`,
            [req.file.buffer, req.file.mimetype, userId]
        );

        console.log('Update result:', updateResult);

        if (updateResult[0].affectedRows === 0) {
            throw new Error('No rows were updated');
        }

        // Get updated user data with simpler query first
        const simpleSelectQuery = `
            SELECT 
                u.user_id, 
                u.employee_id, 
                u.name, 
                u.role, 
                u.email, 
                u.phone,
                u.branch_id, 
                u.remarks, 
                u.is_active, 
                u.is_permitted,
                b.branch_name,
                u.image_type,
                u.created_at,
                u.updated_at,
                u.hired_at
            FROM users u
            LEFT JOIN branches b ON u.branch_id = b.branch_id
            WHERE u.user_id = ?`;

        console.log('Executing simple select query...');
        const [updatedUser] = await connection.query(simpleSelectQuery, [userId]);
        console.log('Simple select result:', updatedUser);

        if (!updatedUser[0]) {
            throw new Error('Failed to retrieve updated user data');
        }

        // Now get the base64 image data separately
        const imageQuery = `
            SELECT 
                CASE WHEN image_data IS NOT NULL 
                    THEN TO_BASE64(image_data)
                    ELSE NULL 
                END as image_data
            FROM users 
            WHERE user_id = ?`;

        console.log('Executing image query...');
        console.log('Image query:', imageQuery);
        console.log('User ID for image query:', userId);
        
        let imageResult;
        try {
            [imageResult] = await connection.query(imageQuery, [userId]);
            console.log('Image query result:', imageResult);
        } catch (imageError) {
            console.error('Error in image query:', imageError);
            throw new Error(`Failed to retrieve image data: ${imageError.message}`);
        }

        // Combine the results
        const finalUserData = {
            ...updatedUser[0],
            image_data: imageResult[0]?.image_data || null
        };

        await connection.commit();
        console.log('Profile picture updated successfully');

        res.json({
            success: true,
            message: 'Profile picture updated successfully',
            user: finalUserData,
            image_data: finalUserData.image_data,
            image_type: finalUserData.image_type
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error updating profile picture:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error updating profile picture'
        });
    } finally {
        connection.release();
    }
};

// Remove profile picture
const removeProfilePicture = async (req, res) => {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        const userId = req.user.user_id; // Get from auth token

        await connection.query(
            `UPDATE users 
             SET image_data = NULL,
                 image_type = NULL,
                 updated_at = ${getMySQLTimestamp()}
             WHERE user_id = ?`,
            [userId]
        );

        await connection.commit();

        res.json({
            success: true,
            message: 'Profile picture removed successfully'
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error removing profile picture:', error);
        res.status(500).json({
            success: false,
            message: 'Error removing profile picture'
        });
    } finally {
        connection.release();
    }
};

// Test endpoint for debugging
const testDatabase = async (req, res) => {
    const connection = await db.pool.getConnection();
    try {
        console.log('Testing database connection...');
        
        // Test basic connection
        const [testResult] = await connection.query('SELECT 1 as test');
        console.log('Basic connection test:', testResult);
        
        // Test TO_BASE64 function
        const [base64Test] = await connection.query('SELECT TO_BASE64("test") as base64_test');
        console.log('TO_BASE64 test:', base64Test);
        
        // Test user query
        const userId = req.user.user_id;
        const [userTest] = await connection.query('SELECT user_id, name FROM users WHERE user_id = ?', [userId]);
        console.log('User test:', userTest);
        
        res.json({
            success: true,
            message: 'Database test completed',
            tests: {
                connection: testResult[0],
                base64: base64Test[0],
                user: userTest[0]
            }
        });
    } catch (error) {
        console.error('Database test error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    } finally {
        connection.release();
    }
};

module.exports = {
    getProfile,
    updateProfile,
    updatePassword,
    updateProfilePicture,
    removeProfilePicture,
    testDatabase
}; 
const db = require('../config/database');
const { getMySQLTimezoneOffset } = require('../utils/timeZoneUtil');

const logsController = {
    saveLogs: async (req, res) => {
        try {
            const { userId, name, role, branchId, action, description } = req.body;

            if (!userId || !name || !role || !branchId || !action || !description) {
                return res.status(400).json({ message: 'Missing required fields' });
            }

            const query = `
                INSERT INTO logs (employee_id, name,role,branch_id, action, description, timestamp)
                VALUES (?, ?, ?, ?,?, ?, CONVERT_TZ(NOW(), '+00:00', ?))
            `;

            // Get timezone offset
            const currentTimestamp = getMySQLTimezoneOffset();

            await db.pool.query(query, [userId, name, role, branchId, action, description, currentTimestamp]);

            console.log('Log saved with timestamp using timezone offset:', currentTimestamp);

            return res.status(201).json({ message: 'Log created successfully' });
        } catch (error) {
            console.error('Error creating log:', error);
            return res.status(500).json({
                message: 'Internal server error',
                error: error.message
            });
        }
    },

    getLogs: async (req, res) => {
        const { userId, role } = req.body;

        try {
            const query = `
            SELECT 
                l.id, 
                l.employee_id, 
                l.name, 
                l.role,
                l.branch_id,
                b.branch_code,
                b.branch_name,
                l.action, 
                l.description, 
                l.timestamp
            FROM logs l
            LEFT JOIN branches b ON l.branch_id = b.branch_id
            ORDER BY l.timestamp DESC
        `;

            const [rows] = await db.pool.query(query);

            return res.status(200).json(rows);
        } catch (error) {
            console.error('Error fetching logs:', error);
            return res.status(500).json({
                message: 'Internal server error',
                error: error.message
            });
        }
    },
};

module.exports = logsController;
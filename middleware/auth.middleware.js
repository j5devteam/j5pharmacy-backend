const jwt = require('jsonwebtoken');

// Verify JWT token
const verifyToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        console.log('Decoded token:', decoded);

        req.user = {
            ...decoded,
            // Map userId to user_id for consistency
            user_id: decoded.userId || decoded.user_id,
            sessionId: decoded.sessionId,
            salesSessionId: decoded.salesSessionId,
            pharmacistSessionId: decoded.pharmacistSessionId,
            staffId: decoded.staffId
        };

        console.log('Set req.user:', req.user);
        next();
    } catch (error) {
        console.error('Token verification error:', error);
        return res.status(401).json({ message: 'Invalid token' });
    }
};

// Check if user is Admin
const isAdmin = (req, res, next) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ message: 'Requires admin privileges' });
    }
    next();
};

// Check if user is Manager
const isManager = (req, res, next) => {
    if (req.user.role !== 'MANAGER') {
        return res.status(403).json({ message: 'Requires manager privileges' });
    }
    next();
};

// Check if user is Admin or Manager and add branchId to query
const isPMSUser = (req, res, next) => {
    console.log('[isPMSUser] Called for:', req.originalUrl);
    if (!['ADMIN', 'MANAGER'].includes(req.user.role)) {
        return res.status(403).json({ message: 'Requires PMS access privileges' });
    }

    // Automatically add branchId to query parameters from the decoded token
    if (req.user.branchId) {
        req.query.branchId = req.user.branchId;
    }

    next();
};

// Check if user is Pharmacist
const isPharmacist = (req, res, next) => {
    console.log('[isPharmacist] Called for:', req.originalUrl);
    if (!req.user.staffId) {
        return res.status(403).json({ message: 'Requires pharmacist privileges' });
    }
    next();
};

module.exports = {
    verifyToken,
    isAdmin,
    isManager,
    isPMSUser,
    isPharmacist
}; 
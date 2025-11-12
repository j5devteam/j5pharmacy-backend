const express = require('express');
const router = express.Router();
const settingsController = require('../controller/settings.controller');
const { verifyToken } = require('../middleware/auth.middleware');
const multer = require('multer');

// Configure multer for memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: function (req, file, cb) {
        console.log('Processing file:', file.originalname, 'MIME type:', file.mimetype);
        if (!file.originalname.match(/\.(jpg|jpeg|png)$/)) {
            return cb(new Error('Only image files are allowed!'));
        }
        cb(null, true);
    }
});

// Error handling middleware for multer
const handleMulterError = (error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'File size too large. Maximum size is 5MB.'
            });
        }
    } else if (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
    next();
};

// Apply authentication middleware to all routes
router.use(verifyToken);

// Settings routes
router.get('/profile', settingsController.getProfile);
router.put('/profile', settingsController.updateProfile);
router.put('/password', settingsController.updatePassword);
router.put('/profile-picture', upload.single('image'), handleMulterError, settingsController.updateProfilePicture);
router.delete('/profile-picture', settingsController.removeProfilePicture);

// Debug route (remove in production)
router.get('/test-db', settingsController.testDatabase);

module.exports = router; 
const express = require('express');
const router = express.Router();
const logsController = require('../controller/logs.controller');
const { verifyToken } = require('../middleware/auth.middleware');
// Logs routes

router.post('/save-logs', verifyToken, logsController.saveLogs);

router.get('/get-logs', verifyToken, logsController.getLogs);

module.exports = router;
const express = require('express');
const router = express.Router();
const profileController = require('../controllers/profile.controller');
const { userAuth } = require('../middleware/auth.middleware');

// All routes here are protected
router.use(userAuth);

router.get('/', profileController.getUser);
router.put('/', profileController.updateUser);

module.exports = router;

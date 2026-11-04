const express = require("express");
const paymentController = require("../controllers/payment.controller");
const isAuth = require("../middleware/auth.middleware").userAuth;
const router = express.Router();

// Landlord + AI operations

router.post("/charge", isAuth, paymentController.postCharge);
 
router.get("/", isAuth, paymentController.getAllPayments); 

router.get("/:id", isAuth, paymentController.getPayment); 

module.exports = router;
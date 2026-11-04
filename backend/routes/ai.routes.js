const express = require("express");
const router = express.Router();
const isAuth = require("../middleware/auth.middleware").userAuth;
const aiController = require("../controllers/ai.controller");

router.get("/meta", aiController.getMeta);
const triageLimiter = require('express-rate-limit')({windowMs:60*60*1000,limit:()=>Number.parseInt(process.env.TRIAGE_HOURLY_LIMIT,10)||200,
  keyGenerator:req=>`triage:${req.user.id}`,standardHeaders:true,legacyHeaders:false,
  message:{success:false,code:'rate_limited',message:'Please wait before continuing intake. You can still contact your property manager directly.'}});
router.post("/triage", isAuth, triageLimiter, aiController.postTriage);
router.post("/detect-fault", isAuth, aiController.postDetectFault);

module.exports = router;

const express = require("express");
const multer = require("multer");
const router = express.Router();
const { userAuth } = require("../middleware/auth.middleware");
const uploadController = require("../controllers/upload.controller");

// In-memory storage — buffers are streamed straight to Cloudinary and discarded.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadController.MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) {
      return cb(null, true);
    }
    return cb(new Error("Only image and video files are allowed"));
  },
});

// Surface multer errors (size/type) as clean 400s instead of a 500.
const handleUpload = (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "File is too large (max 25MB)"
          : err.message || "Upload failed";
      return res.status(400).json({ success: false, message });
    }
    next();
  });
};

router.post("/evidence", userAuth, handleUpload, uploadController.uploadEvidence);

module.exports = router;

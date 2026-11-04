const cloudinary = require("../services/upload/cloudinary.service");

const MAX_BYTES = 25 * 1024 * 1024; // 25MB

// Uploads a single evidence asset (photo or short video) captured during intake
// and returns its hosted URL + metadata. The buffer never touches the database —
// only the resulting metadata is persisted onto the request/incident record.
exports.uploadEvidence = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file provided" });
    }
    if (!cloudinary.isConfigured()) {
      return res.status(503).json({
        success: false,
        message: "File uploads are not available right now.",
      });
    }

    const isVideo = req.file.mimetype.startsWith("video/");
    const asset = await cloudinary.uploadBuffer(req.file.buffer, {
      folder: `ronarai/evidence/${req.user.id}`,
      resourceType: isVideo ? "video" : "image",
      filename: req.file.originalname,
    });

    const label = typeof req.body.label === "string" ? req.body.label.trim() : "";
    return res.status(201).json({
      success: true,
      data: { ...asset, label: label || null },
      message: "Evidence uploaded",
    });
  } catch (err) {
    console.error("[uploadEvidence] error", err?.message || err);
    return res.status(500).json({ success: false, message: "Failed to upload evidence" });
  }
};

exports.MAX_BYTES = MAX_BYTES;

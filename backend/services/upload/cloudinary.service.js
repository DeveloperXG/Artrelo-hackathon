// Cloudinary upload helper. Streams an in-memory buffer (from multer) to
// Cloudinary and returns normalized asset metadata. Configuration comes from
// env (CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET). When credentials are not
// configured, isConfigured() is false and callers should surface a clear error
// rather than attempting an upload.

const { v2: cloudinary } = require("cloudinary");
const env = require("../../config/env");

let configured = false;

function configure() {
  if (configured) return true;
  if (!env.cloudinary_cloud_name || !env.cloudinary_api_key || !env.cloudinary_api_secret) {
    return false;
  }
  cloudinary.config({
    cloud_name: env.cloudinary_cloud_name,
    api_key: env.cloudinary_api_key,
    api_secret: env.cloudinary_api_secret,
    secure: true,
  });
  configured = true;
  return true;
}

function isConfigured() {
  return configure();
}

// Cloudinary returns EXIF as "YYYY:MM:DD HH:MM:SS", which Date() will not parse.
// Only the date half uses colons as separators.
function parseExifDate(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const parsed = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeAsset(result = {}) {
  const meta = result.image_metadata || {};
  return {
    url: result.secure_url || result.url || "",
    publicId: result.public_id || "",
    type: result.resource_type === "video" ? "video" : "image",
    format: result.format || "",
    bytes: Number(result.bytes) || 0,
    width: Number(result.width) || 0,
    height: Number(result.height) || 0,
    // When the capture time is far from the upload time the photo is very
    // likely recycled. Requested only where it matters (completion proof), and
    // read here rather than trusted from the client — a client-supplied
    // "taken at" would be worthless as evidence.
    exifTakenAt: parseExifDate(meta.DateTimeOriginal || meta.DateTime),
  };
}

// Uploads a single buffer. `folder` namespaces assets in Cloudinary.
// `resourceType` is "image", "video", or "auto".
function uploadBuffer(
  buffer,
  { folder = "ronarai/evidence", resourceType = "auto", filename, imageMetadata = false } = {}
) {
  if (!configure()) {
    return Promise.reject(new Error("Cloudinary is not configured"));
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        // Opt-in: only the completion-proof path needs EXIF back, and asking
        // for it everywhere would grow every upload response for no reason.
        ...(imageMetadata ? { image_metadata: true } : {}),
        ...(filename ? { public_id: undefined, filename_override: filename } : {}),
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(normalizeAsset(result));
      }
    );
    stream.end(buffer);
  });
}

module.exports = {
  isConfigured,
  uploadBuffer,
  normalizeAsset,
};

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const aiCategorySchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true, // Ensure no duplicate categories
    },
    description: {
      type: String,
      trim: true,
    },
    keywords: [
      {
        type: String,
        trim: true,
      },
    ], // Optional keywords for AI/NLP mapping
    parentCategory: {
      type: Schema.Types.ObjectId,
      ref: "AICategory",
      default: null,
    }, // Allows hierarchical categories
    confidenceThreshold: {
      type: Number,
      default: 0.7, // AI confidence level to accept classification
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User", // Optional: Who created/defined this category
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AICategory", aiCategorySchema);

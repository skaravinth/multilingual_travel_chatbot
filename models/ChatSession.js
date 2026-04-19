const mongoose = require("mongoose");

const chatSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    title: {
      type: String,
      default: "Travel Chat",
    },
    language: {
      type: String,
      default: "en",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ChatSession", chatSessionSchema);
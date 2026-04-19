const mongoose = require("mongoose");

const chatMessageSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatSession",
      required: true,
    },
    sender: {
      type: String,
      enum: ["user", "bot"],
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    detectedLanguage: {
      type: String,
      default: "en",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ChatMessage", chatMessageSchema);
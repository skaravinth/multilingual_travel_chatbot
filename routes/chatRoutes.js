const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");

const {
  createSession,
  sendMessage,      // ✅ use AI integrated function
  getChatHistory,
  getUserSessions,
  deleteChatHistory
} = require("../Controllers/chatController"); // ⚠ make sure folder name case matches

// Create new chat session
router.post("/session", auth, createSession);

// Send message to AI (saves user + bot reply)
router.post("/message", auth, sendMessage);

// Get chat history for a session
router.get("/history/:sessionId", auth, getChatHistory);

// Get all sessions for logged-in user
router.get("/sessions", auth, getUserSessions);

// Delete chat history for a session
router.delete("/history/:sessionId", auth, deleteChatHistory);
module.exports = router;
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const {
  getProfile,
  updateLanguage,
} = require("../Controllers/userController");

router.get("/profile", auth, getProfile);
router.put("/language", auth, updateLanguage);

module.exports = router;
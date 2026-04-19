const User = require("../models/User");

const getAuthenticatedUserId = (req) => req.user?.id || req.user?.userId || null;

exports.getProfile = async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await User.findById(userId).select("-password");
    if (!user)
      return res.status(404).json({ message: "User not found" });

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateLanguage = async (req, res) => {
  try {
    const { preferredLanguage } = req.body;
    const userId = getAuthenticatedUserId(req);

    if (!preferredLanguage) {
      return res.status(400).json({ message: "Preferred language is required" });
    }

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { preferredLanguage },
      { new: true }
    ).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ message: "Language updated", user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

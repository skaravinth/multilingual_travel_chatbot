const User = require("../models/User");

exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("-password");
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

    if (!preferredLanguage) {
      return res.status(400).json({ message: "Preferred language is required" });
    }

    const user = await User.findByIdAndUpdate(
      req.user.userId,
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
const ChatSession = require("../models/ChatSession");
const ChatMessage = require("../models/ChatMessage");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const axios = require("axios");
/* =========================
   CREATE SESSION
========================= */
exports.createSession = async (req, res) => {
  try {
    const { title, language } = req.body;

    const session = await ChatSession.create({
      userId: req.user.id || "69a5a3974ffe0edb1a717a44",
      title: title || "Travel Chat",
      language: language || "en",
    });

    res.status(201).json(session);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/* =========================
   SEND MESSAGE (AI Integrated)
========================= */


exports.sendMessage = async (req, res) => {
  try {
    const { sessionId, message, language, latitude, longitude } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({
        message: "SessionId and message are required",
      });
    }

    const languageMap = {
      en: "English",
      es: "Spanish",
      fr: "French",
      hi: "Hindi",
      ar: "Arabic",
      de: "German",
      zh: "Chinese",
      ja: "Japanese",
    };

    const selectedLanguage =
      languageMap[language] || language || "English";

    // =============================
    // 1️⃣ Save User Message
    // =============================
    await ChatMessage.create({
      sessionId,
      sender: "user",
      message,
    });

    // =============================
    // 2️⃣ Get Previous Messages
    // =============================
    const previousMessages = await ChatMessage.find({ sessionId })
      .sort({ createdAt: 1 })
      .limit(20);

    const chatMessages = previousMessages.map((msg) => ({
      role: msg.sender === "user" ? "user" : "assistant",
      content: msg.message,
    }));

    // =============================
    // 3️⃣ Location Context
    // =============================
    let locationContext = "";

    if (latitude && longitude) {
      locationContext = `
USER LOCATION:
Latitude: ${latitude}
Longitude: ${longitude}

Use this location to suggest:
• Nearby tourist attractions
• Local food
• Transportation
• Hotels
`;
    }

    // =============================
    // 4️⃣ Call AI
    // =============================
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "deepseek/deepseek-chat",
        messages: [
          {
            role: "system",
            content: `
You are a professional travel assistant.

${locationContext}

CRITICAL RULES:
- You MUST respond ONLY in ${selectedLanguage}.
- Even if the user writes in another language, reply in ${selectedLanguage}.
- Do NOT mention what language you are using.
- Use the user's location internally to suggest places.
- NEVER reveal the latitude or longitude.
- NEVER mention coordinates in your answer.
- Only give travel recommendations.

Keep responses helpful, friendly, and travel-focused.
`,
          },
          ...chatMessages,
        ],
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    // =============================
    // 5️⃣ Extract AI Response
    // =============================
    const aiResponse =
      response?.data?.choices?.[0]?.message?.content ||
      "Sorry, I couldn't generate a response.";

    // =============================
    // 6️⃣ Save Bot Message
    // =============================
    const botMessage = await ChatMessage.create({
      sessionId,
      sender: "bot",
      message: aiResponse,
    });

    // =============================
    // 7️⃣ Return Response
    // =============================
    res.status(200).json({ botMessage });

  } catch (error) {
    console.error(
      "Chat Error:",
      error.response?.data || error.message
    );

    res.status(500).json({
      error: "AI request failed",
    });
  }
};

/* =========================
   GET CHAT HISTORY
========================= */
exports.getChatHistory = async (req, res) => {
  try {
    const messages = await ChatMessage.find({
      sessionId: req.params.sessionId,
    }).sort({ createdAt: 1 });

    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/* =========================
   GET USER SESSIONS
========================= */
exports.getUserSessions = async (req, res) => {
  try {
    const sessions = await ChatSession.find({
      userId: req.user.id,
    }).sort({ createdAt: -1 });

    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.deleteChatHistory = async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({
        message: "SessionId is required",
      });
    }

    await ChatSession.deleteMany({ sessionId });

    res.status(200).json({
      message: "Chat history deleted successfully",
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
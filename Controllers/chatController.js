const ChatSession = require("../models/ChatSession");
const ChatMessage = require("../models/ChatMessage");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const getAuthenticatedUserId = (req) => req.user?.id || req.user?.userId || null;

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

const parseCoordinate = (value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildLocationSummary = (locationData) => {
  if (!locationData) {
    return "";
  }

  const address = locationData.address || {};
  const parts = [
    address.suburb,
    address.city || address.town || address.village,
    address.state,
    address.country,
  ].filter(Boolean);

  return parts.join(", ");
};

const detectLocationIntent = (message) => {
  const normalizedMessage = String(message || "").toLowerCase();

  if (/(hotel|stay|resort|room|lodg)/.test(normalizedMessage)) {
    return {
      label: "hotels",
      tags: ['node["tourism"="hotel"]', 'node["tourism"="guest_house"]', 'node["tourism"="hostel"]'],
    };
  }

  if (/(food|restaurant|eat|cafe|coffee|dinner|lunch|breakfast)/.test(normalizedMessage)) {
    return {
      label: "food spots",
      tags: ['node["amenity"="restaurant"]', 'node["amenity"="cafe"]', 'node["amenity"="fast_food"]'],
    };
  }

  if (/(bus|train|metro|transport|station|airport|travel)/.test(normalizedMessage)) {
    return {
      label: "transport options",
      tags: ['node["public_transport"]', 'node["railway"="station"]', 'node["amenity"="bus_station"]'],
    };
  }

  return {
    label: "tourist spots",
    tags: [
      'node["tourism"="attraction"]',
      'node["historic"]',
      'node["leisure"="park"]',
      'node["tourism"="museum"]',
    ],
  };
};

const fallbackMessages = {
  en: ({ hasLocation }) =>
    `I can still help with travel planning right now. Share your destination, budget, travel dates, and interests, and I will suggest places to visit, food to try, transport options, and hotel ideas.${hasLocation ? " I noticed location data was shared, so I can tailor nearby travel ideas once you tell me what kind of trip you want." : ""}`,
  es: ({ hasLocation }) =>
    `Todavia puedo ayudarte con la planificacion del viaje. Comparte tu destino, presupuesto, fechas e intereses, y te sugerire lugares para visitar, comida para probar, transporte y opciones de hotel.${hasLocation ? " Tambien recibi tu ubicacion, asi que puedo orientar mejor las recomendaciones cercanas si me dices que tipo de viaje quieres." : ""}`,
  fr: ({ hasLocation }) =>
    `Je peux quand meme t'aider pour organiser ton voyage. Indique ta destination, ton budget, tes dates et tes centres d'interet, et je te proposerai des lieux a visiter, des plats a essayer, des transports et des idees d'hotel.${hasLocation ? " J'ai aussi recu ta localisation, donc je pourrai mieux adapter les suggestions a proximite si tu precises le type de voyage souhaite." : ""}`,
  hi: ({ hasLocation }) =>
    `Main abhi bhi aapki travel planning mein madad kar sakta hoon. Apni destination, budget, travel dates aur interests batayiye, aur main ghoomne ki jagahen, local food, transport aur hotel ideas suggest karunga.${hasLocation ? " Aapki location bhi mili hai, isliye agar aap trip ka type batayen to main nearby suggestions aur better bana sakta hoon." : ""}`,
  ar: ({ hasLocation }) =>
    `لا يزال بامكاني مساعدتك في تخطيط الرحلة. شاركني الوجهة والميزانية وتواريخ السفر واهتماماتك، وساقترح اماكن للزيارة وطعاما محليا ووسائل نقل وخيارات فنادق.${hasLocation ? " لقد وصلتني بيانات الموقع ايضا، لذلك يمكنني تحسين الاقتراحات القريبة عندما توضح نوع الرحلة التي تريدها." : ""}`,
  de: ({ hasLocation }) =>
    `Ich kann dir trotzdem bei der Reiseplanung helfen. Teile mir Reiseziel, Budget, Reisedaten und Interessen mit, dann schlage ich Orte, Essen, Transport und Hotelideen vor.${hasLocation ? " Deine Standortdaten wurden ebenfalls uebermittelt, daher kann ich nahegelegene Empfehlungen besser anpassen, wenn du die Art der Reise beschreibst." : ""}`,
  zh: ({ hasLocation }) =>
    `我现在仍然可以帮助你做旅行规划。告诉我目的地、预算、出行日期和兴趣，我会为你推荐景点、美食、交通和酒店建议。${hasLocation ? " 我也收到了你的位置数据，所以只要你说明想要的旅行类型，我就能进一步优化附近推荐。" : ""}`,
  ja: ({ hasLocation }) =>
    `今でも旅行計画のお手伝いはできます。目的地、予算、旅行日程、興味のあることを教えてください。観光地、食べ物、交通手段、ホテルの案を提案します。${hasLocation ? " 位置情報も受け取っているので、希望する旅行スタイルが分かれば近くの提案をさらに調整できます。" : ""}`,
};

const buildSystemPrompt = ({ selectedLanguage, locationContext, locationSummary }) => `
You are a professional travel assistant.

${locationContext}

CRITICAL RULES:
- You MUST respond ONLY in ${selectedLanguage}.
- Even if the user writes in another language, reply in ${selectedLanguage}.
- Do NOT mention what language you are using.
- Use the user's location internally to suggest places.
- If the user asks for nearby places, tourist spots, food, transport, hotels, or things to do, prioritize suggestions close to the current location.
- When location data is available, infer the likely nearby city or area${locationSummary ? ` as ${locationSummary}` : ""} and tailor the answer around it.
- NEVER reveal the latitude or longitude.
- NEVER mention coordinates in your answer.
- Only give travel recommendations.
- If the user asks a location-based question, give specific nearby suggestions first and then short practical tips.

Keep responses helpful, friendly, and travel-focused.
`;

const buildGeminiPrompt = (systemPrompt, chatMessages) =>
  `${systemPrompt}\n\nConversation so far:\n${chatMessages
    .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
    .join("\n")}`;

const generateOpenRouterResponse = async ({ apiKey, chatMessages, systemPrompt }) => {
  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: "deepseek/deepseek-chat",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        ...chatMessages,
      ],
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response?.data?.choices?.[0]?.message?.content?.trim();
};

const generateGeminiResponse = async ({ apiKey, chatMessages, systemPrompt }) => {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const result = await model.generateContent(buildGeminiPrompt(systemPrompt, chatMessages));
  return result.response.text().trim();
};

const generateFallbackResponse = ({ language, hasLocation }) => {
  const fallbackBuilder = fallbackMessages[language] || fallbackMessages.en;
  return fallbackBuilder({ hasLocation });
};

const reverseGeocode = async ({ latitude, longitude }) => {
  const response = await axios.get("https://nominatim.openstreetmap.org/reverse", {
    params: {
      format: "jsonv2",
      lat: latitude,
      lon: longitude,
      zoom: 14,
      addressdetails: 1,
    },
    headers: {
      "User-Agent": "multilingual-chatbot/1.0",
    },
    timeout: 8000,
  });

  return response.data;
};

const fetchNearbyPlaces = async ({ latitude, longitude, message }) => {
  const intent = detectLocationIntent(message);
  const radius = 5000;
  const query = `
[out:json][timeout:20];
(
  ${intent.tags.map((tag) => `${tag}(around:${radius},${latitude},${longitude});`).join("\n  ")}
);
out center 12;
`;

  const response = await axios.post(
    "https://overpass-api.de/api/interpreter",
    query,
    {
      headers: {
        "Content-Type": "text/plain",
        "User-Agent": "multilingual-chatbot/1.0",
      },
      timeout: 12000,
    }
  );

  const elements = Array.isArray(response.data?.elements) ? response.data.elements : [];
  return {
    intent,
    places: elements
      .map((element) => {
        const tags = element.tags || {};
        return {
          name: tags.name,
          type: tags.tourism || tags.amenity || tags.leisure || tags.historic || tags.railway || tags.public_transport,
          address: [tags["addr:street"], tags["addr:city"]].filter(Boolean).join(", "),
        };
      })
      .filter((place) => place.name)
      .slice(0, 5),
  };
};

const buildPlacesFallbackResponse = ({ language, locationSummary, nearbyPlaces }) => {
  if (!nearbyPlaces?.places?.length) {
    return generateFallbackResponse({
      language,
      hasLocation: Boolean(locationSummary),
    });
  }

  const heading = locationSummary
    ? `Here are some ${nearbyPlaces.intent.label} near ${locationSummary}:`
    : `Here are some nearby ${nearbyPlaces.intent.label}:`;

  const lines = nearbyPlaces.places.map((place, index) => {
    const details = [place.type, place.address].filter(Boolean).join(" - ");
    return `${index + 1}. ${place.name}${details ? ` (${details})` : ""}`;
  });

  return `${heading}\n${lines.join("\n")}\nTell me if you want the best option, family-friendly places, budget picks, or a one-day plan nearby.`;
};
/* =========================
   CREATE SESSION
========================= */
exports.createSession = async (req, res) => {
  try {
    const { title, language } = req.body;
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const session = await ChatSession.create({
      userId,
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
    const userId = getAuthenticatedUserId(req);
    const parsedLatitude = parseCoordinate(latitude);
    const parsedLongitude = parseCoordinate(longitude);
    const hasLocation = parsedLatitude !== null && parsedLongitude !== null;

    if (!sessionId || !message) {
      return res.status(400).json({
        message: "SessionId and message are required",
      });
    }

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if ((latitude !== undefined || longitude !== undefined) && !hasLocation) {
      return res.status(400).json({
        error: "Latitude and longitude must be valid numbers",
      });
    }

    if (
      hasLocation &&
      (parsedLatitude < -90 ||
        parsedLatitude > 90 ||
        parsedLongitude < -180 ||
        parsedLongitude > 180)
    ) {
      return res.status(400).json({
        error: "Latitude or longitude is out of range",
      });
    }

    const session = await ChatSession.findOne({ _id: sessionId, userId });
    if (!session) {
      return res.status(404).json({
        error: "Chat session not found for this user",
      });
    }

    const selectedLanguage =
      languageMap[language] || language || "English";
    const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
    const geminiKey = process.env.GEMINI_API_KEY?.trim();

    // =============================
    // 1️⃣ Save User Message
    // =============================
    await ChatMessage.create({
      sessionId: session._id,
      sender: "user",
      message,
    });

    // =============================
    // 2️⃣ Get Previous Messages
    // =============================
    const previousMessages = await ChatMessage.find({ sessionId: session._id })
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
    let locationSummary = "";

    if (hasLocation) {
      try {
        const locationData = await reverseGeocode({
          latitude: parsedLatitude,
          longitude: parsedLongitude,
        });

        locationSummary = buildLocationSummary(locationData);
      } catch (error) {
        console.error("Reverse geocoding failed:", error.response?.data || error.message);
      }

      locationContext = `
USER LOCATION:
Latitude: ${parsedLatitude}
Longitude: ${parsedLongitude}
${locationSummary ? `Likely area: ${locationSummary}` : ""}

Use this location to suggest:
- Nearby tourist attractions
- Things to do right now
- Local food
- Transportation
- Hotels
- Short travel ideas around the user's current area
`;
    }

    const systemPrompt = buildSystemPrompt({
      selectedLanguage,
      locationContext,
      locationSummary,
    });

    // =============================
    // 4️⃣ Call AI with provider fallback
    // =============================
    let aiResponse = "";
    let provider = "fallback";
    const providerErrors = [];

    if (openRouterKey) {
      try {
        aiResponse = await generateOpenRouterResponse({
          apiKey: openRouterKey,
          chatMessages,
          systemPrompt,
        });
        provider = "openrouter";
      } catch (error) {
        providerErrors.push({
          provider: "openrouter",
          status: error.response?.status || 500,
          error: error.response?.data || error.message,
        });
      }
    }

    if (!aiResponse && geminiKey) {
      try {
        aiResponse = await generateGeminiResponse({
          apiKey: geminiKey,
          chatMessages,
          systemPrompt,
        });
        provider = "gemini";
      } catch (error) {
        providerErrors.push({
          provider: "gemini",
          status: error.response?.status || 500,
          error: error.response?.data || error.message,
        });
      }
    }

    if (!aiResponse && hasLocation) {
      try {
        const nearbyPlaces = await fetchNearbyPlaces({
          latitude: parsedLatitude,
          longitude: parsedLongitude,
          message,
        });

        aiResponse = buildPlacesFallbackResponse({
          language,
          locationSummary,
          nearbyPlaces,
        });
        provider = "osm-fallback";
      } catch (error) {
        providerErrors.push({
          provider: "overpass",
          status: error.response?.status || 500,
          error: error.response?.data || error.message,
        });
      }
    }

    if (!aiResponse) {
      aiResponse = generateFallbackResponse({
        language,
        hasLocation,
      });
      console.error("Chat provider fallback used:", providerErrors);
    }

    // =============================
    // 6️⃣ Save Bot Message
    // =============================
    const botMessage = await ChatMessage.create({
      sessionId: session._id,
      sender: "bot",
      message: aiResponse,
    });

    // =============================
    // 7️⃣ Return Response
    // =============================
    res.status(200).json({ botMessage, provider, locationSummary });

  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error("Chat Error:", errorData);

    res.status(error.response?.status || 500).json({
      error: typeof errorData === "string" ? errorData : errorData || "AI request failed",
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
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const sessions = await ChatSession.find({
      userId,
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

const ChatSession = require("../models/ChatSession");
const ChatMessage = require("../models/ChatMessage");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
];
const COHERE_CHAT_URL = "https://api.cohere.com/v2/chat";
const COHERE_MODEL = "command-a-03-2025";
const COHERE_TIMEOUT_MS = 30000;
const COHERE_MAX_RETRIES = 2;
const GEMINI_MODEL_CANDIDATES = [
  "gemini-2.0-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash",
];

let geminiCooldownUntil = 0;

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

const isNearbyPlacesRequest = (message) => {
  const normalizedMessage = String(message || "").toLowerCase();

  return /(near me|nearby|around me|around here|close by|close to me|current location|my location|things to do|places to visit|tourist spots?|restaurants?|hotels?|food|transport|station|airport)/.test(normalizedMessage);
};

const detectBudgetPreference = (message) => {
  const normalizedMessage = String(message || "").toLowerCase();

  if (/(luxury|premium|5 star|five star|high[- ]?end)/.test(normalizedMessage)) {
    return "luxury";
  }

  if (/(budget|cheap|affordable|low cost|low-cost|backpack)/.test(normalizedMessage)) {
    return "budget";
  }

  if (/(mid[- ]?range|moderate|comfortable)/.test(normalizedMessage)) {
    return "mid-range";
  }

  return "";
};

const destinationStopWords = new Set([
  "a",
  "an",
  "area",
  "attraction",
  "attractions",
  "beach",
  "best",
  "bus",
  "cafe",
  "city",
  "dinner",
  "destination",
  "eat",
  "evening",
  "food",
  "foods",
  "guide",
  "hotel",
  "hotels",
  "itinerary",
  "lunch",
  "metro",
  "museum",
  "park",
  "places",
  "plan",
  "restaurant",
  "restaurants",
  "route",
  "sightseeing",
  "spot",
  "spots",
  "station",
  "stay",
  "tour",
  "tourist",
  "train",
  "transport",
  "travel",
  "trip",
  "visit",
  "visiting",
]);

const normalizeCandidateDestination = (candidate) => {
  const value = String(candidate || "")
    .replace(/[.,!?;:]+$/g, "")
    .trim();

  if (!value) {
    return "";
  }

  const tokens = value
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z.\-]/g, ""))
    .filter(Boolean);

  if (!tokens.length) {
    return "";
  }

  const normalizedLower = tokens.join(" ").toLowerCase();
  if (destinationStopWords.has(normalizedLower)) {
    return "";
  }

  if (tokens.every((token) => destinationStopWords.has(token.toLowerCase()))) {
    return "";
  }

  return tokens.join(" ");
};

const extractDestinationFromMessage = (message) => {
  const text = String(message || "").trim();
  if (!text) {
    return "";
  }

  const patterns = [
    /\b(?:in|at|near|around|for|to|visit|visiting|travel to|trip to|going to)\s+([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+){0,3})/,
    /\b(?:in|at|near|around|for|to|visit|visiting|travel to|trip to|going to)\s+([a-z]+(?:\s+[a-z]+){0,3})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const normalizedDestination = normalizeCandidateDestination(match[1]);
      if (normalizedDestination) {
        return normalizedDestination;
      }
    }
  }

  return "";
};

const buildEnglishSmartFallback = ({
  message,
  hasLocation,
  locationSummary,
  nearbyPlaces,
}) => {
  const intent = detectLocationIntent(message);
  const budgetPreference = detectBudgetPreference(message);
  const destination = extractDestinationFromMessage(message) || locationSummary;
  const areaText = destination || (hasLocation ? "your current area" : "your destination");
  const placeNames = nearbyPlaces?.places?.slice(0, 3).map((place) => place.name).filter(Boolean) || [];
  const intro = hasLocation
    ? `Here is a practical travel answer for ${areaText}.`
    : "Here is a practical travel answer based on your message.";

  if (intent.label === "hotels") {
    const budgetLine = budgetPreference
      ? `Focus on ${budgetPreference} stays, compare recent guest ratings, and check transport access before booking.`
      : "Compare recent guest ratings, neighborhood safety, and transport access before booking.";
    const nearbyLine = placeNames.length
      ? `A few nearby stay-related options or landmarks to check around ${areaText}: ${placeNames.join(", ")}.`
      : `If you want, I can next narrow this down to the best areas to stay in ${areaText} for families, couples, or budget travel.`;

    return `${intro}

For hotels in ${areaText}, start with properties close to the places you plan to visit most so you save time on daily transport.
${budgetLine}
Prioritize free cancellation, breakfast if you have early plans, and reviews that mention cleanliness and quiet rooms.
${nearbyLine}`;
  }

  if (intent.label === "food spots") {
    const nearbyLine = placeNames.length
      ? `A few nearby food spots or landmarks to start with: ${placeNames.join(", ")}.`
      : `Start around busy local markets or central dining streets in ${areaText} for the widest range of food choices.`;

    return `${intro}

For food in ${areaText}, mix one well-rated local restaurant with one casual street-food or cafe stop so you get both signature dishes and easy comfort options.
${nearbyLine}
Check peak meal hours, keep cash or UPI/card backup ready, and choose places with strong recent reviews for hygiene and consistency.
If you want, I can turn this into a breakfast-lunch-dinner food plan next.`;
  }

  if (intent.label === "transport options") {
    const nearbyLine = placeNames.length
      ? `Useful nearby transport points to look at first: ${placeNames.join(", ")}.`
      : `Start by checking the nearest railway station, bus hub, metro stop, or airport connection for ${areaText}.`;

    return `${intro}

For transport around ${areaText}, the best option usually depends on distance: walking or local rides for short hops, metro or train for busy corridors, and buses or cabs for flexible point-to-point travel.
${nearbyLine}
Travel earlier in the day for sightseeing, keep one offline maps option ready, and confirm the return route before late evening.
If you share your exact route, I can suggest the cheapest or fastest way to get there.`;
  }

  const nearbyLine = placeNames.length
    ? `A few places worth checking first near ${areaText}: ${placeNames.join(", ")}.`
    : hasLocation
      ? `I can use your current area to shape a nearby sightseeing plan.`
      : `If you share the destination name, I can turn this into a city-specific itinerary.`;

  return `${intro}

Here is a simple travel planning answer for ${areaText}:
1. Start with 2 or 3 major sights close to each other so the day stays realistic.
2. Add one local food stop and one relaxed evening activity.
3. Choose transport and hotel options based on whether you want budget, comfort, or speed.
${nearbyLine}
Send your budget, dates, and trip style if you want a personalized one-day or multi-day plan.`;
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
    OPENROUTER_URL,
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
        "HTTP-Referer": "http://localhost:5000",
        "X-Title": "multilingual-chatbot",
      },
      timeout: 15000,
    }
  );

  return response?.data?.choices?.[0]?.message?.content?.trim();
};

const generateCohereResponse = async ({ apiKey, chatMessages, systemPrompt }) => {
  let lastError = null;

  for (let attempt = 0; attempt <= COHERE_MAX_RETRIES; attempt += 1) {
    try {
      const response = await axios.post(
        COHERE_CHAT_URL,
        {
          model: COHERE_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            ...chatMessages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-Client-Name": "multilingual-chatbot",
          },
          timeout: COHERE_TIMEOUT_MS,
        }
      );

      return response?.data?.message?.content
        ?.filter((item) => item?.type === "text")
        .map((item) => item.text)
        .join("\n")
        .trim();
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const isRetryable =
        error.code === "ECONNABORTED" ||
        status === 408 ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504;

      if (!isRetryable || attempt === COHERE_MAX_RETRIES) {
        throw error;
      }

      await wait(800 * (attempt + 1));
    }
  }

  throw lastError || new Error("Cohere request failed.");
};

const generateGeminiResponse = async ({ apiKey, chatMessages, systemPrompt }) => {
  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError = null;

  for (const modelName of GEMINI_MODEL_CANDIDATES) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(buildGeminiPrompt(systemPrompt, chatMessages));
      return result.response.text().trim();
    } catch (error) {
      lastError = error;

      if (error.response?.status !== 404 && !String(error.message || "").includes("404")) {
        throw error;
      }
    }
  }

  throw lastError || new Error("No supported Gemini model was available for generateContent.");
};

const generateFallbackResponse = ({ language, hasLocation }) => {
  const fallbackBuilder = fallbackMessages[language] || fallbackMessages.en;
  return fallbackBuilder({ hasLocation });
};

const generateSmartFallbackResponse = ({
  language,
  message,
  hasLocation,
  locationSummary,
  nearbyPlaces,
}) => {
  if (language === "en" || !language) {
    return buildEnglishSmartFallback({
      message,
      hasLocation,
      locationSummary,
      nearbyPlaces,
    });
  }

  return generateFallbackResponse({ language, hasLocation });
};

const parseRetryDelayMs = (text) => {
  const value = String(text || "");
  const retrySecondsMatch = value.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
  if (retrySecondsMatch?.[1]) {
    return Math.ceil(Number(retrySecondsMatch[1]) * 1000);
  }

  const retryDelayMatch = value.match(/"retryDelay":"(\d+)s"/i);
  if (retryDelayMatch?.[1]) {
    return Number(retryDelayMatch[1]) * 1000;
  }

  return 0;
};

const isGeminiQuotaError = (error) => {
  const text = String(error.response?.data || error.message || "").toLowerCase();
  return error.response?.status === 429 || text.includes("quota exceeded") || text.includes("too many requests");
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

const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isOverpassRetryableError = (error) => {
  const status = error.response?.status;
  const body = String(error.response?.data || error.message || "").toLowerCase();

  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    body.includes("too busy") ||
    body.includes("timeout")
  );
};

const summarizeProviderError = (error) => {
  if (isGeminiQuotaError(error)) {
    const retryAfterMs = parseRetryDelayMs(error.response?.data || error.message);
    const retryAfterText = retryAfterMs ? ` Retry after about ${Math.ceil(retryAfterMs / 1000)}s.` : "";
    return `Gemini quota exceeded.${retryAfterText}`;
  }

  const rawData = error.response?.data;

  if (typeof rawData === "string") {
    return rawData
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
  }

  if (rawData?.error?.message) {
    return rawData.error.message;
  }

  if (rawData?.message) {
    return rawData.message;
  }

  return String(error.message || "Unknown error");
};

const buildProviderErrorEntry = (provider, error) => ({
  provider,
  status: error.response?.status || 500,
  error: summarizeProviderError(error),
});

const logProviderFallbackErrors = (providerErrors) => {
  if (!providerErrors.length) {
    return;
  }

  console.error("Chat provider fallback used:", providerErrors);
};

const fetchNearbyPlaces = async ({ latitude, longitude, message }) => {
  const intent = detectLocationIntent(message);
  const radius = 3500;
  const query = `
[out:json][timeout:20];
(
  ${intent.tags.map((tag) => `${tag}(around:${radius},${latitude},${longitude});`).join("\n  ")}
);
out center 8;
`;

  for (let index = 0; index < OVERPASS_ENDPOINTS.length; index += 1) {
    try {
      const response = await axios.post(
        OVERPASS_ENDPOINTS[index],
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
    } catch (error) {
      if (!isOverpassRetryableError(error) || index === OVERPASS_ENDPOINTS.length - 1) {
        throw error;
      }

      await wait(400 * (index + 1));
    }
  }

  return { intent, places: [] };
};

const buildPlacesFallbackResponse = ({ language, message, hasLocation, locationSummary, nearbyPlaces }) => {
  if (!nearbyPlaces?.places?.length) {
    return generateSmartFallbackResponse({
      language,
      message,
      hasLocation,
      locationSummary,
      nearbyPlaces,
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

    const requestedLanguage = language || session.language || "en";
    const selectedLanguage =
      languageMap[requestedLanguage] || requestedLanguage || "English";
    const cohereKey = process.env.COHERE_API_KEY?.trim() || "";

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
      .limit(12);

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
    const shouldTryNearbyPlaces = hasLocation && isNearbyPlacesRequest(message);

    if (cohereKey) {
      try {
        aiResponse = await generateCohereResponse({
          apiKey: cohereKey,
          chatMessages,
          systemPrompt,
        });
        provider = "cohere";
      } catch (error) {
        providerErrors.push(buildProviderErrorEntry("cohere", error));
      }
    } else {
      console.error("Cohere API key missing. Add COHERE_API_KEY to .env.");
    }

    if (!aiResponse && shouldTryNearbyPlaces) {
      try {
        const nearbyPlaces = await fetchNearbyPlaces({
          latitude: parsedLatitude,
          longitude: parsedLongitude,
          message,
        });

        aiResponse = buildPlacesFallbackResponse({
          language: requestedLanguage,
          message,
          hasLocation,
          locationSummary,
          nearbyPlaces,
        });
        provider = "osm-fallback";
      } catch (error) {
        providerErrors.push(buildProviderErrorEntry("overpass", error));
      }
    }

    if (!aiResponse) {
      aiResponse = generateSmartFallbackResponse({
        language: requestedLanguage,
        message,
        hasLocation,
        locationSummary,
      });
      logProviderFallbackErrors(providerErrors);
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

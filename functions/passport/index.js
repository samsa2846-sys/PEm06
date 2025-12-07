const axios = require("axios");

// ============================================================================
// КОНСТАНТЫ И КОНФИГУРАЦИЯ
// ============================================================================

const VISION_ENDPOINT = "https://vision.api.cloud.yandex.net/vision/v1/batchAnalyze";
const GPT_ENDPOINT = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion";

// Лимиты размера изображения
const MIN_IMAGE_SIZE = 10240; // 10KB
const MAX_IMAGE_SIZE = 4194304; // 4MB

// ============================================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================================

/**
 * Валидация формата изображения (точная копия старого кода)
 * @param {Buffer} imageBuffer - Буфер изображения
 * @returns {boolean} true если формат поддерживается
 */
function validateImageFormat(imageBuffer) {
  if (imageBuffer.length < 8) return false;
  const header = imageBuffer.slice(0, 8).toString("hex");
  // JPEG: FF D8 FF
  if (header.startsWith("ffd8ff")) return true;
  // PNG: 89 50 4E 47
  if (header.startsWith("89504e47")) return true;
  // GIF: 47 49 46 38
  if (header.startsWith("47494638")) return true;
  return false;
}

/**
 * Извлечение текста из ответа Vision API (точная копия старого кода)
 * @param {Object} response - Ответ от Vision API
 * @returns {string|null} Извлеченный текст или null
 */
function extractTextFromResponse(response) {
  try {
    const result = typeof response === "string" ? JSON.parse(response) : response;
    const fullText = [];

    for (const resultItem of result.results || []) {
      for (const res of resultItem.results || []) {
        if (res.textDetection) {
          const textData = res.textDetection;

          if (textData.text) {
            fullText.push(textData.text);
          } else if (textData.pages) {
            const pageText = [];
            for (const page of textData.pages) {
              for (const block of page.blocks || []) {
                for (const line of block.lines || []) {
                  const lineText = (line.words || [])
                    .map((word) => word.text || "")
                    .filter((text) => text)
                    .join(" ");
                  if (lineText) {
                    pageText.push(lineText);
                  }
                }
              }
            }
            if (pageText.length > 0) {
              fullText.push(pageText.join("\n"));
            }
          }
        }
      }
    }

    return fullText.length > 0 ? fullText.join("\n\n") : null;
  } catch (error) {
    console.error("Error extracting text from response:", error);
    return null;
  }
}

/**
 * Вызывает Yandex Vision API для распознавания текста
 * @param {Buffer} imageBuffer - Буфер изображения
 * @returns {Promise<string>} Распознанный текст
 * @throws {Error} При ошибке API
 */
async function callYandexVision(imageBuffer) {
  const apiKey = process.env.YANDEX_VISION_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  const payload = {
    folderId,
    analyzeSpecs: [
      {
        content: imageBuffer.toString("base64"),
        features: [
          {
            type: "TEXT_DETECTION",
            textDetectionConfig: { languageCodes: ["ru"] },
          },
        ],
      },
    ],
  };

  const response = await axios.post(VISION_ENDPOINT, payload, {
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  return extractTextFromResponse(response.data);
}

/**
 * Вызывает Yandex GPT API для структурирования данных паспорта
 * @param {string} recognizedText - Распознанный текст из Vision
 * @returns {Promise<Object>} Структурированные данные паспорта
 * @throws {Error} При ошибке API или некорректном ответе
 */
async function callYandexGPT(recognizedText) {
  const apiKey = process.env.YANDEX_GPT_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  const prompt = `ПРОАНАЛИЗИРУЙ ТЕКСТ ПАСПОРТА И ИЗВЛЕКИ ВСЕ ДАННЫЕ:

ОБЯЗАТЕЛЬНЫЕ ПОЛЯ:
1. Фамилия (как в тексте)
2. Имя (как в тексте)
3. Отчество (как в тексте)
4. Дата рождения (формат ДД.ММ.ГГГГ)
5. Место рождения (город)
6. Номер паспорта (только цифры, 10 цифр, без пробелов)
7. Гражданство (страна)

ФОРМАТ ОТВЕТА ТОЛЬКО JSON:
{
    "last_name": "КОЗЛОВ",
    "first_name": "ВЯЧЕСЛАВ",
    "middle_name": "ВАЛЕРЬЕВИЧ",
    "birth_date": "03.06.1970",
    "birth_place": "ЯКУТСК",
    "passport_number": "4515161589",
    "citizenship": "Россия"
}

Текст для анализа:
${recognizedText}`;

  const payload = {
    modelUri: `gpt://${folderId}/yandexgpt-lite`,
    completionOptions: {
      stream: false,
      temperature: 0.1,
      maxTokens: 1500,
    },
    messages: [
      {
        role: "user",
        text: prompt,
      },
    ],
  };

  const response = await axios.post(GPT_ENDPOINT, payload, {
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  const messageText = response.data?.result?.alternatives?.[0]?.message?.text || "";

  // Извлекаем JSON из ответа (как в старом коде)
  try {
    const start = messageText.indexOf("{");
    const end = messageText.lastIndexOf("}") + 1;
    if (start !== -1 && end > start) {
      const jsonStr = messageText.substring(start, end);
      return JSON.parse(jsonStr);
    }
    return { error: "JSON not found", raw_text: messageText };
  } catch (e) {
    return { error: "Invalid JSON", raw_text: messageText };
  }
}

// ============================================================================
// ОСНОВНАЯ ФУНКЦИЯ
// ============================================================================

/**
 * Обработчик функции распознавания паспорта
 * @param {Object} event - Событие от Yandex Cloud Functions
 * @param {Object} context - Контекст выполнения функции
 * @returns {Promise<Object>} HTTP ответ
 */
exports.handler = async function (event, context) {
  try {
    // Проверка HTTP метода (точная логика из старого кода)
    if (event.httpMethod && event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Method Not Allowed" }),
      };
    }

    // Точная логика парсинга из старого кода
    let body;
    try {
      body = event.isBase64Encoded
        ? JSON.parse(Buffer.from(event.body, "base64").toString())
        : JSON.parse(event.body);
    } catch (err) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid JSON body" }),
      };
    }

    // Поддержка старых и новых полей для обратной совместимости
    const imageBase64 = body.image || body.imageBase64;
    if (!imageBase64) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: 'Image data (base64) is required in "image" field' }),
      };
    }

    // Декодирование base64
    let imageBuffer;
    try {
      imageBuffer = Buffer.from(imageBase64, "base64");
    } catch (err) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid base64 image data" }),
      };
    }

    // Валидация размера
    if (imageBuffer.length < MIN_IMAGE_SIZE || imageBuffer.length > MAX_IMAGE_SIZE) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Bad Request",
          message: `Image size must be between ${MIN_IMAGE_SIZE} bytes and ${MAX_IMAGE_SIZE} bytes`,
        }),
      };
    }

    // Валидация формата (используем старую функцию)
    if (!validateImageFormat(imageBuffer)) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Bad Request",
          message: "Invalid image format. Supported: JPEG, PNG, GIF",
        }),
      };
    }

    // Распознавание текста через Vision API
    let recognizedText;
    try {
      recognizedText = await callYandexVision(imageBuffer);
    } catch (err) {
      console.error("Vision API error:", err);
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Vision API Error",
          message: `Failed to recognize text: ${err.message}`,
        }),
      };
    }

    if (!recognizedText || !recognizedText.trim()) {
      return {
        statusCode: 422,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "No text detected in image" }),
      };
    }

    // Структурирование данных через GPT
    let passportData;
    try {
      passportData = await callYandexGPT(recognizedText);
    } catch (err) {
      console.error("GPT API error:", err);
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "GPT API Error",
          message: `Failed to structure data: ${err.message}`,
        }),
      };
    }

    // Проверка на ошибки в ответе GPT
    if (passportData.error) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "GPT Processing Error",
          message: passportData.error,
          raw_text: passportData.raw_text,
        }),
      };
    }

    // Возврат успешного ответа
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        last_name: passportData.last_name,
        first_name: passportData.first_name,
        middle_name: passportData.middle_name,
        birth_date: passportData.birth_date,
        birth_place: passportData.birth_place,
        passport_number: passportData.passport_number,
        citizenship: passportData.citizenship,
      }),
    };
  } catch (error) {
    console.error("Passport function error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Internal Server Error",
        message: error.message,
      }),
    };
  }
};

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
 * Валидация формата изображения
 */
function validateImageFormat(imageBuffer) {
  if (imageBuffer.length < 8) return false;
  const header = imageBuffer.slice(0, 8).toString("hex");
  if (header.startsWith("ffd8ff")) return true; // JPEG
  if (header.startsWith("89504e47")) return true; // PNG
  if (header.startsWith("47494638")) return true; // GIF
  return false;
}

/**
 * Извлечение текста из ответа Vision API
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
 * Вызов Yandex Vision API
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
 * Вызов Yandex GPT API для извлечения данных из патента
 */
async function extractPatentDataWithGPT(recognizedText) {
  const apiKey = process.env.YANDEX_GPT_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  const prompt = `Ты - система извлечения данных из патента на работу. Извлеки строго следующие поля:

1. full_name - ФИО в одной строке (Фамилия Имя Отчество)

2. citizenship - Гражданство полностью

3. document_number - НОМЕР ДОКУМЕНТА (только номер, без всего лишнего)

КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА ДЛЯ document_number:

- Ищи строку с цифрами и/или латинскими буквами, которая похожа на номер документа

- Если в строке есть символ "/", берем ТОЛЬКО часть ДО "/" (слева от "/")

- Удали все пробелы вокруг "/" и в самом номере

- Примеры:

  * "401828285 / 772997561656" → "401828285"

  * "ABC123 / 456789" → "ABC123"

  * "12345/67890" → "12345"

  * "Только текст" → "не указан"

  * "НЕТ данных" → "не указан"

- Номер может содержать: только цифры, только буквы, буквы и цифры

- Длина обычно 5-10 символов, но может быть разной

Формат ответа ТОЛЬКО JSON:

{
  "full_name": "Туйчиев Маъдиходжа Сайдходжаевич",
  "citizenship": "Таджикистан",
  "document_number": "401828285"
}

Текст для анализа:

${recognizedText}

Не добавляй никаких пояснений, только JSON.`;

  const payload = {
    modelUri: `gpt://${folderId}/yandexgpt-lite`,
    completionOptions: {
      stream: false,
      temperature: 0.1,
      maxTokens: 400,
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

  // Извлекаем JSON из ответа
  try {
    const start = messageText.indexOf("{");
    const end = messageText.lastIndexOf("}") + 1;
    if (start !== -1 && end > start) {
      const jsonStr = messageText.substring(start, end);
      return JSON.parse(jsonStr);
    }
    return { error: "JSON не найден", raw_text: messageText };
  } catch (e) {
    return { error: "Неверный JSON", raw_text: messageText };
  }
}

/**
 * Валидация номера документа патента
 */
function validateDocumentNumber(docNumber) {
  if (!docNumber) return false;
  // Формат: "XXXXX / XXXXXXXX" или с латинскими буквами
  const parts = docNumber.split("/").map((part) => part.trim());
  if (parts.length !== 2) return false;
  // Первая часть: цифры ИЛИ буквы+цифры
  const firstPart = parts[0];
  // Вторая часть: обычно только цифры
  const secondPart = parts[1];
  // Проверка, что вторая часть состоит из цифр
  if (!/^\d+$/.test(secondPart)) return false;
  // Первая часть может содержать буквы и цифры
  if (!/^[A-Za-z0-9]+$/.test(firstPart)) return false;
  return true;
}

// ============================================================================
// ОСНОВНАЯ ФУНКЦИЯ
// ============================================================================

/**
 * Обработчик функции распознавания патента
 */
exports.handler = async function (event, context) {
  console.log("=== НАЧАЛО ОБРАБОТКИ ПАТЕНТА ===");

  try {
    // Проверка HTTP метода
    if (event.httpMethod && event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Method Not Allowed" }),
      };
    }

    // Парсинг тела запроса
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

    // Поддержка старых и новых полей
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

    // Валидация формата
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

    console.log("Распознанный текст патента:", recognizedText.substring(0, 500) + "...");

    // Извлечение данных через GPT
    let patentData;
    try {
      patentData = await extractPatentDataWithGPT(recognizedText);
    } catch (err) {
      console.error("GPT API error:", err);
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "GPT API Error",
          message: `Failed to extract patent data: ${err.message}`,
        }),
      };
    }

    // Проверка на ошибки в ответе GPT
    if (patentData.error) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "GPT Processing Error",
          message: patentData.error,
          raw_text: patentData.raw_text,
        }),
      };
    }

    // Проверка обязательных полей
    const requiredFields = ["full_name", "citizenship", "document_number"];
    const missingFields = requiredFields.filter((field) => !patentData[field]);

    if (missingFields.length > 0) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Missing required fields",
          message: `Не удалось извлечь: ${missingFields.join(", ")}`,
          extracted_data: patentData,
        }),
      };
    }

    // Валидация номера документа (опционально)
    if (!validateDocumentNumber(patentData.document_number)) {
      console.warn("Document number format warning:", patentData.document_number);
      // Не блокируем, но логируем предупреждение
    }

    // Возврат успешного ответа
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        full_name: patentData.full_name,
        citizenship: patentData.citizenship,
        document_number: patentData.document_number,
      }),
    };
  } catch (error) {
    console.error("Patent function error:", error);
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



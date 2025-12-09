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
 * Вызов Yandex Vision API для распознавания текста
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
 * Вызов Yandex GPT API для извлечения данных из водительских прав
 */
async function extractLicenseDataWithGPT(recognizedText) {
  const apiKey = process.env.YANDEX_GPT_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  const prompt = `Ты - система обработки текстовых данных. Извлеки информацию из предоставленного текста.

ИЗВЛЕКИ СЛЕДУЮЩИЕ ДАННЫЕ:

1. Полное имя на кириллице (фамилия, имя, отчество в одной строке)

2. Цифровой идентификационный номер (10 цифр без пробелов)

ПРАВИЛА ОБРАБОТКИ:

1. Имя должно быть на кириллице, в формате: "ФАМИЛИЯ ИМЯ ОТЧЕСТВО"

2. Цифровой номер: найди последовательность из 10 цифр, возможно разделенных пробелами

   - Пример: "99 24 621263" → "9924621263"

   - Удали все нецифровые символы

   - Результат: ровно 10 цифр

ТЕКСТ ДЛЯ АНАЛИЗА:

${recognizedText}

Верни JSON:

{
  "full_name": "ФИО или 'не указано'",
  "license_number": "10 цифр или 'не указан'"
}`;

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
 * Очистка номера прав (удаление всех нецифровых символов)
 */
function cleanLicenseNumber(licenseNumber) {
  if (!licenseNumber || licenseNumber === "не указан") {
    return "не указан";
  }

  // Удаляем ВСЕ нецифровые символы
  const digitsOnly = licenseNumber.replace(/\D/g, "");

  // Проверяем что ровно 10 цифр
  if (digitsOnly.length === 10 && /^\d+$/.test(digitsOnly)) {
    return digitsOnly;
  }

  return "не указан";
}

/**
 * Форматирование ФИО (верхний регистр, убираем лишние пробелы)
 */
function formatFullName(fullName) {
  if (!fullName || fullName === "не указано") {
    return "не указано";
  }

  // Приводим к верхнему регистру, убираем лишние пробелы
  return fullName.toUpperCase().replace(/\s+/g, " ").trim();
}

// ============================================================================
// ОСНОВНАЯ ФУНКЦИЯ
// ============================================================================

/**
 * Обработчик функции распознавания водительских прав
 */
exports.handler = async function (event, context) {
  console.log("=== НАЧАЛО ОБРАБОТКИ ВОДИТЕЛЬСКИХ ПРАВ ===");

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

    // Поддержка разных форматов запроса
    let recognizedText = "";

    if (body.text) {
      // Вариант 2: Уже есть готовый текст
      recognizedText = body.text;
      console.log("Используется готовый текст, длина:", recognizedText.length);
    } else if (body.front_image && body.back_image) {
      // Вариант 1: Два изображения - распознаем оба
      console.log("Распознаем два изображения (лицевая и обратная стороны)...");

      try {
        // Распознаем лицевую сторону
        const frontBuffer = Buffer.from(body.front_image, "base64");
        const frontText = await callYandexVision(frontBuffer);

        // Распознаем обратную сторону
        const backBuffer = Buffer.from(body.back_image, "base64");
        const backText = await callYandexVision(backBuffer);

        // Объединяем тексты
        recognizedText = `ЛИЦЕВАЯ СТОРОНА:

${frontText || ""}

ОБРАТНАЯ СТОРОНА:

${backText || ""}`;

        console.log("Текст лицевой стороны:", frontText ? frontText.substring(0, 200) + "..." : "нет");
        console.log("Текст обратной стороны:", backText ? backText.substring(0, 200) + "..." : "нет");
      } catch (err) {
        console.error("Ошибка распознавания изображений:", err);
        return {
          statusCode: 500,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            error: "Vision API Error",
            message: `Failed to recognize images: ${err.message}`,
          }),
        };
      }
    } else if (body.image || body.imageBase64) {
      // Вариант 3: Одно изображение (обратная совместимость)
      const imageBase64 = body.image || body.imageBase64;

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

      // Распознавание текста
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
    } else {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Bad Request",
          message: "Required fields: 'text' OR 'front_image' and 'back_image' OR 'image'",
        }),
      };
    }

    // Проверка что текст распознан
    if (!recognizedText || !recognizedText.trim()) {
      return {
        statusCode: 422,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "No text detected in image(s)" }),
      };
    }

    console.log("Распознанный текст (первые 500 символов):", recognizedText.substring(0, 500) + "...");

    // Извлечение данных через GPT
    let licenseData;
    try {
      licenseData = await extractLicenseDataWithGPT(recognizedText);
    } catch (err) {
      console.error("GPT API error:", err);
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "GPT API Error",
          message: `Failed to extract license data: ${err.message}`,
        }),
      };
    }

    // Проверка на ошибки в ответе GPT
    if (licenseData.error) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "GPT Processing Error",
          message: licenseData.error,
          raw_text: licenseData.raw_text,
        }),
      };
    }

    // Очистка и форматирование данных
    const formattedData = {
      full_name: formatFullName(licenseData.full_name),
      license_number: cleanLicenseNumber(licenseData.license_number),
    };

    // Проверка обязательных полей
    if (formattedData.full_name === "не указано" && formattedData.license_number === "не указан") {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Data Extraction Failed",
          message: "Не удалось извлечь ни ФИО, ни номер прав",
          raw_data: licenseData,
        }),
      };
    }

    // Возврат успешного ответа
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        full_name: formattedData.full_name,
        license_number: formattedData.license_number,
      }),
    };
  } catch (error) {
    console.error("License function error:", error);
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



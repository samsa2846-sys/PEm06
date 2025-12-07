const axios = require("axios");

// ============================================================================
// КОНСТАНТЫ И КОНФИГУРАЦИЯ
// ============================================================================

const STT_ENDPOINT = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";
const GPT_ENDPOINT = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion";

// Лимиты размера аудио
const MIN_AUDIO_SIZE = 0; // Убрать минимальный лимит для совместимости
const MAX_AUDIO_SIZE = 4 * 1024 * 1024; // 4MB

// ============================================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================================

/**
 * Валидирует размер аудио файла
 * @param {Buffer} buffer - Буфер аудио
 * @throws {Error} Если размер не соответствует лимитам
 */
function validateAudio(buffer) {
  // Убрать проверку минимального размера для совместимости
  if (buffer.length > MAX_AUDIO_SIZE) {
    throw new Error(`Audio size must not exceed ${MAX_AUDIO_SIZE} bytes`);
  }
}

/**
 * Вызывает Yandex SpeechKit для распознавания речи
 * @param {Buffer} audioBuffer - Буфер аудио в формате OGG
 * @returns {Promise<string>} Распознанный текст
 * @throws {Error} При ошибке API
 */
async function callSpeechToText(audioBuffer) {
  const apiKey = process.env.YANDEX_SPEECHKIT_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  const url = `${STT_ENDPOINT}?lang=ru-RU&folderId=${folderId}`;
  const response = await axios.post(url, audioBuffer, {
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      "Content-Type": "audio/ogg",
      "Content-Length": audioBuffer.length,
    },
  });

  return response.data?.result || "";
}

/**
 * Вызывает Yandex GPT для извлечения структурированных данных
 * @param {string} text - Распознанный текст
 * @returns {Promise<Object>} Объект с bank_name и phone_number
 * @throws {Error} При ошибке API
 */
async function extractDataWithGPT(text) {
  const apiKey = process.env.YANDEX_GPT_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;

  const prompt = `Извлеки из текста:
1. Название банка (только официальное название, например: "Сбербанк", "Тинькофф", "ВТБ", "Альфа-Банк")
2. Номер телефона (ВСЕГДА возвращай ТОЛЬКО 10 цифр)

ВАЖНЫЕ ПРАВИЛА:
- Если номер начинается с +7, 7, 8 - убери этот префикс
- Удали ВСЕ нецифровые символы: скобки, пробелы, тире, плюсы
- Если в итоге получается 10 цифр - верни их
- Если не получается 10 цифр - верни null

Примеры преобразования:
"8(901)547-78-37" → "9015477837"
"+7 (926) 123-45-67" → "9261234567"
"8901547837" → "901547837"
"7-901-547-78-37" → "9015477837"

Текст: "${text}"

Верни ТОЛЬКО JSON:
{
  "bank_name": "название банка или 'не указано'",
  "phone_number": "10 цифр или null"
}`;

  const payload = {
    modelUri: `gpt://${folderId}/yandexgpt-lite`,
    completionOptions: {
      stream: false,
      temperature: 0.1,
      maxTokens: 200,
    },
    messages: [{ role: "user", text: prompt }],
  };

  try {
    const response = await axios.post(GPT_ENDPOINT, payload, {
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    const gptText = response.data?.result?.alternatives?.[0]?.message?.text || "";
    console.log("GPT ответ:", gptText);

    // Извлекаем JSON из ответа (как в старом коде)
    const start = gptText.indexOf("{");
    const end = gptText.lastIndexOf("}") + 1;
    if (start !== -1 && end > start) {
      const jsonStr = gptText.substring(start, end);
      return JSON.parse(jsonStr);
    } else {
      throw new Error("GPT не вернул JSON");
    }
  } catch (e) {
    console.error("Ошибка GPT:", e.message);
    throw e;
  }
}

/**
 * Улучшенная функция для извлечения 10 цифр телефона (точная копия старого кода)
 * @param {string} text - Текст для поиска номера
 * @returns {string|null} 10-значный номер или null
 */
function extractTenDigitPhone(text) {
  if (!text) return null;

  console.log("Извлекаем номер из текста:", text);

  // Удаляем всё, кроме цифр
  const digitsOnly = text.replace(/\D/g, "");
  console.log("Только цифры:", digitsOnly);

  // Случай 1: Ровно 10 цифр
  if (digitsOnly.length === 10) {
    return digitsOnly;
  }

  // Случай 2: 11 цифр, начинается с 7 или 8
  if (digitsOnly.length === 11 && (digitsOnly.startsWith("7") || digitsOnly.startsWith("8"))) {
    return digitsOnly.substring(1);
  }

  // Случай 3: 12 цифр, начинается с +7 (код страны)
  if (digitsOnly.length === 12 && digitsOnly.startsWith("7")) {
    // +79123456789 → 9123456789
    return digitsOnly.substring(2);
  }

  // Случай 4: Ищем 10 цифр в любой позиции
  const tenDigitMatch = digitsOnly.match(/(\d{10})/);
  if (tenDigitMatch) {
    return tenDigitMatch[1];
  }

  // Случай 5: Пробуем извлечь российский номер телефона
  // Паттерны для российских номеров
  const patterns = [
    // 8(901)547-78-37 → 9015477837
    /[78][\s(]*(\d{3})[\s)]*(\d{3})[\s-]*(\d{2})[\s-]*(\d{2})/,
    // 8901-547-78-37 → 9015477837
    /[78]?(\d{3})[\s-]*(\d{3})[\s-]*(\d{2})[\s-]*(\d{2})/,
    // 8 901 547 78 37 → 9015477837
    /[78]?\s*(\d{3})\s*(\d{3})\s*(\d{2})\s*(\d{2})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      // Берем все группы захвата и объединяем
      const groups = match.slice(1);
      if (groups.length === 4) {
        const number = groups.join("");
        if (number.length === 10) {
          console.log("Нашли номер по паттерну:", pattern, "→", number);
          return number;
        }
      }
    }
  }

  // Случай 6: Пробуем найти любые 10 последовательных цифр
  const anyTenDigits = text.match(/(\d{10})/);
  if (anyTenDigits) {
    return anyTenDigits[1];
  }

  console.log("Не удалось найти 10-значный номер");
  return null;
}

// ============================================================================
// ОСНОВНАЯ ФУНКЦИЯ
// ============================================================================

/**
 * Обработчик функции распознавания аудио
 * @param {Object} event - Событие от Yandex Cloud Functions
 * @param {Object} context - Контекст выполнения функции
 * @returns {Promise<Object>} HTTP ответ
 */
exports.handler = async function (event, context) {
  console.log("=== НАЧАЛО ОБРАБОТКИ ===");

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
    const audioBase64 = body.audio || body.audioBase64;
    if (!audioBase64) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: 'Audio data (base64) is required in "audio" field' }),
      };
    }

    // Декодирование base64
    let audioBuffer;
    try {
      audioBuffer = Buffer.from(audioBase64, "base64");
    } catch (err) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid base64 audio data" }),
      };
    }

    // Валидация размера
    try {
      validateAudio(audioBuffer);
    } catch (err) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Bad Request", message: err.message }),
      };
    }

    // 1. Распознавание речи через SpeechKit
    console.log("Распознаем речь через SpeechKit...");
    let rawText;
    try {
      rawText = await callSpeechToText(audioBuffer);
    } catch (err) {
      console.error("SpeechKit API error:", err);
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "SpeechKit API Error",
          message: `Failed to recognize speech: ${err.message}`,
        }),
      };
    }

    if (!rawText || !rawText.trim()) {
      return {
        statusCode: 422,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Speech could not be recognized" }),
      };
    }

    console.log("Распознанный текст:", rawText);

    // 2. Извлечение данных через GPT (как в старом коде)
    console.log("Извлекаем данные через GPT...");
    let extracted = null;
    let gptError = null;

    try {
      extracted = await extractDataWithGPT(rawText);
      console.log("GPT извлек данные:", extracted);
    } catch (error) {
      console.error("Ошибка GPT:", error.message);
      gptError = error.message;
      extracted = { bank_name: "не указано", phone_number: null };
    }

    // 3. Дополнительная проверка номера (fallback) - как в старом коде
    let finalPhoneNumber = extracted.phone_number;

    if (!finalPhoneNumber || finalPhoneNumber === "null") {
      console.log("GPT не извлек номер, пробуем fallback...");
      finalPhoneNumber = extractTenDigitPhone(rawText);
    } else {
      // Проверяем, что номер содержит 10 цифр
      const digitsOnly = finalPhoneNumber.replace(/\D/g, "");
      if (digitsOnly.length === 10) {
        finalPhoneNumber = digitsOnly;
      } else {
        console.log("GPT вернул некорректный номер, пробуем fallback...");
        finalPhoneNumber = extractTenDigitPhone(rawText);
      }
    }

    // 4. Подготовка ответа (точная копия старого кода)
    const response = {
      success: true,
      bank_name: extracted.bank_name || "не указано",
      phone_number: finalPhoneNumber,
      raw_text: rawText,
      processing_info: {
        gpt_used: extracted.phone_number !== null,
        gpt_error: gptError,
        fallback_used: finalPhoneNumber !== null && extracted.phone_number === null,
      },
    };

    console.log("Финальный ответ:", JSON.stringify(response, null, 2));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response),
    };
  } catch (error) {
    console.error("Общая ошибка:", error);
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

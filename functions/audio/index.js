const axios = require("axios");

const MIN_AUDIO_SIZE = 2 * 1024;
const MAX_AUDIO_SIZE = 4 * 1024 * 1024;
const STT_ENDPOINT =
  "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";
const GPT_ENDPOINT =
  "https://llm.api.cloud.yandex.net/foundationModels/v1/completion";

exports.handler = async function handler(event) {
  try {
    const body = parseBody(event);
    const audioBase64 = body.audioBase64;
    if (!audioBase64) {
      return httpResponse(400, { error: "Field audioBase64 is required" });
    }

    const buffer = Buffer.from(audioBase64, "base64");
    if (buffer.length < MIN_AUDIO_SIZE || buffer.length > MAX_AUDIO_SIZE) {
      return httpResponse(400, {
        error: "Audio size must be between 2KB and 4MB",
      });
    }

    const transcript = await runSpeechToText(buffer);
    if (!transcript.trim()) {
      return httpResponse(422, { error: "Speech could not be recognized" });
    }

    const structured = await extractStructuredData(transcript);
    if (!isValidPhone(structured.phoneNumber)) {
      structured.phoneNumber = fallbackPhone(transcript);
    }

    return httpResponse(200, { audioData: structured });
  } catch (error) {
    console.error("Audio function error:", error);
    return httpResponse(500, {
      error: "Internal server error",
      details: error.message,
    });
  }
};

function parseBody(event) {
  if (!event) {
    return {};
  }
  if (event.body) {
    try {
      return JSON.parse(event.body);
    } catch (err) {
      throw new Error("Invalid JSON body");
    }
  }
  return event;
}

async function runSpeechToText(buffer) {
  const apiKey = process.env.YANDEX_SPEECHKIT_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;
  if (!apiKey || !folderId) {
    throw new Error("Missing YANDEX_SPEECHKIT_API_KEY or YANDEX_FOLDER_ID");
  }

  const url = `${STT_ENDPOINT}?lang=ru-RU&folderId=${folderId}`;
  const response = await axios.post(url, buffer, {
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      "Content-Type": "audio/ogg; codecs=opus",
      "Transfer-Encoding": "chunked",
    },
  });

  return response.data?.result || "";
}

async function extractStructuredData(text) {
  const apiKey = process.env.YANDEX_GPT_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;
  if (!apiKey || !folderId) {
    throw new Error("Missing YANDEX_GPT_API_KEY or YANDEX_FOLDER_ID");
  }

  const prompt =
    "Ты выделяешь данные из текста звонка. Верни JSON с полями " +
    "bankName (официальное название банка или null) и " +
    "phoneNumber (строка из 10 цифр без префиксов или null). " +
    "Телефон: убери +7/7/8, очисти все пробелы и символы. " +
    "Если после очистки не осталось 10 цифр, верни null. " +
    "Не добавляй ничего кроме JSON.";

  const payload = {
    modelUri: `gpt://${folderId}/yandexgpt-lite`,
    completionOptions: { temperature: 0.1, maxTokens: 200 },
    messages: [
      { role: "system", text: prompt },
      { role: "user", text: `Текст клиента:\n${text}` },
    ],
  };

  const response = await axios.post(GPT_ENDPOINT, payload, {
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  const raw =
    response.data?.result?.alternatives?.[0]?.message?.text?.trim() || "{}";
  const json = extractJson(raw);
  const parsed = JSON.parse(json || "{}");

  return {
    bankName: parsed.bankName ?? null,
    phoneNumber: parsed.phoneNumber ?? null,
  };
}

function fallbackPhone(text) {
  const normalized = text.replace(/\D+/g, "");
  const matchStrict = normalized.match(/(?:7|8)?(\d{10})/);
  if (matchStrict) {
    return matchStrict[1];
  }

  const anyDigits = text.match(/\d{10}/);
  return anyDigits ? anyDigits[0] : null;
}

function isValidPhone(phone) {
  return typeof phone === "string" && /^\d{10}$/.test(phone);
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function httpResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}




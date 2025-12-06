const axios = require("axios");

const MIN_IMAGE_SIZE = 10 * 1024;
const MAX_IMAGE_SIZE = 4 * 1024 * 1024;

const VISION_ENDPOINT =
  "https://vision.api.cloud.yandex.net/vision/v1/batchAnalyze";
const GPT_ENDPOINT =
  "https://llm.api.cloud.yandex.net/foundationModels/v1/completion";

const FORMAT_SIGNATURES = [
  { mime: "image/jpeg", signature: [0xff, 0xd8, 0xff] },
  { mime: "image/png", signature: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/gif", signature: [0x47, 0x49, 0x46, 0x38] },
];

exports.handler = async function handler(event) {
  try {
    const body = parseBody(event);
    const imageBase64 = body.imageBase64;
    if (!imageBase64) {
      return httpResponse(400, { error: "Field imageBase64 is required" });
    }

    const buffer = Buffer.from(imageBase64, "base64");
    if (buffer.length < MIN_IMAGE_SIZE || buffer.length > MAX_IMAGE_SIZE) {
      return httpResponse(400, {
        error: "Image size must be between 10KB and 4MB",
      });
    }

    const mimeType = detectMime(buffer);
    if (!mimeType) {
      return httpResponse(415, { error: "Unsupported image format" });
    }

    const text = await runVision(buffer, mimeType);
    if (!text.trim()) {
      return httpResponse(422, { error: "No text detected in image" });
    }

    const passportData = await runGpt(text);
    return httpResponse(200, { passportData });
  } catch (error) {
    console.error("Passport function error:", error);
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

function detectMime(buffer) {
  return FORMAT_SIGNATURES.find(({ signature }) =>
    signature.every((value, index) => buffer[index] === value)
  )?.mime;
}

async function runVision(buffer, mimeType) {
  const apiKey = process.env.YANDEX_VISION_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;
  if (!apiKey || !folderId) {
    throw new Error("Missing YANDEX_VISION_API_KEY or YANDEX_FOLDER_ID");
  }

  const payload = {
    folderId,
    analyzeSpecs: [
      {
        content: buffer.toString("base64"),
        features: [
          {
            type: "TEXT_DETECTION",
            textDetectionConfig: {
              languageCodes: ["ru"],
            },
          },
        ],
      },
    ],
  };

  const response = await axios.post(VISION_ENDPOINT, payload, {
    headers: {
      Authorization: `Api-Key ${apiKey}`,
    },
  });

  const texts = [];
  const results = response.data?.results || [];
  results.forEach((result) => {
    result.textAnnotation?.pages?.forEach((page) => {
      page.blocks?.forEach((block) => {
        block.lines?.forEach((line) => {
          const lineText = line.words
            ?.map((word) => word.text)
            .filter(Boolean)
            .join(" ");
          if (lineText) {
            texts.push(lineText);
          }
        });
      });
    });
  });

  return texts.join("\n");
}

async function runGpt(text) {
  const apiKey = process.env.YANDEX_GPT_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;
  if (!apiKey || !folderId) {
    throw new Error("Missing YANDEX_GPT_API_KEY or YANDEX_FOLDER_ID");
  }

  const prompt =
    "Ты помощник, который строго извлекает данные паспорта гражданина РФ. " +
    "Верни только JSON со следующими полями: " +
    "fullName (строка в формате 'Фамилия Имя Отчество'), " +
    "lastName, firstName, middleName, birthDate (ДД.ММ.ГГГГ), " +
    "birthPlace, passportNumber (ровно 10 цифр), citizenship. " +
    "Если данных не хватает, используй null. " +
    "Не добавляй пояснений, только JSON.";

  const payload = {
    modelUri: `gpt://${folderId}/yandexgpt-lite`,
    completionOptions: {
      temperature: 0.1,
      maxTokens: 400,
    },
    messages: [
      { role: "system", text: prompt },
      { role: "user", text: `Исходный текст паспорта:\n${text}` },
    ],
  };

  const response = await axios.post(GPT_ENDPOINT, payload, {
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  const messageText =
    response.data?.result?.alternatives?.[0]?.message?.text || "";
  const jsonString = extractJson(messageText);
  if (!jsonString) {
    throw new Error("Не удалось извлечь JSON из ответа GPT");
  }
  const parsed = JSON.parse(jsonString);
  validatePassportData(parsed);
  return parsed;
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function validatePassportData(data) {
  const required = [
    "fullName",
    "lastName",
    "firstName",
    "birthDate",
    "birthPlace",
    "passportNumber",
    "citizenship",
  ];
  required.forEach((field) => {
    if (typeof data[field] === "undefined") {
      throw new Error(`Missing field in passport data: ${field}`);
    }
  });
  if (
    data.passportNumber &&
    typeof data.passportNumber === "string" &&
    !/^\d{10}$/.test(data.passportNumber)
  ) {
    throw new Error("passportNumber must contain exactly 10 digits");
  }
}

function httpResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}




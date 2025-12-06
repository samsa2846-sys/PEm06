import base64
import json
import logging
from datetime import datetime, timezone
from io import BytesIO
from typing import Any, Dict, Optional

import requests
from telegram import ParseMode, Update
from telegram.ext import (
    CallbackContext,
    CommandHandler,
    Filters,
    MessageHandler,
    Updater,
)

from config import BotConfig

STATE_AWAITING_PASSPORT = "awaiting_passport"
STATE_AWAITING_AUDIO = "awaiting_audio"

Session = Dict[str, Any]
sessions: Dict[int, Session] = {}


def get_session(user_id: int) -> Optional[Session]:
    return sessions.get(user_id)


def reset_session(user_id: int) -> Session:
    session = {"state": STATE_AWAITING_PASSPORT, "passport_data": None}
    sessions[user_id] = session
    return session


def handle_start(update: Update, context: CallbackContext) -> None:
    user_id = update.effective_user.id
    reset_session(user_id)
    update.message.reply_text(
        "🔄 Начинаем новую сессию распознавания.\n"
        "1️⃣ Отправьте чёткое фото страницы паспорта (JPEG/PNG/GIF).\n"
        "2️⃣ После успешного распознавания пришлите голосовое сообщение "
        "с номером телефона и названием банка.\n"
        "Для отмены используйте /cancel, для статуса — /status."
    )


def handle_status(update: Update, context: CallbackContext) -> None:
    user_id = update.effective_user.id
    session = get_session(user_id)
    if not session:
        update.message.reply_text("ℹ️ Нет активной сессии. Используйте /start.")
        return

    state = session["state"]
    if state == STATE_AWAITING_PASSPORT:
        update.message.reply_text("🖼 Ожидаю фото паспорта.")
    elif state == STATE_AWAITING_AUDIO and session.get("passport_data"):
        fio = session["passport_data"].get("fullName")
        update.message.reply_text(
            f"✅ Паспорт распознан. ФИО: {fio or 'неизвестно'}. "
            "Теперь пришлите голосовое сообщение."
        )
    else:
        update.message.reply_text("ℹ️ Состояние не определено. Перезапустите /start.")


def handle_cancel(update: Update, context: CallbackContext) -> None:
    user_id = update.effective_user.id
    sessions.pop(user_id, None)
    update.message.reply_text("❌ Сессия очищена. Используйте /start для новой попытки.")


def handle_photo(update: Update, context: CallbackContext) -> None:
    user_id = update.effective_user.id
    session = get_session(user_id)
    if not session or session["state"] != STATE_AWAITING_PASSPORT:
        update.message.reply_text(
            "⚠️ Сейчас ожидается голосовое сообщение или нет активной сессии.\n"
            "Используйте /start, чтобы начать заново."
        )
        return

    photo = update.message.photo[-1]
    telegram_file = context.bot.get_file(photo.file_id)
    file_bytes = BytesIO()
    telegram_file.download(out=file_bytes)
    encoded_image = base64.b64encode(file_bytes.getvalue()).decode("utf-8")

    update.message.reply_text("⌛ Распознаю паспорт, пожалуйста подождите...")
    config: BotConfig = context.bot_data["config"]

    try:
        response = requests.post(
            config.passport_url,
            json={"imageBase64": encoded_image},
            timeout=45,
        )
        response.raise_for_status()
        payload = response.json()
        passport_data = payload.get("passportData", payload)
    except requests.RequestException as exc:
        logging.exception("Passport function request failed")
        update.message.reply_text(
            "❌ Не удалось обработать изображение. Попробуйте снова позже."
        )
        return
    except ValueError:
        logging.exception("Passport function returned invalid JSON")
        update.message.reply_text(
            "❌ Сервис распознавания вернул некорректный ответ. Попробуйте позже."
        )
        return

    session["state"] = STATE_AWAITING_AUDIO
    session["passport_data"] = passport_data

    pretty = json.dumps(passport_data, ensure_ascii=False, indent=2)
    update.message.reply_text(
        f"✅ Паспорт распознан:\n```json\n{pretty}\n```\n"
        "Теперь отправьте голосовое сообщение с номером телефона и банком.",
        parse_mode=ParseMode.MARKDOWN,
    )


def handle_voice(update: Update, context: CallbackContext) -> None:
    user_id = update.effective_user.id
    session = get_session(user_id)
    if not session or session["state"] != STATE_AWAITING_AUDIO or not session.get(
        "passport_data"
    ):
        update.message.reply_text(
            "⚠️ Сперва нужно отправить фото паспорта. Используйте /start."
        )
        return

    voice = update.message.voice
    telegram_file = context.bot.get_file(voice.file_id)
    file_bytes = BytesIO()
    telegram_file.download(out=file_bytes)
    encoded_audio = base64.b64encode(file_bytes.getvalue()).decode("utf-8")

    update.message.reply_text("⌛ Обрабатываю голосовое сообщение...")
    config: BotConfig = context.bot_data["config"]

    try:
        response = requests.post(
            config.audio_url,
            json={"audioBase64": encoded_audio},
            timeout=60,
        )
        response.raise_for_status()
        payload = response.json()
        audio_data = payload.get("audioData", payload)
    except requests.RequestException:
        logging.exception("Audio function request failed")
        update.message.reply_text("❌ Не удалось обработать голос. Попробуйте позже.")
        return
    except ValueError:
        logging.exception("Audio function returned invalid JSON")
        update.message.reply_text(
            "❌ Сервис аудио распознавания вернул неверный формат."
        )
        return

    result = {
        "userId": user_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "passportData": session["passport_data"],
        "audioData": audio_data,
    }

    pretty = json.dumps(result, ensure_ascii=False, indent=2)
    update.message.reply_text(
        f"🎉 Готово! Итоговый JSON:\n```json\n{pretty}\n```",
        parse_mode=ParseMode.MARKDOWN,
    )
    sessions.pop(user_id, None)


def handle_text(update: Update, context: CallbackContext) -> None:
    update.message.reply_text(
        "ℹ️ Используйте последовательность: /start → фото паспорта → голосовое сообщение.\n"
        "Команды: /status для проверки этапа, /cancel для сброса."
    )


def error_handler(update: object, context: CallbackContext) -> None:
    logging.exception("Unhandled error while processing update: %s", update)


def main() -> None:
    config = BotConfig.from_env()
    logging.basicConfig(
        level=getattr(logging, config.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    )
    logging.info("Passport bot starting. Commands: /start, /status, /cancel")

    updater = Updater(config.telegram_token, use_context=True)
    dispatcher = updater.dispatcher
    dispatcher.bot_data["config"] = config

    dispatcher.add_handler(CommandHandler("start", handle_start))
    dispatcher.add_handler(CommandHandler("status", handle_status))
    dispatcher.add_handler(CommandHandler("cancel", handle_cancel))
    dispatcher.add_handler(MessageHandler(Filters.photo, handle_photo))
    dispatcher.add_handler(MessageHandler(Filters.voice, handle_voice))
    dispatcher.add_handler(MessageHandler(Filters.text & ~Filters.command, handle_text))
    dispatcher.add_error_handler(error_handler)

    updater.start_polling()
    updater.idle()


if __name__ == "__main__":
    main()


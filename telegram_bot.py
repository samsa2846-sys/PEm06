import os
import json
import base64
import logging
import re
from typing import Dict, Any
from datetime import datetime, timezone

import requests
from telegram import Update, ParseMode
from telegram.ext import (
    Updater,
    CommandHandler,
    MessageHandler,
    Filters,
    CallbackContext,
)

# ============================================================================
# КОНФИГУРАЦИЯ
# ============================================================================

# Чтение из переменных окружения или прямое задание
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "8054985033:")
PASSPORT_FUNCTION_URL = os.getenv("PASSPORT_FUNCTION_URL", "https://functions.yandexcloud.net/999")
AUDIO_FUNCTION_URL = os.getenv("AUDIO_FUNCTION_URL", "https://functions.yandexcloud.net/999")

# ============================================================================
# ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ
# ============================================================================

# Хранилище сессий
user_sessions: Dict[int, Dict[str, Any]] = {}

# Состояния сессий
STATE_AWAITING_PASSPORT = "awaiting_passport"
STATE_AWAITING_AUDIO = "awaiting_audio"

# ============================================================================
# ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
# ============================================================================

def get_session(user_id: int) -> Dict[str, Any]:
    """Получить сессию пользователя"""
    return user_sessions.get(user_id)


def reset_session(user_id: int) -> Dict[str, Any]:
    """Сбросить сессию пользователя"""
    session = {
        "step": STATE_AWAITING_PASSPORT,
        "passport_data": None,
    }
    user_sessions[user_id] = session
    return session


def normalize_phone_number(phone_number: Any) -> str:
    """Нормализация номера телефона (важная логика из старого кода)"""
    if not phone_number:
        return ""
    
    # Извлекаем только цифры
    digits_only = re.sub(r'\D', '', str(phone_number))
    
    # Если 11 цифр и начинается с 7 или 8 - убираем первую цифру
    if len(digits_only) == 11 and digits_only.startswith(('7', '8')):
        return digits_only[1:]
    elif len(digits_only) == 10:
        return digits_only
    else:
        return digits_only


def format_full_name(passport_data: Dict[str, Any]) -> str:
    """Формирование полного имени из данных паспорта"""
    last_name = passport_data.get("last_name", "")
    first_name = passport_data.get("first_name", "")
    middle_name = passport_data.get("middle_name", "")
    
    parts = [part for part in [last_name, first_name, middle_name] if part]
    return " ".join(parts) if parts else "неизвестно"


# ============================================================================
# ОБРАБОТЧИКИ КОМАНД
# ============================================================================

def start_command(update: Update, context: CallbackContext) -> None:
    """Обработчик команды /start"""
    user_id = update.effective_user.id
    reset_session(user_id)
    
    update.message.reply_text(
        "🔄 Начинаем новую сессию распознавания.\n"
        "1️⃣ Отправьте чёткое фото страницы паспорта (JPEG/PNG/GIF).\n"
        "2️⃣ После успешного распознавания пришлите голосовое сообщение "
        "с номером телефона и названием банка.\n"
        "Для отмены используйте /cancel, для статуса — /status."
    )


def cancel_command(update: Update, context: CallbackContext) -> None:
    """Обработчик команды /cancel"""
    user_id = update.effective_user.id
    user_sessions.pop(user_id, None)
    update.message.reply_text("❌ Сессия очищена. Используйте /start для новой попытки.")


def status_command(update: Update, context: CallbackContext) -> None:
    """Обработчик команды /status"""
    user_id = update.effective_user.id
    session = get_session(user_id)
    
    if not session:
        update.message.reply_text("ℹ️ Нет активной сессии. Используйте /start.")
        return
    
    step = session.get("step")
    if step == STATE_AWAITING_PASSPORT:
        update.message.reply_text("🖼 Ожидаю фото паспорта.")
    elif step == STATE_AWAITING_AUDIO and session.get("passport_data"):
        full_name = format_full_name(session["passport_data"])
        update.message.reply_text(
            f"✅ Паспорт распознан. ФИО: {full_name}. "
            "Теперь пришлите голосовое сообщение."
        )
    else:
        update.message.reply_text("ℹ️ Состояние не определено. Перезапустите /start.")


# ============================================================================
# ОБРАБОТЧИКИ СООБЩЕНИЙ
# ============================================================================

def handle_photo(update: Update, context: CallbackContext) -> None:
    """Обработчик фото паспорта"""
    user_id = update.effective_user.id
    session = get_session(user_id)
    
    if not session or session.get("step") != STATE_AWAITING_PASSPORT:
        update.message.reply_text(
            "⚠️ Сейчас ожидается голосовое сообщение или нет активной сессии.\n"
            "Используйте /start, чтобы начать заново."
        )
        return
    
    # Получаем фото (берем самое большое)
    photo_file = update.message.photo[-1].get_file()
    photo_bytes = photo_file.download_as_bytearray()
    image_base64 = base64.b64encode(bytes(photo_bytes)).decode('utf-8')
    
    update.message.reply_text("⌛ Распознаю паспорт, пожалуйста подождите...")
    
    try:
        # Отправляем запрос с полем "image" (не "imageBase64")
        response = requests.post(
            PASSPORT_FUNCTION_URL,
            json={"image": image_base64},
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        
        # Обрабатываем ответ в новом формате
        if not payload.get("success"):
            # Обработка ошибки
            error_msg = payload.get("error") or payload.get("message", "Unknown error")
            update.message.reply_text(f"❌ Ошибка распознавания: {error_msg}")
            return
        
        # Новый формат: success, last_name, first_name, middle_name и т.д.
        passport_data = {
            "last_name": payload.get("last_name", ""),
            "first_name": payload.get("first_name", ""),
            "middle_name": payload.get("middle_name", ""),
            "birth_date": payload.get("birth_date", ""),
            "birth_place": payload.get("birth_place", ""),
            "passport_number": payload.get("passport_number", ""),
            "citizenship": payload.get("citizenship", ""),
        }
        # Формируем full_name для совместимости
        passport_data["full_name"] = format_full_name(passport_data)
            
    except requests.RequestException as exc:
        logging.exception("Passport function request failed")
        update.message.reply_text(
            "❌ Не удалось обработать изображение. Попробуйте снова позже."
        )
        return
    except (ValueError, KeyError) as exc:
        logging.exception("Passport function returned invalid response")
        update.message.reply_text(
            "❌ Сервис распознавания вернул некорректный ответ. Попробуйте позже."
        )
        return
    
    # Сохраняем данные и переходим к следующему шагу
    session["step"] = STATE_AWAITING_AUDIO
    session["passport_data"] = passport_data
    
    # Форматируем ответ для пользователя
    pretty = json.dumps(passport_data, ensure_ascii=False, indent=2)
    update.message.reply_text(
        f"✅ Паспорт распознан:\n```json\n{pretty}\n```\n"
        "Теперь отправьте голосовое сообщение с номером телефона и банком.",
        parse_mode=ParseMode.MARKDOWN,
    )


def handle_voice(update: Update, context: CallbackContext) -> None:
    """Обработчик голосовых сообщений"""
    user_id = update.effective_user.id
    session = get_session(user_id)
    
    if not session or session.get("step") != STATE_AWAITING_AUDIO or not session.get("passport_data"):
        update.message.reply_text(
            "⚠️ Сперва нужно отправить фото паспорта. Используйте /start."
        )
        return
    
    # Получаем голосовое сообщение
    voice_file = update.message.voice.get_file()
    audio_bytes = voice_file.download_as_bytearray()
    audio_base64 = base64.b64encode(bytes(audio_bytes)).decode('utf-8')
    
    update.message.reply_text("⌛ Обрабатываю голосовое сообщение...")
    
    try:
        # Отправляем запрос с полем "audio" (не "audioBase64")
        response = requests.post(
            AUDIO_FUNCTION_URL,
            json={"audio": audio_base64},
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        
        # Обрабатываем ответ в новом формате
        if not payload.get("success"):
            # Обработка ошибки
            error_msg = payload.get("error") or payload.get("message", "Unknown error")
            update.message.reply_text(f"❌ Ошибка обработки аудио: {error_msg}")
            return
        
        bank_name = payload.get("bank_name", "не указано")
        phone_number = payload.get("phone_number", "")
        raw_text = payload.get("raw_text", "")
        processing_info = payload.get("processing_info", {})
        
        # Нормализация телефона (важная логика из старого кода)
        phone_number = normalize_phone_number(phone_number)
            
    except requests.RequestException:
        logging.exception("Audio function request failed")
        update.message.reply_text("❌ Не удалось обработать голос. Попробуйте позже.")
        return
    except (ValueError, KeyError):
        logging.exception("Audio function returned invalid response")
        update.message.reply_text(
            "❌ Сервис аудио распознавания вернул неверный формат."
        )
        return
    
    # Формируем финальный результат
    passport_data = session["passport_data"]
    final_result = {
        "full_name": passport_data.get("full_name", ""),
        "passport_number": passport_data.get("passport_number", ""),
        "bank_name": bank_name,
        "phone_number": phone_number
    }
    
    # Форматируем и отправляем результат
    pretty = json.dumps(final_result, ensure_ascii=False, indent=2)
    update.message.reply_text(
        f"🎉 Готово! Итоговый JSON:\n```json\n{pretty}\n```",
        parse_mode=ParseMode.MARKDOWN,
    )
    
    # Очищаем сессию
    user_sessions.pop(user_id, None)


def handle_text(update: Update, context: CallbackContext) -> None:
    """Обработчик текстовых сообщений"""
    update.message.reply_text(
        "ℹ️ Используйте последовательность: /start → фото паспорта → голосовое сообщение.\n"
        "Команды: /status для проверки этапа, /cancel для сброса."
    )


def error_handler(update: object, context: CallbackContext) -> None:
    """Обработчик ошибок"""
    logging.exception("Unhandled error while processing update: %s", update)


# ============================================================================
# ОСНОВНАЯ ФУНКЦИЯ
# ============================================================================

def main() -> None:
    """Основная функция запуска бота"""
    # Настройка логирования
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    
    # Создаем updater
    updater = Updater(TELEGRAM_BOT_TOKEN, use_context=True)
    
    # Получаем диспетчер
    dispatcher = updater.dispatcher
    
    # Регистрируем обработчики команд
    dispatcher.add_handler(CommandHandler("start", start_command))
    dispatcher.add_handler(CommandHandler("cancel", cancel_command))
    dispatcher.add_handler(CommandHandler("status", status_command))
    
    # Регистрируем обработчики сообщений
    dispatcher.add_handler(MessageHandler(Filters.photo, handle_photo))
    dispatcher.add_handler(MessageHandler(Filters.voice, handle_voice))
    dispatcher.add_handler(MessageHandler(Filters.text & ~Filters.command, handle_text))
    
    # Регистрируем обработчик ошибок
    dispatcher.add_error_handler(error_handler)
    
    # Выводим информацию о запуске
    print("=" * 60)
    print("🤖 БОТ ДЛЯ РАСПОЗНАВАНИЯ ПАСПОРТА И АУДИО")
    print("=" * 60)
    print(f"📋 Команды: /start, /status, /cancel")
    print(f"🔗 Passport Function: {PASSPORT_FUNCTION_URL}")
    print(f"🔗 Audio Function: {AUDIO_FUNCTION_URL}")
    print("=" * 60)
    print("✅ Бот запущен и готов к работе!")
    print("=" * 60)
    
    # Запускаем бота
    updater.start_polling()
    updater.idle()


if __name__ == "__main__":
    main()


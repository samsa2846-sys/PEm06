import os
import json
import base64
import logging
import re
from typing import Dict, Any, List
from datetime import datetime, timezone

import requests
from telegram import Update, ParseMode, ReplyKeyboardMarkup, KeyboardButton, ReplyKeyboardRemove
from telegram.ext import (
    Updater,
    CommandHandler,
    MessageHandler,
    Filters,
    CallbackContext,
    ConversationHandler,
)

# ============================================================================
# КОНФИГУРАЦИЯ
# ============================================================================

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "8054985033:")
PASSPORT_FUNCTION_URL = os.getenv("PASSPORT_FUNCTION_URL", "https://functions.yandexcloud.net/999")
LICENSE_FUNCTION_URL = os.getenv("LICENSE_FUNCTION_URL", "https://functions.yandexcloud.net/999")
PATENT_FUNCTION_URL = os.getenv("PATENT_FUNCTION_URL", "https://functions.yandexcloud.net/999")
AUDIO_FUNCTION_URL = os.getenv("AUDIO_FUNCTION_URL", "https://functions.yandexcloud.net/999")

# ============================================================================
# КОНСТАНТЫ И СОСТОЯНИЯ
# ============================================================================

# Типы документов
DOCUMENT_PASSPORT = "passport"
DOCUMENT_LICENSE = "license"
DOCUMENT_PATENT = "patent"

# Состояния
(
    SELECTING_ACTION,
    TAKING_PASSPORT_PHOTO,
    TAKING_LICENSE_FRONT,
    TAKING_LICENSE_BACK,
    TAKING_PATENT_PHOTO,
    TAKING_VOICE,
    SHOWING_RESULTS,
) = range(7)

# Кнопки меню
MAIN_MENU_KEYBOARD = [
    ["📄 Паспорт", "🚗 Водительские права"],
    ["📋 Патент на работу", "❌ Отмена"],
]

# ============================================================================
# ХРАНИЛИЩЕ СЕССИЙ
# ============================================================================

user_sessions: Dict[int, Dict[str, Any]] = {}

# ============================================================================
# ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
# ============================================================================

def get_session(user_id: int) -> Dict[str, Any]:
    """Получить сессию пользователя"""
    return user_sessions.get(user_id)


def create_session(user_id: int) -> Dict[str, Any]:
    """Создать новую сессию"""
    session = {
        "document_type": None,
        "document_data": None,
        "photos": [],
        "state": SELECTING_ACTION,
    }
    user_sessions[user_id] = session
    return session


def end_session(user_id: int) -> None:
    """Завершить сессию пользователя"""
    user_sessions.pop(user_id, None)


def normalize_phone_number(phone_number: Any) -> str:
    """Нормализация номера телефона"""
    if not phone_number:
        return ""
    digits_only = re.sub(r'\D', '', str(phone_number))
    if len(digits_only) == 11 and digits_only.startswith(('7', '8')):
        return digits_only[1:]
    elif len(digits_only) == 10:
        return digits_only
    else:
        return digits_only


def format_passport_name(passport_data: Dict[str, Any]) -> str:
    """Формирование полного имени из данных паспорта"""
    last_name = passport_data.get("last_name", "")
    first_name = passport_data.get("first_name", "")
    middle_name = passport_data.get("middle_name", "")
    parts = [part for part in [last_name, first_name, middle_name] if part]
    return " ".join(parts) if parts else ""


def get_document_number(document_data: Dict[str, Any], doc_type: str) -> str:
    """Получить номер документа в зависимости от типа"""
    if doc_type == DOCUMENT_PASSPORT:
        return document_data.get("passport_number", "")
    elif doc_type == DOCUMENT_LICENSE:
        return document_data.get("license_number", "")
    elif doc_type == DOCUMENT_PATENT:
        return document_data.get("document_number", "")
    return ""


def get_full_name(document_data: Dict[str, Any], doc_type: str) -> str:
    """Получить полное имя в зависимости от типа документа"""
    if doc_type == DOCUMENT_PASSPORT:
        return format_passport_name(document_data)
    elif doc_type == DOCUMENT_LICENSE:
        return document_data.get("full_name", "")
    elif doc_type == DOCUMENT_PATENT:
        return document_data.get("full_name", "")
    return ""


def show_main_menu(update: Update, context: CallbackContext) -> int:
    """Показать главное меню"""
    reply_markup = ReplyKeyboardMarkup(MAIN_MENU_KEYBOARD, resize_keyboard=True)
    if update.message:
        update.message.reply_text(
            "👋 Добро пожаловать!\n"
            "📋 Выберите тип документа для распознавания:",
            reply_markup=reply_markup
        )
    else:
        update.callback_query.message.reply_text(
            "📋 Выберите тип документа для распознавания:",
            reply_markup=reply_markup
        )
    return SELECTING_ACTION


# ============================================================================
# ОБРАБОТЧИКИ КОМАНД
# ============================================================================

def start_command(update: Update, context: CallbackContext) -> int:
    """Обработчик команды /start"""
    user_id = update.effective_user.id
    create_session(user_id)
    return show_main_menu(update, context)


def cancel_command(update: Update, context: CallbackContext) -> int:
    """Обработчик команды /cancel"""
    user_id = update.effective_user.id
    end_session(user_id)
    update.message.reply_text(
        "❌ Действие отменено.",
        reply_markup=ReplyKeyboardRemove()
    )
    return ConversationHandler.END


def back_to_menu(update: Update, context: CallbackContext) -> int:
    """Вернуться в главное меню"""
    user_id = update.effective_user.id
    end_session(user_id)
    create_session(user_id)
    return show_main_menu(update, context)


# ============================================================================
# ОБРАБОТЧИКИ КНОПОК
# ============================================================================

def handle_main_menu_selection(update: Update, context: CallbackContext) -> int:
    """Обработка выбора в главном меню"""
    user_id = update.effective_user.id
    session = get_session(user_id)
    if not session:
        session = create_session(user_id)
    text = update.message.text

    if text == "📄 Паспорт":
        session["document_type"] = DOCUMENT_PASSPORT
        reply_markup = ReplyKeyboardMarkup([["📷 Сделать фото", "↪️ Назад в меню"]], resize_keyboard=True)
        update.message.reply_text(
            "📄 РАСПОЗНАВАНИЕ ПАСПОРТА\n"
            "1. Сделайте четкое фото страницы паспорта\n"
            "2. Отправьте голосовое сообщение с номером телефона и банком\n"
            "Нажмите '📷 Сделать фото' чтобы начать:",
            reply_markup=reply_markup
        )
        return TAKING_PASSPORT_PHOTO

    elif text == "🚗 Водительские права":
        session["document_type"] = DOCUMENT_LICENSE
        reply_markup = ReplyKeyboardMarkup([["📷 Сделать фото", "↪️ Назад в меню"]], resize_keyboard=True)
        update.message.reply_text(
            "🚗 РАСПОЗНАВАНИЕ ВОДИТЕЛЬСКИХ ПРАВ\n"
            "Нужно отправить ДВА фото:\n"
            "1. Лицевая сторона прав\n"
            "2. Обратная сторона прав\n"
            "Затем отправьте голосовое сообщение с номером телефона и банком\n"
            "Нажмите '📷 Сделать фото' чтобы начать:",
            reply_markup=reply_markup
        )
        return TAKING_LICENSE_FRONT

    elif text == "📋 Патент на работу":
        session["document_type"] = DOCUMENT_PATENT
        reply_markup = ReplyKeyboardMarkup([["📷 Сделать фото", "↪️ Назад в меню"]], resize_keyboard=True)
        update.message.reply_text(
            "📋 РАСПОЗНАВАНИЕ ПАТЕНТА НА РАБОТУ\n"
            "1. Сделайте фото патента\n"
            "2. Отправьте голосовое сообщение с номером телефона и банком\n"
            "Нажмите '📷 Сделать фото' чтобы начать:",
            reply_markup=reply_markup
        )
        return TAKING_PATENT_PHOTO

    elif text == "❌ Отмена":
        return cancel_command(update, context)

    else:
        update.message.reply_text("Пожалуйста, используйте кнопки меню.")
        return SELECTING_ACTION


def handle_document_menu_selection(update: Update, context: CallbackContext) -> int:
    """Обработка выбора в меню документа"""
    text = update.message.text
    if text == "↪️ Назад в меню":
        return back_to_menu(update, context)
    elif text == "📷 Сделать фото":
        # Состояние уже установлено, просто просим отправить фото
        update.message.reply_text("Пожалуйста, отправьте фото документа:")
        return context.user_data.get('current_state', SELECTING_ACTION)
    return SELECTING_ACTION


# ============================================================================
# ОБРАБОТЧИКИ ФОТО И ГОЛОСОВЫХ
# ============================================================================

def handle_photo(update: Update, context: CallbackContext) -> int:
    """Обработчик фото документов"""
    user_id = update.effective_user.id
    session = get_session(user_id)
    if not session:
        update.message.reply_text("Сессия не найдена. Начните с /start")
        return show_main_menu(update, context)

    doc_type = session.get("document_type")

    # Получаем фото
    photo_file = update.message.photo[-1].get_file()
    photo_bytes = photo_file.download_as_bytearray()
    image_base64 = base64.b64encode(bytes(photo_bytes)).decode('utf-8')

    if doc_type == DOCUMENT_PASSPORT:
        return handle_passport_photo(update, context, session, image_base64)
    elif doc_type == DOCUMENT_LICENSE:
        return handle_license_photo(update, context, session, image_base64)
    elif doc_type == DOCUMENT_PATENT:
        return handle_patent_photo(update, context, session, image_base64)

    return SELECTING_ACTION


def handle_passport_photo(update: Update, context: CallbackContext, session: Dict[str, Any], image_base64: str) -> int:
    """Обработка фото паспорта"""
    update.message.reply_text("⌛ Распознаю паспорт...")

    try:
        response = requests.post(
            PASSPORT_FUNCTION_URL,
            json={"image": image_base64},
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()

        if not payload.get("success"):
            error_msg = payload.get("error") or payload.get("message", "Unknown error")
            update.message.reply_text(f"❌ Ошибка: {error_msg}")
            reply_markup = ReplyKeyboardMarkup([["📷 Сделать фото", "↪️ Назад в меню"]], resize_keyboard=True)
            update.message.reply_text("Попробуйте снова:", reply_markup=reply_markup)
            return TAKING_PASSPORT_PHOTO

        # Сохраняем данные
        session["document_data"] = {
            "last_name": payload.get("last_name", ""),
            "first_name": payload.get("first_name", ""),
            "middle_name": payload.get("middle_name", ""),
            "passport_number": payload.get("passport_number", ""),
        }

        # Показываем результат
        full_name = format_passport_name(session["document_data"])
        passport_number = session["document_data"].get("passport_number", "")
        reply_markup = ReplyKeyboardMarkup([["🎤 Отправить голосовое", "↪️ Назад в меню"]], resize_keyboard=True)
        update.message.reply_text(
            f"✅ Паспорт распознан!\n"
            f"👤 ФИО: {full_name}\n"
            f"📇 Номер: {passport_number}\n"
            f"Теперь отправьте голосовое сообщение с номером телефона и банком:",
            reply_markup=reply_markup
        )

        return TAKING_VOICE

    except Exception as e:
        logging.exception("Error processing passport")
        reply_markup = ReplyKeyboardMarkup([["📷 Сделать фото", "↪️ Назад в меню"]], resize_keyboard=True)
        update.message.reply_text(
            f"❌ Ошибка: {str(e)}\nПопробуйте снова:",
            reply_markup=reply_markup
        )
        return TAKING_PASSPORT_PHOTO


def handle_license_photo(update: Update, context: CallbackContext, session: Dict[str, Any], image_base64: str) -> int:
    """Обработка фото прав"""
    # Добавляем фото в список
    session.setdefault("photos", []).append(image_base64)

    if len(session["photos"]) == 1:
        # Первое фото - лицевая сторона
        reply_markup = ReplyKeyboardMarkup([["📷 Сделать фото", "↪️ Назад в меню"]], resize_keyboard=True)
        update.message.reply_text(
            "✅ Лицевая сторона получена.\n"
            "Теперь отправьте фото ОБРАТНОЙ стороны прав:",
            reply_markup=reply_markup
        )
        return TAKING_LICENSE_BACK

    elif len(session["photos"]) == 2:
        # Второе фото - обратная сторона
        update.message.reply_text("⌛ Распознаю водительские права...")

        try:
            response = requests.post(
                LICENSE_FUNCTION_URL,
                json={
                    "front_image": session["photos"][0],
                    "back_image": session["photos"][1]
                },
                timeout=30,
            )
            response.raise_for_status()
            payload = response.json()

            if not payload.get("success"):
                error_msg = payload.get("error") or payload.get("message", "Unknown error")
                update.message.reply_text(f"❌ Ошибка: {error_msg}")
                session["photos"] = []  # Сбрасываем фото
                reply_markup = ReplyKeyboardMarkup([["📷 Сделать фото", "↪️ Назад в меню"]], resize_keyboard=True)
                update.message.reply_text("Попробуйте снова:", reply_markup=reply_markup)
                return TAKING_LICENSE_FRONT

            # Сохраняем данные
            session["document_data"] = {
                "full_name": payload.get("full_name", ""),
                "license_number": payload.get("license_number", ""),
            }

            # Показываем результат
            full_name = session["document_data"].get("full_name", "")
            license_number = session["document_data"].get("license_number", "")
            reply_markup = ReplyKeyboardMarkup([["🎤 Отправить голосовое", "↪️ Назад в меню"]], resize_keyboard=True)
            update.message.reply_text(
                f"✅ Права распознаны!\n"
                f"👤 ФИО: {full_name}\n"
                f"🚗 Номер: {license_number}\n"
                f"Теперь отправьте голосовое сообщение с номером телефона и банком:",
                reply_markup=reply_markup
            )

            return TAKING_VOICE

        except Exception as e:
            logging.exception("Error processing license")
            session["photos"] = []  # Сбрасываем фото
            reply_markup = ReplyKeyboardMarkup([["📷 Сделать фото", "↪️ Назад в меню"]], resize_keyboard=True)
            update.message.reply_text(
                f"❌ Ошибка: {str(e)}\nПопробуйте снова:",
                reply_markup=reply_markup
            )
            return TAKING_LICENSE_FRONT

    return TAKING_LICENSE_FRONT


def handle_patent_photo(update: Update, context: CallbackContext, session: Dict[str, Any], image_base64: str) -> int:
    """Обработка фото патента"""
    update.message.reply_text("⌛ Распознаю патент...")

    try:
        response = requests.post(
            PATENT_FUNCTION_URL,
            json={"image": image_base64},
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()

        if not payload.get("success"):
            error_msg = payload.get("error") or payload.get("message", "Unknown error")
            update.message.reply_text(f"❌ Ошибка: {error_msg}")
            reply_markup = ReplyKeyboardMarkup([["📷 Сделать фото", "↪️ Назад в меню"]], resize_keyboard=True)
            update.message.reply_text("Попробуйте снова:", reply_markup=reply_markup)
            return TAKING_PATENT_PHOTO

        # Сохраняем данные
        session["document_data"] = {
            "full_name": payload.get("full_name", ""),
            "document_number": payload.get("document_number", ""),
        }

        # Показываем результат
        full_name = session["document_data"].get("full_name", "")
        doc_number = session["document_data"].get("document_number", "")
        reply_markup = ReplyKeyboardMarkup([["🎤 Отправить голосовое", "↪️ Назад в меню"]], resize_keyboard=True)
        update.message.reply_text(
            f"✅ Патент распознан!\n"
            f"👤 ФИО: {full_name}\n"
            f"📇 Номер: {doc_number}\n"
            f"Теперь отправьте голосовое сообщение с номером телефона и банком:",
            reply_markup=reply_markup
        )

        return TAKING_VOICE

    except Exception as e:
        logging.exception("Error processing patent")
        reply_markup = ReplyKeyboardMarkup([["📷 Сделать фото", "↪️ Назад в меню"]], resize_keyboard=True)
        update.message.reply_text(
            f"❌ Ошибка: {str(e)}\nПопробуйте снова:",
            reply_markup=reply_markup
        )
        return TAKING_PATENT_PHOTO


def handle_voice(update: Update, context: CallbackContext) -> int:
    """Обработчик голосовых сообщений"""
    user_id = update.effective_user.id
    session = get_session(user_id)

    if not session or not session.get("document_data"):
        update.message.reply_text("Сначала отправьте документ.")
        return show_main_menu(update, context)

    update.message.reply_text("⌛ Распознаю голосовое сообщение...")

    try:
        # Получаем голосовое
        voice_file = update.message.voice.get_file()
        audio_bytes = voice_file.download_as_bytearray()
        audio_base64 = base64.b64encode(bytes(audio_bytes)).decode('utf-8')

        # Отправляем в аудио функцию
        response = requests.post(
            AUDIO_FUNCTION_URL,
            json={"audio": audio_base64},
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()

        if not payload.get("success"):
            error_msg = payload.get("error") or payload.get("message", "Unknown error")
            update.message.reply_text(f"❌ Ошибка: {error_msg}")
            reply_markup = ReplyKeyboardMarkup([["🎤 Отправить голосовое", "↪️ Назад в меню"]], resize_keyboard=True)
            update.message.reply_text("Попробуйте снова:", reply_markup=reply_markup)
            return TAKING_VOICE

        # Получаем данные
        bank_name = payload.get("bank_name", "не указано")
        phone_number = normalize_phone_number(payload.get("phone_number", ""))

        # Данные документа
        doc_type = session.get("document_type")
        document_data = session.get("document_data", {})
        full_name = get_full_name(document_data, doc_type)
        doc_number = get_document_number(document_data, doc_type)

        # Формируем результат
        final_result = {
            "full_name": full_name,
            "document_number": doc_number,
            "bank_name": bank_name,
            "phone_number": phone_number,
            "document_type": doc_type,
        }

        # Отправляем результат
        pretty = json.dumps(final_result, ensure_ascii=False, indent=2)
        update.message.reply_text(
            f"🎉 Готово! Итоговый JSON:\n```json\n{pretty}\n```",
            parse_mode=ParseMode.MARKDOWN,
        )

        # Показываем меню для нового действия
        reply_markup = ReplyKeyboardMarkup(MAIN_MENU_KEYBOARD, resize_keyboard=True)
        update.message.reply_text(
            "✅ Обработка завершена!\n"
            "Выберите следующее действие:",
            reply_markup=reply_markup
        )

        # Сбрасываем сессию
        end_session(user_id)
        create_session(user_id)

        return SELECTING_ACTION

    except Exception as e:
        logging.exception("Error processing voice")
        reply_markup = ReplyKeyboardMarkup([["🎤 Отправить голосовое", "↪️ Назад в меню"]], resize_keyboard=True)
        update.message.reply_text(
            f"❌ Ошибка: {str(e)}\nПопробуйте снова:",
            reply_markup=reply_markup
        )
        return TAKING_VOICE


# ============================================================================
# ОБРАБОТЧИК ТЕКСТА (резервный)
# ============================================================================

def handle_text(update: Update, context: CallbackContext) -> int:
    """Обработчик текстовых сообщений"""
    text = update.message.text
    if text in ["/start", "старт", "начать"]:
        return start_command(update, context)
    elif text in ["/cancel", "отмена", "стоп"]:
        return cancel_command(update, context)
    elif text == "/menu":
        return show_main_menu(update, context)

    # Если пользователь ввел текст вместо кнопки
    reply_markup = ReplyKeyboardMarkup(MAIN_MENU_KEYBOARD, resize_keyboard=True)
    update.message.reply_text(
        "Пожалуйста, используйте кнопки меню:",
        reply_markup=reply_markup
    )
    return SELECTING_ACTION


# ============================================================================
# ОСНОВНАЯ ФУНКЦИЯ
# ============================================================================

def main() -> None:
    """Основная функция запуска бота"""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )

    updater = Updater(TELEGRAM_BOT_TOKEN, use_context=True)
    dispatcher = updater.dispatcher

    # Создаем ConversationHandler для управления состояниями
    conv_handler = ConversationHandler(
        entry_points=[CommandHandler('start', start_command)],
        states={
            SELECTING_ACTION: [
                MessageHandler(Filters.regex('^(📄 Паспорт|🚗 Водительские права|📋 Патент на работу|❌ Отмена)$'),
                             handle_main_menu_selection),
                MessageHandler(Filters.text & ~Filters.command, handle_text),
            ],
            TAKING_PASSPORT_PHOTO: [
                MessageHandler(Filters.photo, handle_photo),
                MessageHandler(Filters.regex('^(↪️ Назад в меню|📷 Сделать фото)$'), handle_document_menu_selection),
                MessageHandler(Filters.text & ~Filters.command, handle_text),
            ],
            TAKING_LICENSE_FRONT: [
                MessageHandler(Filters.photo, handle_photo),
                MessageHandler(Filters.regex('^(↪️ Назад в меню|📷 Сделать фото)$'), handle_document_menu_selection),
                MessageHandler(Filters.text & ~Filters.command, handle_text),
            ],
            TAKING_LICENSE_BACK: [
                MessageHandler(Filters.photo, handle_photo),
                MessageHandler(Filters.regex('^(↪️ Назад в меню|📷 Сделать фото)$'), handle_document_menu_selection),
                MessageHandler(Filters.text & ~Filters.command, handle_text),
            ],
            TAKING_PATENT_PHOTO: [
                MessageHandler(Filters.photo, handle_photo),
                MessageHandler(Filters.regex('^(↪️ Назад в меню|📷 Сделать фото)$'), handle_document_menu_selection),
                MessageHandler(Filters.text & ~Filters.command, handle_text),
            ],
            TAKING_VOICE: [
                MessageHandler(Filters.voice, handle_voice),
                MessageHandler(Filters.regex('^(↪️ Назад в меню|🎤 Отправить голосовое)$'), handle_document_menu_selection),
                MessageHandler(Filters.text & ~Filters.command, handle_text),
            ],
        },
        fallbacks=[
            CommandHandler('cancel', cancel_command),
            CommandHandler('start', start_command),
            CommandHandler('menu', show_main_menu),
        ],
    )

    dispatcher.add_handler(conv_handler)

    # Выводим информацию о запуске
    print("=" * 60)
    print("🤖 БОТ С КНОПОЧНЫМ МЕНЮ")
    print("=" * 60)
    print("📋 Доступные документы:")
    print("  📄 Паспорт")
    print("  🚗 Водительские права")
    print("  📋 Патент на работу")
    print("")
    print("🔗 Функции:")
    print(f"  Паспорт: {PASSPORT_FUNCTION_URL}")
    print(f"  Права:   {LICENSE_FUNCTION_URL}")
    print(f"  Патент:  {PATENT_FUNCTION_URL}")
    print(f"  Аудио:   {AUDIO_FUNCTION_URL}")
    print("=" * 60)
    print("✅ Бот запущен и готов к работе!")
    print("=" * 60)

    updater.start_polling()
    updater.idle()


if __name__ == "__main__":
    main()

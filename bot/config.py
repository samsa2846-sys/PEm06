import os
from dataclasses import dataclass
from typing import Optional

from dotenv import load_dotenv

# Load environment variables from .env if present.
load_dotenv()


@dataclass(frozen=True)
class BotConfig:
    telegram_token: str
    passport_url: str
    audio_url: str
    log_level: str = "INFO"

    @staticmethod
    def from_env() -> "BotConfig":
        token = os.getenv("TELEGRAM_BOT_TOKEN")
        passport_url = os.getenv("PASSPORT_FUNCTION_URL")
        audio_url = os.getenv("AUDIO_FUNCTION_URL")
        log_level = os.getenv("LOG_LEVEL", "INFO").upper()

        missing = [
            name
            for name, value in [
                ("TELEGRAM_BOT_TOKEN", token),
                ("PASSPORT_FUNCTION_URL", passport_url),
                ("AUDIO_FUNCTION_URL", audio_url),
            ]
            if not value
        ]
        if missing:
            joined = ", ".join(missing)
            raise RuntimeError(f"Missing required environment variables: {joined}")

        return BotConfig(
            telegram_token=token,
            passport_url=passport_url,
            audio_url=audio_url,
            log_level=log_level,
        )




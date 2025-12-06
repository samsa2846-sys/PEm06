@echo off
REM Скрипт для быстрой инициализации Git репозитория
REM Использование: запустите этот файл после установки Git

echo ========================================
echo Инициализация Git репозитория
echo ========================================
echo.

REM Проверка наличия Git
git --version >nul 2>&1
if errorlevel 1 (
    echo [ОШИБКА] Git не установлен!
    echo Скачайте Git: https://git-scm.com/download/win
    pause
    exit /b 1
)

echo [OK] Git установлен
echo.

REM Инициализация
echo Инициализация репозитория...
git init
if errorlevel 1 (
    echo [ОШИБКА] Не удалось инициализировать репозиторий
    pause
    exit /b 1
)

echo [OK] Репозиторий инициализирован
echo.

REM Добавление файлов
echo Добавление файлов...
git add .
if errorlevel 1 (
    echo [ОШИБКА] Не удалось добавить файлы
    pause
    exit /b 1
)

echo [OK] Файлы добавлены
echo.

REM Создание коммита
echo Создание первого коммита...
git commit -m "Initial commit: Telegram bot for passport and audio recognition"
if errorlevel 1 (
    echo [ПРЕДУПРЕЖДЕНИЕ] Не удалось создать коммит
    echo Возможно, нужно настроить Git:
    echo   git config --global user.name "Ваше Имя"
    echo   git config --global user.email "ваш.email@example.com"
    pause
    exit /b 1
)

echo [OK] Коммит создан
echo.
echo ========================================
echo Готово! Репозиторий инициализирован.
echo ========================================
echo.
echo Следующие шаги:
echo 1. Создайте репозиторий на GitHub
echo 2. Выполните команды:
echo    git remote add origin https://github.com/USERNAME/repo-name.git
echo    git branch -M main
echo    git push -u origin main
echo.
echo Подробная инструкция в файле GITHUB_SETUP.md
echo.
pause




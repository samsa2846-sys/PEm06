# Инструкция по загрузке проекта в GitHub

## Шаг 1: Установка Git (если не установлен)

1. Скачайте Git для Windows: https://git-scm.com/download/win
2. Установите с настройками по умолчанию
3. Перезапустите терминал/PowerShell

## Шаг 2: Настройка Git (первый раз)

```bash
git config --global user.name "Ваше Имя"
git config --global user.email "ваш.email@example.com"
```

## Шаг 3: Инициализация репозитория

Откройте терминал в папке проекта (`C:\Cursor\test`) и выполните:

```bash
# Инициализация git репозитория
git init

# Добавление всех файлов
git add .

# Создание первого коммита
git commit -m "Initial commit: Telegram bot for passport and audio recognition"
```

## Шаг 4: Создание репозитория на GitHub

1. Войдите в GitHub: https://github.com
2. Нажмите кнопку **"+"** в правом верхнем углу → **"New repository"**
3. Заполните:
   - **Repository name**: `passport-audio-bot` (или другое название)
   - **Description**: "Telegram bot for passport and audio recognition using Yandex Cloud"
   - Выберите **Public** или **Private**
   - **НЕ** ставьте галочки на "Add a README file", "Add .gitignore", "Choose a license" (у нас уже есть файлы)
4. Нажмите **"Create repository"**

## Шаг 5: Подключение локального репозитория к GitHub

GitHub покажет инструкции. Выполните команды (замените `USERNAME` на ваш GitHub username):

```bash
# Добавление удаленного репозитория
git remote add origin https://github.com/USERNAME/passport-audio-bot.git

# Переименование основной ветки в main (если нужно)
git branch -M main

# Отправка кода на GitHub
git push -u origin main
```

Если GitHub попросит авторизацию:
- Используйте **Personal Access Token** вместо пароля
- Создайте токен: GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token
- Права: выберите `repo` (полный доступ к репозиториям)

## Альтернативный способ через GitHub Desktop

Если предпочитаете графический интерфейс:

1. Скачайте GitHub Desktop: https://desktop.github.com/
2. Установите и войдите в аккаунт GitHub
3. File → Add Local Repository → выберите папку `C:\Cursor\test`
4. Нажмите "Publish repository" в правом верхнем углу
5. Введите название и описание, нажмите "Publish repository"

## Проверка

После успешной загрузки откройте ваш репозиторий на GitHub:
`https://github.com/USERNAME/passport-audio-bot`

Вы должны увидеть все файлы проекта:
- `README.md`
- `bot/` (с main.py, config.py, requirements.txt)
- `functions/` (passport и audio функции)
- `.gitignore`
- `env.example`

## Дальнейшая работа

При внесении изменений:

```bash
# Проверить изменения
git status

# Добавить измененные файлы
git add .

# Создать коммит
git commit -m "Описание изменений"

# Отправить на GitHub
git push
```




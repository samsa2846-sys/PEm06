# Быстрый старт: Загрузка в GitHub

## ✅ Чеклист

- [ ] **Установить Git** → https://git-scm.com/download/win
  - Подробная инструкция: [INSTALL_GIT.md](INSTALL_GIT.md)
  
- [ ] **Перезапустить PowerShell** (важно!)

- [ ] **Настроить Git** (один раз):
  ```powershell
  git config --global user.name "Ваше Имя"
  git config --global user.email "ваш.email@example.com"
  ```

- [ ] **Инициализировать репозиторий**:
  ```powershell
  cd C:\Cursor\test
  git init
  git add .
  git commit -m "Initial commit: Telegram bot for passport and audio recognition"
  ```

- [ ] **Создать репозиторий на GitHub**:
  - Откройте: https://github.com/new
  - Название: `passport-audio-bot`
  - НЕ ставьте галочки на README/gitignore/license
  - Нажмите "Create repository"

- [ ] **Подключить и отправить**:
  ```powershell
  git remote add origin https://github.com/USERNAME/passport-audio-bot.git
  git branch -M main
  git push -u origin main
  ```

## 🔑 Создание токена для GitHub

Если запросит пароль при `git push`:

1. https://github.com/settings/tokens
2. Generate new token (classic)
3. Выберите `repo` (полный доступ)
4. Скопируйте токен и используйте его вместо пароля

📖 **Подробное руководство:** [GITHUB_TOKEN_GUIDE.md](GITHUB_TOKEN_GUIDE.md)

**Важно при вводе:**
- **Username**: ваш GitHub username (без @)
- **Password**: вставьте токен (не обычный пароль!)
- При вводе токена символы не отображаются — это нормально

## 🎯 Альтернатива: GitHub Desktop

Если не хотите использовать команды:
1. Скачайте: https://desktop.github.com/
2. File → Add Local Repository → выберите `C:\Cursor\test`
3. Publish repository

---

**Подробные инструкции:** [INSTALL_GIT.md](INSTALL_GIT.md)



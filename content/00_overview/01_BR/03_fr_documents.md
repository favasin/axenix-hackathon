---
title: "FR_01: Загрузка и индексация документов"
description: "Функциональные требования к загрузке, хранению и RAG-индексации исходных документов."
weight: 3
draft: false
slug: ""
titleIcon: "fa-solid fa-list-check"
---

## Содержание

- [US-001: Загрузка файла через браузер](#us-001-загрузка-файла-через-браузер)
- [US-002: Импорт документа по URL](#us-002-импорт-документа-по-url)
- [US-003: Импорт из Google Drive](#us-003-импорт-из-google-drive)
- [US-004: Импорт из Microsoft OneDrive / SharePoint](#us-004-импорт-из-microsoft-onedrive--sharepoint)
- [US-005: Импорт из Notion / Confluence](#us-005-импорт-из-notion--confluence)
- [US-006: Просмотр и управление загруженными источниками](#us-006-просмотр-и-управление-загруженными-источниками)

> **Нумерация:** FR-001 — FR-009. Продолжение в [04_fr_rag.md](./04_fr_rag.md) с FR-010.

---

## US-001: Загрузка файла через браузер

> Как **пользователь**, я хочу загрузить файл со своего компьютера, чтобы система использовала его данные при генерации презентации.

**Источник:** [source_documents](../../../03_backend/01_info_models/relational.md) — поля `file_type`, `s3_key`, `file_size_bytes`, `content_hash`; [document_ingestion_jobs](../../../03_backend/01_info_models/relational.md); [vector_store.md](../../../03_backend/01_info_models/vector_store.md) — chunking pipeline

### FR-001: Загрузка файла поддерживаемого формата

**Описание:** Система принимает файл через multipart/form-data POST-запрос. Поддерживаемые форматы: PDF, DOCX, XLSX, CSV, PPTX, PNG, JPG, TXT. Максимальный размер файла определяется тарифным планом организации (`plans.max_file_size_mb`): Free — 10 МБ, Pro — 50 МБ, Team — 100 МБ, Enterprise — без лимита.

**Приоритет:** Must

**Зависимости:** NFR-001 (latency загрузки), NFR-004 (шифрование at-rest), CON-001 (стек хранилища)

### FR-002: Дедупликация файлов по SHA-256

**Описание:** При загрузке система вычисляет SHA-256 хеш файла (`source_documents.content_hash`). Если файл с таким хешем уже существует в организации, система возвращает существующий `source_document_id` без повторной индексации. Пользователю отображается уведомление: «Файл уже загружен: `{filename}`. Использован существующий документ.»

**Приоритет:** Should

**Зависимости:** FR-001, NFR-002 (стоимость LLM-операций)

#### Критерии приёмки FR-001 + FR-002

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Happy path — PDF в рамках лимита | Файл `report.pdf`, 8 МБ, план Free (лимит 10 МБ) | HTTP 202, `source_document_id` = UUID, `ingestion_status = pending`, задача в очереди `celery_queue:ingestion` |
| 2 | Дубликат файла | Файл с SHA-256, уже существующим в организации | HTTP 200, возвращён существующий `source_document_id`, новая задача не создана |
| 3 | Превышение лимита размера | Файл 15 МБ, план Free (лимит 10 МБ) | HTTP 413, `{"error": "file_too_large", "limit_mb": 10, "file_mb": 15}` |
| 4 | Неподдерживаемый формат | Файл `.exe` | HTTP 415, `{"error": "unsupported_file_type", "allowed": ["pdf","docx","xlsx","csv","pptx","png","jpg","txt"]}` |
| 5 | Превышение лимита числа источников в презентации | 11-й файл при лимите 10 | HTTP 422, `{"error": "source_limit_exceeded", "limit": 10}` |

#### Примечания архитектора
> ⚙️ Файл сохраняется в S3 до начала индексации. Индексация запускается асинхронно через Celery. API отвечает 202 Accepted немедленно. Клиент отслеживает статус через WebSocket или GET `/documents/{id}`.

---

## US-002: Импорт документа по URL

> Как **пользователь**, я хочу указать URL веб-страницы, чтобы система извлекла текст и использовала его как источник данных.

**Источник:** [source_documents](../../../03_backend/01_info_models/relational.md) — поля `url`, `file_type = url`; [vector_store.md](../../../03_backend/01_info_models/vector_store.md) — стратегия для URL-источников

### FR-003: Импорт и парсинг веб-страницы

**Описание:** Пользователь передаёт URL (HTTP/HTTPS). Система выполняет HTTP GET-запрос через BeautifulSoup-скрапер, извлекает текстовый контент (без рекламы, навигации, footer). Результат chunked по стандартному алгоритму (512 токенов, overlap 64). Метаданные чанков: `source_url`, `section_title` из мета-тегов страницы. Таймаут парсинга: 30 секунд.

**Приоритет:** Should

**Зависимости:** FR-001 (flow индексации идентичен), NFR-006 (таймауты внешних запросов), CON-003 (только публично доступные URL)

#### Критерии приёмки FR-003

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Happy path | `https://example.com/report` — публичная страница | HTTP 202, `source_document_id` = UUID, `file_type = url`, индексация запускается |
| 2 | URL недоступен | URL возвращает HTTP 404 | HTTP 422, `{"error": "url_unreachable", "status_code": 404}` |
| 3 | Таймаут скрапера | URL не отвечает 30 секунд | `ingestion_status = failed`, `error_message = "scraper_timeout"`, пользователь уведомлён |
| 4 | Закрытый контент (авторизация) | URL за логином | HTTP 422, `{"error": "url_requires_auth"}` — с подсказкой использовать загрузку файла |
| 5 | Слишком большая страница | HTML > 10 МБ | Обрезается до первых 10 МБ, в метаданных флаг `truncated: true` |

---

## US-003: Импорт из Google Drive

> Как **пользователь**, я хочу подключить свой Google Drive и выбрать файл напрямую, чтобы не скачивать его вручную.

**Источник:** [oauth_connections](../../../03_backend/01_info_models/relational.md) — `provider = google`; [01_architecture/_index.md](../../../01_architecture/_index.md) — OAuth 2.0 интеграция

### FR-004: OAuth-авторизация Google Drive и импорт файла

**Описание:** Пользователь инициирует OAuth 2.0 PKCE-flow для Google Drive (scope: `drive.readonly`). После авторизации система сохраняет зашифрованный `access_token` и `refresh_token` в `oauth_connections`. Пользователь видит файловый браузер своего Drive и выбирает документ. Система скачивает файл через Google Drive API v3 и помещает в очередь индексации. Токен автоматически обновляется при истечении срока.

**Приоритет:** Should

**Зависимости:** FR-001 (flow индексации), NFR-004 (шифрование токенов AES-256-GCM), CON-004 (OAuth 2.0 must)

#### Критерии приёмки FR-004

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Happy path — первичная авторизация | Пользователь нажимает «Подключить Google Drive», проходит OAuth | `oauth_connections` создана, файловый браузер Drive открыт |
| 2 | Повторный импорт — токен актуален | Пользователь уже авторизован | OAuth-flow не запускается, браузер Drive открывается сразу |
| 3 | Истёкший access_token | refresh_token валиден | Система автоматически обновляет токен, импорт выполняется прозрачно |
| 4 | Отозванный доступ | Пользователь отозвал доступ в Google | HTTP 401 от Drive API → `oauth_connections` помечена как недействительная, пользователь получает запрос на повторную авторизацию |
| 5 | Файл удалён из Drive после выбора | Google Drive API возвращает 404 | `ingestion_status = failed`, `error_message = "source_file_not_found"` |

---

## US-004: Импорт из Microsoft OneDrive / SharePoint

> Как **пользователь**, я хочу импортировать файл из OneDrive или SharePoint, чтобы использовать корпоративные документы без ручной загрузки.

**Источник:** [oauth_connections](../../../03_backend/01_info_models/relational.md) — `provider = microsoft`

### FR-005: OAuth-авторизация Microsoft и импорт файла

**Описание:** Пользователь инициирует OAuth 2.0 flow для Microsoft (scope: `Files.Read`, `offline_access`). Поддерживаются OneDrive личный и SharePoint (через Microsoft Graph API). После выбора файла система скачивает его через Microsoft Graph API и помещает в очередь индексации. Формат аналогичен FR-004.

**Приоритет:** Should

**Зависимости:** FR-001, FR-004 (аналогичный OAuth-flow)

#### Критерии приёмки FR-005

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Happy path | OAuth через Microsoft Account → выбор файла из OneDrive | Файл скачан, `ingestion_status = pending` |
| 2 | SharePoint файл | Файл из корпоративного SharePoint | Успешный импорт через Graph API с корректным site_id |
| 3 | Недостаточно прав | Файл в SharePoint с ограниченным доступом | HTTP 403 от Graph API → `{"error": "insufficient_permissions", "resource": "sharepoint_file"}` |

---

## US-005: Импорт из Notion / Confluence

> Как **пользователь**, я хочу импортировать страницы из Notion или Confluence, чтобы использовать базу знаний команды как источник для презентации.

**Источник:** [oauth_connections](../../../03_backend/01_info_models/relational.md) — `provider = notion | confluence`

### FR-006: Импорт страницы Notion через API Token

**Описание:** Пользователь вводит Notion Integration Token (не OAuth, согласно API Notion). Система сохраняет зашифрованный токен в `oauth_connections.access_token_encrypted`. Пользователь вводит URL страницы Notion. Система извлекает контент через Notion API v1, рекурсивно включая вложенные блоки до 2 уровней глубины. Результат конвертируется в текст и индексируется.

**Приоритет:** Could

**Зависимости:** FR-001

### FR-007: Импорт страницы Confluence через API Token

**Описание:** Пользователь вводит Confluence Base URL, Email и API Token. Система сохраняет зашифрованный токен. Пользователь вводит URL страницы Confluence. Система получает контент через Confluence REST API v2 (`GET /wiki/rest/api/content/{id}?expand=body.storage`) и индексирует.

**Приоритет:** Could

**Зависимости:** FR-001

#### Критерии приёмки FR-006 + FR-007

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Happy path Notion | Валидный Integration Token + URL страницы | Контент извлечён, `file_type = url`, индексация запущена |
| 2 | Невалидный Notion Token | Неверный токен | HTTP 401 от Notion API → `{"error": "invalid_notion_token"}` |
| 3 | Happy path Confluence | Валидный API Token + URL страницы | Контент извлечён и индексирован |
| 4 | Страница с ограниченным доступом | Token без прав на страницу | `{"error": "insufficient_permissions"}` |

---

## US-006: Просмотр и управление загруженными источниками

> Как **пользователь**, я хочу видеть список загруженных источников и их статус индексации, а также удалять ненужные, чтобы контролировать, какие данные участвуют в генерации.

**Источник:** [source_documents](../../../03_backend/01_info_models/relational.md); [document_ingestion_jobs](../../../03_backend/01_info_models/relational.md); [vector_store.md](../../../03_backend/01_info_models/vector_store.md) — TTL-стратегия удаления чанков

### FR-008: Просмотр списка источников презентации

**Описание:** GET `/presentations/{id}/sources` возвращает список `source_documents`, связанных с презентацией через `presentation_sources`. Для каждого источника: `original_filename`, `file_type`, `file_size_bytes`, `ingestion_status`, `page_count`, `word_count`, `created_at`. Статусы: `pending` → `processing` → `indexed` | `failed`. Статус обновляется в реальном времени через WebSocket (`event_type: "ingestion_completed"`).

**Приоритет:** Must

**Зависимости:** FR-001

### FR-009: Удаление источника из презентации

**Описание:** DELETE `/presentations/{id}/sources/{source_id}` удаляет связь через `presentation_sources`. Если `source_document` не используется ни в одной другой презентации организации — запускается фоновая задача удаления чанков из Qdrant (payload-фильтр по `source_document_id`) и файла из S3. Операция необратима; UI показывает подтверждение.

**Приоритет:** Must

**Зависимости:** FR-008, NFR-007 (право на удаление — GDPR)

#### Критерии приёмки FR-008 + FR-009

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Список источников | GET `/presentations/{id}/sources` | JSON-массив с полными метаданными каждого источника |
| 2 | Источник в статусе processing | WebSocket открыт | При переходе `processing → indexed` клиент получает событие `ingestion_completed` |
| 3 | Удаление уникального источника | DELETE, источник только в этой презентации | HTTP 200, чанки удалены из Qdrant, файл удалён из S3 в течение 60 сек |
| 4 | Удаление общего источника | DELETE, источник используется в 2-х презентациях | HTTP 200, только запись в `presentation_sources` удалена; Qdrant и S3 не затронуты |
| 5 | Удаление источника без прав | Пользователь с ролью viewer | HTTP 403, `{"error": "insufficient_role", "required": "editor"}` |

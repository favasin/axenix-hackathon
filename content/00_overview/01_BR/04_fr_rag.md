---
title: "FR_02: RAG-поиск и генерация презентаций"
description: "Функциональные требования к RAG-пайплайну, генерации контента, экспорту и аналитике."
weight: 4
draft: false
slug: ""
titleIcon: "fa-solid fa-list-check"
---

## Содержание

- [US-010: Создание структуры презентации (outline)](#us-010-создание-структуры-презентации-outline)
- [US-011: Генерация слайдов с атрибуцией источников](#us-011-генерация-слайдов-с-атрибуцией-источников)
- [US-012: Итеративное редактирование и смена тональности](#us-012-итеративное-редактирование-и-смена-тональности)
- [US-013: Экспорт презентации](#us-013-экспорт-презентации)
- [US-014: Публичная ссылка и аналитика просмотров](#us-014-публичная-ссылка-и-аналитика-просмотров)

> **Нумерация:** FR-010 — FR-024. Продолжение в [05_fr_users.md](./05_fr_users.md) с FR-025.

---

## US-010: Создание структуры презентации (outline)

> Как **пользователь**, я хочу задать цель презентации и аудиторию, чтобы система автоматически сгенерировала логичную структуру слайдов на основе моих данных.

**Источник:** [presentations](../../../03_backend/01_info_models/relational.md) — поля `tone`, `target_audience`, `status`; [generation_jobs](../../../03_backend/01_info_models/relational.md); [documents.md](../../../03_backend/01_info_models/documents.md) — `generation_traces.outline_step`; [vector_store.md](../../../03_backend/01_info_models/vector_store.md) — retrieval pipeline; [cache.md](../../../03_backend/01_info_models/cache.md) — `semantic_cache`, `gen_checkpoint`

### FR-010: Создание презентации с параметрами

**Описание:** POST `/presentations` принимает: `title`, `project_id`, `goal` (цель презентации, обязательно), `target_audience`, `tone` (ENUM: formal/business/persuasive/technical/educational/friendly), `slide_count` (5–30, default 15), `language` (ru/en), `brand_kit_id` (опционально). Создаётся запись `presentations` со статусом `draft`.

**Приоритет:** Must

**Зависимости:** NFR-001 (latency создания ≤ 500 мс)

### FR-011: Генерация outline через RAG + LLM

**Описание:** POST `/presentations/{id}/generate/outline` запускает async-задачу. Пайплайн:
1. Retrieval: для каждого `source_document` презентации выполняется similarity-поиск в Qdrant (top_k=8, threshold=0.72) с запросом = `goal` пользователя.
2. Семантический кэш: если cosine similarity запроса с кэшированным ≥ 0.95 — возвращается кэшированный ответ (`semantic_cache:{hash}` в Redis).
3. LLM (Claude Sonnet, temperature=0.3): генерируется JSON-массив outline с полями: `slide_number`, `title`, `key_thesis`, `slide_type`, `data_required`.
4. Outline сохраняется в `gen_checkpoint:{job_id}` (Redis) и в `generation_jobs`.
5. Статус `presentations` обновляется: `draft → outline_ready`.
6. WebSocket-событие `outline_generated` отправляется клиенту.

**Приоритет:** Must

**Зависимости:** FR-009 (минимум 1 источник проиндексирован), NFR-001 (p95 outline ≤ 10 сек), NFR-005 (поведение при недоступности LLM)

#### RAG-специфика

| Параметр | Значение | Источник |
|----------|---------|----------|
| Chunking | 512 токенов, overlap 64 | [vector_store.md](../../../03_backend/01_info_models/vector_store.md) |
| Embedding model | text-embedding-3-large (3072d) / BGE-M3 on-premise | [vector_store.md](../../../03_backend/01_info_models/vector_store.md) |
| Similarity threshold (outline) | 0.72 (cosine) | [vector_store.md](../../../03_backend/01_info_models/vector_store.md) |
| Semantic cache threshold | 0.95 (cosine) | [cache.md](../../../03_backend/01_info_models/cache.md) |
| Fallback при низком score | Если все чанки < 0.72: LLM генерирует outline только из `goal` и `target_audience` без RAG-контекста; пользователь получает предупреждение «Источники данных не содержат релевантной информации для указанной цели» | — |
| Fallback при недоступности LLM | Circuit Breaker: Claude → GPT-4o (failover, ≤ 30 сек retry). Если оба недоступны — HTTP 503 с `retry_after: 60` | [01_architecture/_index.md](../../../01_architecture/_index.md) |

#### Критерии приёмки FR-010 + FR-011

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Happy path | goal + audience + 2 проиндексированных файла | outline за ≤ 10 сек (p95), статус `outline_ready`, WebSocket-событие `outline_generated` |
| 2 | Семантический кэш | Запрос с cosine similarity 0.96 к кэшированному | Ответ из кэша за ≤ 200 мс, LLM не вызывается, в трейсе `cache_hit: true` |
| 3 | Нет проиндексированных источников | Презентация без источников | HTTP 422, `{"error": "no_indexed_sources"}` |
| 4 | Источники нерелевантны | Все чанки score < 0.72 | outline сгенерирован только из goal; предупреждение в UI |
| 5 | LLM Claude недоступен | Claude API timeout > 30 сек | Автоматический failover на GPT-4o; в трейсе `fallback_triggered: true` |
| 6 | Оба LLM недоступны | Claude и GPT-4o недоступны | HTTP 503, `{"error": "llm_unavailable", "retry_after": 60}` |

---

## US-011: Генерация слайдов с атрибуцией источников

> Как **пользователь**, я хочу чтобы каждый факт на сгенерированном слайде был привязан к конкретному источнику, чтобы я мог верифицировать информацию перед презентацией.

**Источник:** [slides](../../../03_backend/01_info_models/relational.md) — поля `source_refs`, `hallucination_flags`; [generation_jobs](../../../03_backend/01_info_models/relational.md); [documents.md](../../../03_backend/01_info_models/documents.md) — `generation_traces.slide_steps`, `postprocessing`; [cache.md](../../../03_backend/01_info_models/cache.md) — `gen_checkpoint`, `gen_progress`

### FR-012: Генерация контента слайда с retrieval

**Описание:** Для каждого слайда из outline система выполняет:
1. Retrieval из Qdrant: query = `slide.title + slide.key_thesis`, top_k=8, threshold=0.72. При наличии числовых данных (`data_required=true`) — дополнительный поиск с фильтром `contains_numbers=true`.
2. Cross-encoder re-ranking при > 8 результатов.
3. LLM-генерация: модель получает чанки с метаданными (`filename`, `page_number`, `section_title`) и обязана в ответе JSON явно указать `source_refs` для каждого утверждения.
4. Постпроцессинг (см. FR-013).
5. Слайд сохраняется в PostgreSQL (`slides`), чекпоинт обновляется в Redis (`gen_checkpoint:{job_id}`).
6. Прогресс трансляции через Redis Stream (`gen_progress:{job_id}`) → WebSocket → клиент.

**Приоритет:** Must

**Зависимости:** FR-011 (outline должен быть готов), NFR-001 (p95 одного слайда ≤ 5 сек), NFR-005 (fallback LLM)

### FR-013: Постпроцессинг: удаление AI-клише и проверка фактов

**Описание:**
- **AI-клише filter:** регулярные выражения + классификатор удаляют конструкции типа «в современном мире», «это позволяет нам», «инновационный подход». Целевая метрика: GPTZero классифицирует текст как «человеческий» с P > 70%.
- **Проверка числовых утверждений:** для каждого числа из сгенерированного текста — поиск в векторном хранилище. Если чанк с числом в ±5% диапазоне не найден — утверждение помечается флагом `not_in_sources` в `slides.hallucination_flags`.
- **Атрибуция:** каждый факт в `slides.source_refs` содержит `source_document_id`, `chunk_id`, `text_fragment`. В UI рядом с фактом отображается иконка источника; по наведению — preview оригинального фрагмента.

**Приоритет:** Must

**Зависимости:** FR-012, NFR-003 (HIR < 0.5 на 1000 презентаций)

### FR-014: Checkpoint-based recovery генерации

**Описание:** После каждого завершённого слайда состояние сохраняется в `gen_checkpoint:{job_id}` (Redis HASH). При падении Celery worker новый worker читает checkpoint и продолжает с `slides_completed + 1`. Максимальное время возобновления после падения worker: ≤ 60 секунд.

**Приоритет:** Must

**Зависимости:** NFR-002 (надёжность), CON-002 (Redis AOF persistence)

#### Критерии приёмки FR-012 + FR-013 + FR-014

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Happy path — 15 слайдов | Outline из 15 пунктов, 3 проиндексированных файла | Все слайды сгенерированы, каждый имеет `source_refs`, статус `ready` за ≤ 60 сек (p95) |
| 2 | Слайд с числами | Слайд с `data_required=true` | Чанки с `contains_numbers=true` приоритизированы; числа имеют `source_refs` или `hallucination_flags` |
| 3 | AI-клише в ответе | LLM вернул «в современном мире...» | Клише удалено постпроцессором; в `generation_traces` `ai_cliche_removed > 0` |
| 4 | Галлюцинация числа | Число не найдено в источниках ±5% | `hallucination_flags: [{flag_type: "not_in_sources"}]`; в UI предупреждение ⚠ |
| 5 | Падение worker на слайде 7 | Worker процесс завершён | Новый worker читает checkpoint, продолжает с слайда 8; пользователь не замечает сбоя |
| 6 | Стриминг прогресса | WebSocket подключён | Событие `slide_completed` приходит после каждого слайда с `progress_pct` |

#### Примечания архитектора
> ⚙️ Генерация 15 слайдов параллелизируется: до 3 слайдов генерируются одновременно (LangGraph параллельные ветви), при условии независимости контекста. Это снижает p95 с 75 сек до ≈ 30 сек при полной параллелизации.

---

## US-012: Итеративное редактирование и смена тональности

> Как **пользователь**, я хочу изменить тональность готовой презентации или перегенерировать отдельный слайд, чтобы адаптировать результат без полной перегенерации.

**Источник:** [slides](../../../03_backend/01_info_models/relational.md) — `slide_versions`; [presentations](../../../03_backend/01_info_models/relational.md) — `tone`; [documents.md](../../../03_backend/01_info_models/documents.md) — `prompt_templates` — `tone_variant`

### FR-015: Смена тональности презентации

**Описание:** PATCH `/presentations/{id}` с полем `tone` инициирует перегенерацию всех слайдов с промптом, соответствующим новой тональности (из `prompt_templates` с `tone_variant = new_tone`). Прежние версии слайдов сохраняются в `slide_versions`. Операция асинхронная; прогресс через WebSocket.

**Приоритет:** Must

**Зависимости:** FR-012, NFR-001 (p95 смены тональности ≤ 30 сек для 15 слайдов)

### FR-016: Регенерация отдельного слайда

**Описание:** POST `/slides/{id}/regenerate` с опциональным `instruction` (например, «сделай короче», «добавь данные о конкурентах»). Система регенерирует только этот слайд, сохраняя текущую версию в `slide_versions`. Retrieval выполняется заново с учётом `instruction`.

**Приоритет:** Must

**Зависимости:** FR-012

### FR-017: Версионирование слайдов и откат

**Описание:** GET `/slides/{id}/versions` возвращает историю версий (`slide_versions`). POST `/slides/{id}/restore/{version_number}` восстанавливает указанную версию как текущую (создаётся новая версия с контентом старой). Хранится не более 10 версий на слайд; при превышении — удаляется самая старая.

**Приоритет:** Should

**Зависимости:** FR-015, FR-016

#### Критерии приёмки FR-015 — FR-017

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Смена тональности | PATCH tone: formal → persuasive | Все слайды перегенерированы с persuasive-промптом ≤ 30 сек (p95); прежние версии в `slide_versions` |
| 2 | Регенерация слайда с инструкцией | POST `/slides/{id}/regenerate`, instruction: «добавь сравнение с конкурентами» | Слайд перегенерирован с учётом инструкции; предыдущая версия сохранена |
| 3 | Откат слайда | POST restore version_number=2 | Текущий контент заменён версией 2; создана новая версия 4 (= контент v2) |
| 4 | Превышение лимита версий | 11-я регенерация слайда | Версия 1 удалена; хранятся версии 2–11 |

---

## US-013: Экспорт презентации

> Как **пользователь**, я хочу скачать готовую презентацию в нужном формате, чтобы использовать её в своей работе.

**Источник:** [export_jobs](../../../03_backend/01_info_models/relational.md) — `format`, `status`, `s3_key`, `download_url`; [01_architecture/_index.md](../../../01_architecture/_index.md) — Export Service

### FR-018: Экспорт в PPTX

**Описание:** POST `/presentations/{id}/export` с `format: pptx`. Задача помещается в `celery_queue:export`. Export Service (python-pptx) рендерит PPTX: применяет Brand Kit (цвета, шрифты, логотип, шаблон из `brand_kits.template_s3_key`), встраивает диаграммы Matplotlib как редактируемые объекты PowerPoint, добавляет footnote с attribution для каждого источника. PPTX сохраняется в S3, `export_jobs.download_url` проставляется с TTL 24 часа.

**Приоритет:** Must

**Зависимости:** NFR-001 (p95 экспорта ≤ 15 сек), NFR-004 (файл шифруется at-rest в S3)

### FR-019: Экспорт в PDF

**Описание:** POST `/presentations/{id}/export` с `format: pdf`. LibreOffice headless конвертирует PPTX → PDF с закладками по слайдам. Векторный рендеринг. Файл в S3, TTL 24 часа.

**Приоритет:** Must

**Зависимости:** FR-018 (PDF генерируется из PPTX)

### FR-020: Экспорт в Google Slides

**Описание:** POST `/presentations/{id}/export` с `format: google_slides`. Требует наличия `oauth_connections` с `provider = google` и scope `https://www.googleapis.com/auth/drive`. Система создаёт презентацию в Google Slides через API v1 в корне Drive пользователя. `export_jobs.google_file_id` сохраняется для прямой ссылки.

**Приоритет:** Should

**Зависимости:** FR-004 (Google OAuth), FR-018

### FR-021: Экспорт в PNG (слайды)

**Описание:** POST `/presentations/{id}/export` с `format: png` и опциональным `slide_range: [1, 5]`. Playwright headless рендерит каждый слайд как PNG (1920×1080). ZIP-архив со слайдами сохраняется в S3.

**Приоритет:** Could

**Зависимости:** FR-018

#### Критерии приёмки FR-018 — FR-021

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | PPTX с Brand Kit | Презентация с brand_kit_id, 15 слайдов | PPTX ≤ 15 сек (p95); содержит корпоративные цвета, шрифты, логотип; диаграммы редактируемые |
| 2 | PPTX без Brand Kit | brand_kit_id = null | Применяется дефолтный шаблон; PPTX корректен |
| 3 | Экспорт в PDF | format: pdf | PDF с векторной графикой и закладками ≤ 20 сек |
| 4 | Google Slides — токен истёк | access_token expired | Автоматический refresh через refresh_token; экспорт выполнен |
| 5 | Скачивание по истёкшей ссылке | download_url после 24 часов | HTTP 410 Gone, `{"error": "download_url_expired"}` |

---

## US-014: Публичная ссылка и аналитика просмотров

> Как **пользователь**, я хочу поделиться презентацией по публичной ссылке и видеть статистику просмотров, чтобы понимать вовлечённость аудитории.

**Источник:** [presentation_shares](../../../03_backend/01_info_models/relational.md) — `token`, `access_level`, `expires_at`; [documents.md](../../../03_backend/01_info_models/documents.md) — `presentation_analytics`; [cache.md](../../../03_backend/01_info_models/cache.md) — `presentation_view_count:{id}`

### FR-022: Создание публичной ссылки

**Описание:** POST `/presentations/{id}/shares` создаёт `presentation_shares` с уникальным 32-символьным `token`. Параметры: `access_level` (view/comment/edit), `password` (опционально, хранится как bcrypt hash), `expires_at` (опционально). Публичная ссылка вида `https://present.ai/share/{token}`.

**Приоритет:** Must

**Зависимости:** NFR-004 (пароль — bcrypt)

### FR-023: Просмотр презентации по публичной ссылке

**Описание:** GET `/share/{token}` — анонимный endpoint. Система проверяет: токен существует, не истёк, пароль (если задан). Возвращает презентацию в read-only режиме. Каждый просмотр записывает событие в `presentation_analytics` (MongoDB): `event_type`, `device_type`, `country_code` (GeoIP), `ip_hash` (SHA-256 от IP, не сам IP — GDPR).

**Приоритет:** Must

**Зависимости:** NFR-007 (GDPR: ip_hash вместо IP)

### FR-024: Аналитика просмотров

**Описание:** GET `/presentations/{id}/analytics` возвращает агрегированную статистику из `presentation_analytics`: `total_views`, `unique_sessions`, `avg_completion_rate`, `avg_time_per_slide_ms`, `views_by_device`, `views_by_country`. Актуальный счётчик просмотров (`presentation_view_count:{id}`) берётся из Redis (O(1)).

**Приоритет:** Should

**Зависимости:** FR-023

#### Критерии приёмки FR-022 — FR-024

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Создание ссылки без пароля | POST `/shares`, access_level: view | token = 32 символа, URL `https://present.ai/share/{token}` |
| 2 | Просмотр с паролем | GET `/share/{token}`, пароль верный | Презентация открыта; в analytics записано событие `view_started` |
| 3 | Просмотр с неверным паролем | Неверный пароль | HTTP 403, `{"error": "invalid_share_password"}` |
| 4 | Истёкшая ссылка | expires_at в прошлом | HTTP 410, `{"error": "share_expired"}` |
| 5 | Аналитика | GET `/presentations/{id}/analytics` после 10 просмотров | JSON с `total_views: 10`, `views_by_device: {desktop: 8, mobile: 2}` |
| 6 | IP в аналитике | Запрос от IP 192.168.1.1 | В MongoDB `ip_hash = sha256("192.168.1.1{salt}")`, не сам IP |

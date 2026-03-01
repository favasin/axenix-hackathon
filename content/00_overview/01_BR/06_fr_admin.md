---
title: "FR_04: Администрирование"
description: "Функциональные требования к Brand Kit, API-ключам, Webhook-системе, аудиту и администрированию промптов."
weight: 6
draft: false
slug: ""
titleIcon: "fa-solid fa-list-check"
---

## Содержание

- [US-041: Управление Brand Kit](#us-041-управление-brand-kit)
- [US-042: Управление API-ключами](#us-042-управление-api-ключами)
- [US-043: Webhook-система](#us-043-webhook-система)
- [US-044: Аудит-лог](#us-044-аудит-лог)
- [US-045: Управление промпт-шаблонами](#us-045-управление-промпт-шаблонами)

> **Нумерация:** FR-041 — FR-055. Сквозная нумерация завершена.

---

## US-041: Управление Brand Kit

> Как **администратор организации**, я хочу настроить корпоративный стиль (Brand Kit), чтобы все презентации автоматически соответствовали фирменному стилю компании.

**Источник:** [brand_kits](../../../03_backend/01_info_models/relational.md) — `primary_color`, `font_heading`, `logo_url`, `template_s3_key`; [presentations](../../../03_backend/01_info_models/relational.md) — `brand_kit_id`

### FR-041: CRUD Brand Kit

**Описание:**
- POST `/brand-kits` — создание Brand Kit организации. Поля: `name`, `primary_color` (HEX #RRGGBB), `secondary_color`, `background_color`, `accent_color`, `text_color`, `font_heading`, `font_body`, `logo_url` (загружается в S3). Права: admin.
- GET `/brand-kits` — список Kit организации.
- GET `/brand-kits/{id}` — детальные настройки.
- PATCH `/brand-kits/{id}` — обновление полей. Права: admin.
- DELETE `/brand-kits/{id}` — удаление. Нельзя удалить Kit, который используется в активных презентациях (`presentations.brand_kit_id`). Права: admin.
- PATCH `/brand-kits/{id}` с `is_default: true` — назначение дефолтного Kit для организации. В организации только один `is_default = true`.

**Приоритет:** Must

**Зависимости:** NFR-001 (CRUD ≤ 500 мс), NFR-004 (логотип в S3 — шифрование at-rest)

### FR-042: Загрузка PPTX-шаблона в Brand Kit

**Описание:** POST `/brand-kits/{id}/template` — загрузка PPTX-файла как шаблона слайдов. Файл парсируется (python-pptx): извлекаются master-слайды и layouts. `template_s3_key` обновляется. При экспорте презентации с этим Brand Kit — PPTX рендерится поверх загруженного шаблона. Максимальный размер шаблона: 25 МБ.

**Приоритет:** Must

**Зависимости:** FR-041, FR-018 (экспорт использует шаблон)

### FR-043: Валидация цветов и шрифтов Brand Kit

**Описание:** При сохранении Brand Kit система валидирует:
- Все цвета: регулярное выражение `^#[0-9A-Fa-f]{6}$`.
- Шрифты: только из разрешённого списка (Google Fonts, доступных для встраивания в PPTX). Если шрифт не поддерживается — ошибка с предложением альтернатив.
- Контрастность текста и фона: соответствие WCAG 2.1 AA (контраст ≥ 4.5:1 для основного текста). При несоответствии — предупреждение (не блокирующая ошибка).

**Приоритет:** Should

**Зависимости:** FR-041, NFR-009 (WCAG 2.1 AA)

#### Критерии приёмки FR-041 — FR-043

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Создание Brand Kit | POST с валидными цветами и шрифтами | HTTP 201, `brand_kit_id` = UUID |
| 2 | Невалидный HEX цвет | `primary_color: "red"` | HTTP 422, `{"error": "invalid_color_format", "field": "primary_color"}` |
| 3 | Назначение дефолтного Kit | PATCH is_default: true при существующем default | Предыдущий `is_default` = false; новый Kit становится дефолтным |
| 4 | Удаление используемого Kit | DELETE Kit с 3-мя активными презентациями | HTTP 422, `{"error": "brand_kit_in_use", "presentations_count": 3}` |
| 5 | Загрузка шаблона > 25 МБ | POST template, файл 30 МБ | HTTP 413, `{"error": "template_too_large", "limit_mb": 25}` |
| 6 | Низкий контраст | text_color: #ffffff, background_color: #ffff00 | HTTP 200, `warnings: ["low_contrast: 1.07:1, recommended ≥ 4.5:1"]` |

---

## US-042: Управление API-ключами

> Как **администратор организации**, я хочу создавать API-ключи с ограниченными правами, чтобы интегрировать PresentAI с другими корпоративными системами.

**Источник:** [api_keys](../../../03_backend/01_info_models/relational.md) — `key_hash`, `key_prefix`, `scopes`, `rate_limit_per_minute`; [cache.md](../../../03_backend/01_info_models/cache.md) — `ratelimit:{api_key_id}:{minute}`

### FR-044: Создание API-ключа

**Описание:** POST `/api-keys` создаёт новый ключ. Параметры: `name`, `scopes` (список: `presentations:read`, `presentations:write`, `files:write`, `export:read`), `rate_limit_per_minute` (default по плану: Free — 10, Pro — 60, Enterprise — custom), `expires_at` (опционально). Система генерирует случайный 64-символьный ключ, сохраняет SHA-256 хеш в `key_hash` и первые 8 символов в `key_prefix` (для отображения). **Ключ отображается пользователю единственный раз при создании** — восстановить невозможно. Права: admin.

**Приоритет:** Must

**Зависимости:** NFR-004 (SHA-256 хранение, не plaintext), NFR-001 (rate limiting через Redis)

### FR-045: Просмотр, ротация и отзыв API-ключей

**Описание:**
- GET `/api-keys` — список ключей организации: `name`, `key_prefix`, `scopes`, `last_used_at`, `expires_at`, `revoked_at`.
- POST `/api-keys/{id}/rotate` — создаёт новый ключ с теми же настройками; старый ключ действует ещё 24 часа (grace period), затем автоматически отзывается.
- DELETE `/api-keys/{id}` — немедленный отзыв (`revoked_at = now()`). Все запросы с этим ключом → HTTP 401.

**Приоритет:** Must

**Зависимости:** FR-044

#### Критерии приёмки FR-044 — FR-045

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Создание ключа | POST, scopes: ["presentations:read", "export:read"] | HTTP 201, ключ показан единожды; в БД только `key_hash` |
| 2 | Запрос с валидным ключом | Заголовок `X-API-Key: {key}` | HTTP 200, `last_used_at` обновлён |
| 3 | Rate limit | 61-й запрос за минуту при лимите 60 | HTTP 429, `{"error": "rate_limit_exceeded", "retry_after": 60}` |
| 4 | Отозванный ключ | Запрос с revoked ключом | HTTP 401, `{"error": "api_key_revoked"}` |
| 5 | Ротация | POST `/api-keys/{id}/rotate` | Новый ключ создан; старый действует 24 ч; в ответе новый ключ (показан единожды) |
| 6 | Превышение scope | `presentations:write` scope, запрос на удаление файлов | HTTP 403, `{"error": "insufficient_scope", "required": "files:write"}` |

---

## US-043: Webhook-система

> Как **разработчик-интегратор**, я хочу получать события системы через Webhook, чтобы интегрировать PresentAI с нашими корпоративными системами.

**Источник:** [webhook_subscriptions](../../../03_backend/01_info_models/relational.md); [webhook_events](../../../03_backend/01_info_models/relational.md) — `status`, `attempts`, `next_retry_at`; [01_architecture/_index.md](../../../01_architecture/_index.md) — Webhook dispatcher, exponential backoff

### FR-046: Управление Webhook-подписками

**Описание:**
- POST `/webhooks` — создание подписки. Параметры: `url` (HTTPS обязательно), `events` (список типов событий), `secret` (для HMAC-SHA256 подписи). Система сохраняет `HMAC-SHA256(secret)` как `secret_hash`. Права: admin.
- GET `/webhooks` — список подписок.
- PATCH `/webhooks/{id}` — обновление `url`, `events`, `is_active`.
- DELETE `/webhooks/{id}` — удаление подписки.

**Поддерживаемые события:**

| Событие | Описание |
|---------|---------|
| `presentation.generation.started` | Начало генерации |
| `presentation.generation.completed` | Генерация завершена |
| `presentation.generation.failed` | Ошибка генерации |
| `presentation.exported` | Экспорт завершён |
| `file.processed` | Индексация документа завершена |

**Приоритет:** Should

**Зависимости:** NFR-004 (HTTPS only, HMAC-SHA256)

### FR-047: Доставка Webhook с гарантиями at-least-once

**Описание:** При возникновении события:
1. Создаётся запись `webhook_events` со статусом `pending`.
2. Webhook Dispatcher выполняет POST на `url` с заголовком `X-PresentAI-Signature: sha256={HMAC_SHA256(payload, secret)}` и `X-PresentAI-Event-Id: {event_id}`.
3. При ответе 2xx — `status = delivered`.
4. При ошибке: exponential backoff retry — 1 мин → 5 мин → 30 мин → 2 ч → 24 ч (максимум 5 попыток).
5. После 5 неудачных попыток — `status = abandoned`; подписка остаётся активной.
6. `event_id` — идемпотентный ключ для получателя.

**Приоритет:** Should

**Зависимости:** FR-046, NFR-005 (поведение при недоступности получателя)

### FR-048: Просмотр истории доставки

**Описание:** GET `/webhooks/{id}/events` — история событий подписки (`webhook_events`): `event_type`, `status`, `attempts`, `last_attempt_at`, `http_status_code`. Хранение: 7 дней. POST `/webhooks/{id}/events/{event_id}/resend` — ручная повторная отправка (для отлаживания).

**Приоритет:** Should

**Зависимости:** FR-047

#### Критерии приёмки FR-046 — FR-048

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Успешная доставка | Endpoint отвечает 200 | `webhook_events.status = delivered`, `attempts = 1` |
| 2 | Retry после 5xx | Endpoint возвращает 500 | Retry через 1 мин → 5 мин → ...; после 5 попыток `status = abandoned` |
| 3 | Верификация подписи | Получатель проверяет HMAC | `X-PresentAI-Signature` совпадает с `HMAC-SHA256(raw_body, secret)` |
| 4 | Идемпотентность | Повторная доставка того же event_id | Получатель идентифицирует дубликат по `X-PresentAI-Event-Id` |
| 5 | HTTP вместо HTTPS | url: `http://...` | HTTP 422, `{"error": "webhook_url_must_be_https"}` |

---

## US-044: Аудит-лог

> Как **администратор организации**, я хочу просматривать журнал всех действий в системе, чтобы контролировать безопасность и расследовать инциденты.

**Источник:** [audit_logs](../../../03_backend/01_info_models/relational.md) — партиционирование по `created_at`, retention 90 дней

### FR-049: Автоматическая запись действий в аудит-лог

**Описание:** Система автоматически записывает в `audit_logs` следующие события:

| Группа | Действия |
|--------|---------|
| Аутентификация | `user.login`, `user.logout`, `user.login_failed`, `user.mfa_enabled` |
| Пользователи | `user.created`, `user.deleted`, `user.role_changed` |
| Данные | `document.uploaded`, `document.deleted`, `presentation.created`, `presentation.deleted` |
| Безопасность | `api_key.created`, `api_key.revoked`, `webhook.created`, `export.downloaded` |
| Биллинг | `subscription.upgraded`, `subscription.canceled` |

Каждая запись: `organization_id`, `user_id` (nullable), `action`, `resource_type`, `resource_id`, `metadata` (JSONB), `ip_address`, `user_agent`, `created_at`.

**Приоритет:** Must

**Зависимости:** NFR-004 (хранение 90 дней), NFR-007 (аудит — требование GDPR и 152-ФЗ)

### FR-050: Просмотр аудит-лога

**Описание:** GET `/organizations/{id}/audit-logs` — список записей с фильтрами: `user_id`, `action`, `resource_type`, `date_from`, `date_to`. Пагинация cursor-based. Права: admin. Экспорт в CSV — POST `/organizations/{id}/audit-logs/export` (асинхронно, ссылка на email).

**Приоритет:** Must

**Зависимости:** FR-049, NFR-001 (запрос к партиционированной таблице ≤ 1 сек)

#### Критерии приёмки FR-049 — FR-050

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Логирование login | Пользователь входит | Запись `action: user.login`, `ip_address`, `user_agent` — в `audit_logs` |
| 2 | Фильтр по action | GET с `action=api_key.revoked` | Только записи об отзыве ключей |
| 3 | Фильтр по дате | date_from: 2026-03-01, date_to: 2026-03-15 | Только записи за указанный период |
| 4 | Viewer читает аудит | GET `/audit-logs`, роль viewer | HTTP 403, `{"error": "insufficient_role", "required": "admin"}` |
| 5 | Удалённый пользователь | Пользователь удалён | `audit_logs.user_id` = UUID сохранён (без FK), запись не удаляется |

---

## US-045: Управление промпт-шаблонами

> Как **администратор системы**, я хочу управлять версиями промпт-шаблонов и проводить A/B-тесты, чтобы улучшать качество генерации без деплоя кода.

**Источник:** [documents.md](../../../03_backend/01_info_models/documents.md) — `prompt_templates` (MongoDB): `template_key`, `version`, `is_active`, `ab_weight`, `quality_metrics`

### FR-051: CRUD промпт-шаблонов

**Описание:**
- GET `/admin/prompt-templates` — список шаблонов с фильтром по `node_type`, `is_active`. Права: системный admin (суперпользователь).
- POST `/admin/prompt-templates` — создание новой версии шаблона. Поля: `template_key`, `node_type`, `system_prompt`, `user_prompt_template`, `variables`, `model_params`. Версия автоматически инкрементируется.
- PATCH `/admin/prompt-templates/{id}` — активация/деактивация, изменение `ab_weight`.
- Деактивация шаблона без активного заменителя — HTTP 422 (нельзя оставить без активного шаблона для данного `node_type`).

**Приоритет:** Should

**Зависимости:** NFR-003 (качество — GPTZero метрика)

### FR-052: A/B тестирование промптов

**Описание:** При наличии нескольких активных шаблонов с одним `template_key` (разные версии с `is_active = true` и `ab_weight < 1.0`) — Generation Service выбирает шаблон случайно, взвешенно по `ab_weight`. Выбранная версия записывается в `generation_traces.outline_step.llm_model`. Quality metrics обновляются вручную после оценки выборки.

**Приоритет:** Should

**Зависимости:** FR-051

### FR-053: Откат промпта на предыдущую версию

**Описание:** PATCH `/admin/prompt-templates/{id}` — установить `is_active = false` для текущей версии, `is_active = true` — для предыдущей. Откат применяется к **новым** задачам генерации; текущие задачи продолжают использовать версию, с которой начали.

**Приоритет:** Should

**Зависимости:** FR-051

#### Критерии приёмки FR-051 — FR-053

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Создание новой версии | POST с `template_key: "outline_generator"` | version = max(existing) + 1, `is_active = false` по умолчанию |
| 2 | Активация | PATCH `is_active: true` для v4 при активной v3 | Обе активны; ab_weight обязан суммироваться ≤ 1.0 в рамках `template_key` |
| 3 | A/B тест | ab_weight v3 = 0.7, v4 = 0.3 | ~70% генераций используют v3, ~30% — v4 (±5% при n ≥ 100) |
| 4 | Деактивация единственного активного | PATCH `is_active: false` при одной активной версии | HTTP 422, `{"error": "cannot_deactivate_only_active_template"}` |

---

### FR-054: Мониторинг качества генерации (Admin Dashboard)

**Описание:** GET `/admin/quality-metrics` возвращает агрегированные метрики из `generation_traces` (MongoDB):
- `avg_total_cost_usd` за последние 24 ч / 7 дней;
- `fallback_triggered_rate` (% генераций с failover на GPT-4o);
- `avg_hallucination_flags_per_presentation`;
- `avg_ai_cliche_removed_per_slide`;
- `avg_similarity_score` из `retrieval_summary`.

Обновление: раз в 15 минут через scheduled Celery task.

**Приоритет:** Should

**Зависимости:** FR-013 (данные из generation_traces), NFR-003

### FR-055: On-premise конфигурация (Enterprise)

**Описание:** Для on-premise деплоя системный администратор через конфигурационный файл (`values.yaml` Helm Chart) задаёт:
- `llm.provider: vllm` и `llm.endpoint: http://local-vllm:8000` — вместо Anthropic API;
- `embeddings.provider: bge-m3` и локальный endpoint;
- `storage.type: minio` и endpoint MinIO;
- `auth.sso.saml_metadata_url` — для корпоративного SAML;
- `compliance.data_residency: ru` — фиксация региона хранения.

Все параметры документированы в README Helm Chart. Цель: полная установка ≤ 4 часов по документации. Параметр `llm.provider` определяет выбор LLM-провайдера без изменения кода приложения.

**Приоритет:** Must (для Enterprise)

**Зависимости:** CON-001 (стек), CON-005 (on-premise требование), NFR-007 (152-ФЗ)

#### Критерии приёмки FR-055

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Установка on-premise | Helm install с `values.yaml`, 4 ч | Система запущена; генерация через vLLM + Llama3 работает |
| 2 | Нет исходящих запросов к Anthropic | Мониторинг сетевых соединений | 0 запросов к api.anthropic.com |
| 3 | Хранение данных локально | Проверка S3/MinIO | Все файлы в локальном MinIO, не в облаке |

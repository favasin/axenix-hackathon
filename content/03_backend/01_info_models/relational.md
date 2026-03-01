---
title: "Реляционные таблицы (PostgreSQL)"
description: "Детальное описание схемы PostgreSQL 16: таблицы, индексы, ограничения, триггеры."
weight: 2
draft: false
slug: "relational"
titleIcon: "fa-solid fa-table"
---

# Реляционные таблицы PostgreSQL 16

> **Схема:** `public` (Free/Pro) / `tenant_{id}` (Enterprise)
> **Расширения:** `uuid-ossp`, `pgcrypto`, `pg_trgm`, `btree_gin`

---

## Enum-типы (глобальные)

```sql
CREATE TYPE org_role AS ENUM ('admin', 'editor', 'viewer');
CREATE TYPE oauth_provider AS ENUM ('google', 'microsoft', 'notion', 'confluence');
CREATE TYPE subscription_status AS ENUM ('active', 'trialing', 'past_due', 'canceled', 'expired');
CREATE TYPE presentation_status AS ENUM ('draft', 'outline_ready', 'generating', 'ready', 'error');
CREATE TYPE tone_type AS ENUM ('formal', 'business', 'persuasive', 'technical', 'educational', 'friendly');
CREATE TYPE slide_type AS ENUM ('title_slide', 'content', 'chart', 'table', 'image', 'quote', 'divider');
CREATE TYPE slide_status AS ENUM ('pending', 'generating', 'ready', 'error');
CREATE TYPE source_file_type AS ENUM ('pdf', 'docx', 'xlsx', 'csv', 'pptx', 'url', 'image', 'txt');
CREATE TYPE ingestion_status AS ENUM ('pending', 'processing', 'indexed', 'failed');
CREATE TYPE job_status AS ENUM ('pending', 'running', 'completed', 'failed', 'retrying');
CREATE TYPE llm_provider AS ENUM ('claude', 'gpt4o', 'llama3', 'gemini');
CREATE TYPE export_format AS ENUM ('pptx', 'pdf', 'google_slides', 'png', 'web');
CREATE TYPE share_access AS ENUM ('view', 'comment', 'edit');
CREATE TYPE webhook_status AS ENUM ('pending', 'delivered', 'failed', 'abandoned');
```

---

## Таблица: `users`

**Домен:** Auth
**Назначение:** Учётные записи пользователей системы.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| email | VARCHAR(255) | ✓ | — | UNIQUE | Email — основной идентификатор |
| name | VARCHAR(255) | ✓ | — | — | Отображаемое имя |
| avatar_url | TEXT | ✗ | NULL | — | URL аватара (S3 или внешний) |
| is_email_verified | BOOLEAN | ✓ | FALSE | — | Подтверждён ли email |
| last_login_at | TIMESTAMPTZ | ✗ | NULL | — | Время последнего входа |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата регистрации |
| updated_at | TIMESTAMPTZ | ✓ | now() | — | Дата последнего обновления |
| deleted_at | TIMESTAMPTZ | ✗ | NULL | — | Soft delete: дата удаления |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| users_pkey | id | BTREE UNIQUE | — | PK |
| users_email_key | email | BTREE UNIQUE | — | Логин по email, быстрый поиск |
| users_active_idx | deleted_at | BTREE | WHERE deleted_at IS NULL | Фильтр активных пользователей |

### Ограничения

- CHECK: `email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'` — базовая валидация формата email

### Триггеры

- `trg_users_updated_at` — обновляет `updated_at = now()` перед каждым UPDATE

### Типичные запросы

```sql
-- Поиск пользователя по email при логине
SELECT id, name, is_email_verified
FROM users
WHERE email = $1 AND deleted_at IS NULL;

-- Soft delete пользователя (GDPR right-to-erasure)
UPDATE users
SET deleted_at = now(), email = 'deleted_' || id || '@deleted.invalid', name = 'Deleted User'
WHERE id = $1 AND deleted_at IS NULL;
```

### Связи

- `organization_members` (один ко многим) через `user_id`
- `oauth_connections` (один ко многим) через `user_id`
- `api_keys` (один ко многим) через `created_by`
- `presentations` (один ко многим) через `created_by`

---

## Таблица: `organizations`

**Домен:** Auth
**Назначение:** Тенанты — компании или команды, единица изоляции данных.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| name | VARCHAR(255) | ✓ | — | — | Название организации |
| slug | VARCHAR(100) | ✓ | — | UNIQUE | URL-friendly идентификатор |
| logo_url | TEXT | ✗ | NULL | — | URL логотипа организации |
| website | TEXT | ✗ | NULL | — | Сайт компании |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания |
| updated_at | TIMESTAMPTZ | ✓ | now() | — | Дата обновления |
| deleted_at | TIMESTAMPTZ | ✗ | NULL | — | Soft delete |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| organizations_pkey | id | BTREE UNIQUE | — | PK |
| organizations_slug_key | slug | BTREE UNIQUE | — | Поиск по slug в URL |
| organizations_active_idx | deleted_at | BTREE | WHERE deleted_at IS NULL | Фильтр активных |

### Ограничения

- CHECK: `slug ~ '^[a-z0-9-]{3,100}$'` — только строчные буквы, цифры, дефис

### Триггеры

- `trg_organizations_updated_at` — обновляет `updated_at` при UPDATE

### Типичные запросы

```sql
-- Получить организацию по slug
SELECT id, name, logo_url
FROM organizations
WHERE slug = $1 AND deleted_at IS NULL;
```

### Связи

- `organization_members` (один ко многим) через `organization_id`
- `subscriptions` (один к одному) через `organization_id`
- `projects` (один ко многим) через `organization_id`
- `brand_kits` (один ко многим) через `organization_id`

---

## Таблица: `organization_members`

**Домен:** Auth
**Назначение:** Связь пользователей с организацией и их ролевые права.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| organization_id | UUID | ✓ | — | FK | Организация |
| user_id | UUID | ✓ | — | FK | Пользователь |
| role | org_role | ✓ | 'viewer' | — | Роль: admin / editor / viewer |
| invited_by | UUID | ✗ | NULL | FK | Кто пригласил |
| joined_at | TIMESTAMPTZ | ✗ | NULL | — | Дата принятия приглашения |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания записи |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| org_members_pkey | id | BTREE UNIQUE | — | PK |
| org_members_org_user_key | (organization_id, user_id) | BTREE UNIQUE | — | Пользователь уникален в орг. |
| org_members_user_idx | user_id | BTREE | — | Организации пользователя |

### Ограничения

- FK: `organization_id` → `organizations.id` ON DELETE CASCADE
- FK: `user_id` → `users.id` ON DELETE CASCADE
- FK: `invited_by` → `users.id` ON DELETE SET NULL

### Enum-типы

```sql
CREATE TYPE org_role AS ENUM ('admin', 'editor', 'viewer');
```

### Типичные запросы

```sql
-- Проверить роль пользователя в организации
SELECT role FROM organization_members
WHERE organization_id = $1 AND user_id = $2;

-- Список участников организации с данными пользователя
SELECT u.id, u.name, u.email, om.role, om.joined_at
FROM organization_members om
JOIN users u ON u.id = om.user_id
WHERE om.organization_id = $1
ORDER BY om.role, u.name;
```

### Связи

- `organizations` (многие к одному) через `organization_id`
- `users` (многие к одному) через `user_id`

---

## Таблица: `oauth_connections`

**Домен:** Auth
**Назначение:** OAuth 2.0 токены для интеграций с внешними сервисами (Google Drive, OneDrive, Notion, Confluence).

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| user_id | UUID | ✓ | — | FK | Владелец токена |
| provider | oauth_provider | ✓ | — | — | Провайдер OAuth |
| provider_user_id | VARCHAR(255) | ✓ | — | — | ID пользователя у провайдера |
| access_token_encrypted | BYTEA | ✓ | — | — | Зашифрованный access token (AES-256-GCM) |
| refresh_token_encrypted | BYTEA | ✗ | NULL | — | Зашифрованный refresh token |
| token_expires_at | TIMESTAMPTZ | ✗ | NULL | — | Срок истечения access token |
| scopes | TEXT[] | ✓ | '{}' | — | Разрешённые scopes |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания |
| updated_at | TIMESTAMPTZ | ✓ | now() | — | Дата обновления токена |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| oauth_pkey | id | BTREE UNIQUE | — | PK |
| oauth_user_provider_key | (user_id, provider) | BTREE UNIQUE | — | Один токен на провайдера |
| oauth_expires_idx | token_expires_at | BTREE | WHERE token_expires_at < now() | Поиск истёкших для refresh |

### Ограничения

- FK: `user_id` → `users.id` ON DELETE CASCADE

### Триггеры

- `trg_oauth_updated_at` — обновляет `updated_at` при UPDATE (рефреш токена)

### Типичные запросы

```sql
-- Получить токен для провайдера (перед вызовом внешнего API)
SELECT access_token_encrypted, token_expires_at, refresh_token_encrypted
FROM oauth_connections
WHERE user_id = $1 AND provider = $2;
```

### Связи

- `users` (многие к одному) через `user_id`

---

## Таблица: `api_keys`

**Домен:** Auth
**Назначение:** API-ключи организаций для публичного REST API.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| organization_id | UUID | ✓ | — | FK | Организация-владелец |
| name | VARCHAR(100) | ✓ | — | — | Название ключа (для отображения) |
| key_hash | CHAR(64) | ✓ | — | UNIQUE | SHA-256 хеш ключа |
| key_prefix | CHAR(8) | ✓ | — | — | Первые 8 символов для идентификации |
| scopes | TEXT[] | ✓ | '{}' | — | Разрешения: read, write, admin |
| rate_limit_per_minute | INT | ✗ | NULL | CHECK > 0 | Лимит запросов (NULL = план default) |
| created_by | UUID | ✓ | — | FK | Кто создал |
| expires_at | TIMESTAMPTZ | ✗ | NULL | — | Срок действия (NULL = бессрочный) |
| last_used_at | TIMESTAMPTZ | ✗ | NULL | — | Последнее использование |
| revoked_at | TIMESTAMPTZ | ✗ | NULL | — | Дата отзыва |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| api_keys_pkey | id | BTREE UNIQUE | — | PK |
| api_keys_hash_key | key_hash | BTREE UNIQUE | — | Валидация ключа при запросе |
| api_keys_org_idx | organization_id | BTREE | WHERE revoked_at IS NULL | Активные ключи организации |

### Ограничения

- FK: `organization_id` → `organizations.id` ON DELETE CASCADE
- FK: `created_by` → `users.id` ON DELETE RESTRICT
- CHECK: `rate_limit_per_minute > 0 OR rate_limit_per_minute IS NULL` — лимит положительный

### Типичные запросы

```sql
-- Валидация API ключа (вычислить SHA-256 на уровне приложения)
SELECT ak.id, ak.organization_id, ak.scopes, ak.rate_limit_per_minute
FROM api_keys ak
WHERE ak.key_hash = $1
  AND ak.revoked_at IS NULL
  AND (ak.expires_at IS NULL OR ak.expires_at > now());
```

### Связи

- `organizations` (многие к одному) через `organization_id`
- `users` (многие к одному) через `created_by`

---

## Таблица: `plans`

**Домен:** Billing
**Назначение:** Тарифные планы с лимитами использования.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| name | VARCHAR(50) | ✓ | — | UNIQUE | Название: free, pro, team, enterprise |
| max_users | INT | ✗ | NULL | CHECK > 0 | Лимит пользователей (NULL = ∞) |
| max_presentations_per_month | INT | ✗ | NULL | CHECK > 0 | Лимит презентаций в месяц |
| max_file_size_mb | INT | ✓ | — | CHECK > 0 | Макс. размер загружаемого файла |
| max_source_files_per_pres | INT | ✓ | 5 | CHECK > 0 | Макс. источников на презентацию |
| ai_tokens_per_month | BIGINT | ✗ | NULL | CHECK > 0 | Лимит AI-токенов в месяц |
| storage_gb | INT | ✓ | — | CHECK > 0 | Дисковое пространство GB |
| features | JSONB | ✓ | '{}' | — | Feature-флаги плана |
| price_monthly_usd | NUMERIC(10,2) | ✗ | NULL | CHECK >= 0 | Цена в месяц |
| price_yearly_usd | NUMERIC(10,2) | ✗ | NULL | CHECK >= 0 | Цена в год |
| is_active | BOOLEAN | ✓ | TRUE | — | Доступен ли для оформления |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания |
| updated_at | TIMESTAMPTZ | ✓ | now() | — | Дата обновления |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| plans_pkey | id | BTREE UNIQUE | — | PK |
| plans_name_key | name | BTREE UNIQUE | — | Уникальность имени |
| plans_active_idx | is_active | BTREE | WHERE is_active = TRUE | Список доступных планов |

### Типичные запросы

```sql
-- Получить все активные тарифы для pricing page
SELECT id, name, max_users, ai_tokens_per_month, price_monthly_usd, features
FROM plans
WHERE is_active = TRUE
ORDER BY price_monthly_usd NULLS FIRST;
```

### Связи

- `subscriptions` (один ко многим) через `plan_id`

---

## Таблица: `subscriptions`

**Домен:** Billing
**Назначение:** Подписка организации на тарифный план.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| organization_id | UUID | ✓ | — | FK UNIQUE | Организация (1:1) |
| plan_id | UUID | ✓ | — | FK | Текущий план |
| status | subscription_status | ✓ | 'trialing' | — | Статус подписки |
| current_period_start | TIMESTAMPTZ | ✓ | — | — | Начало расчётного периода |
| current_period_end | TIMESTAMPTZ | ✓ | — | — | Конец расчётного периода |
| external_subscription_id | VARCHAR(255) | ✗ | NULL | — | Stripe subscription ID |
| cancel_at_period_end | BOOLEAN | ✓ | FALSE | — | Отменить в конце периода |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания |
| updated_at | TIMESTAMPTZ | ✓ | now() | — | Дата обновления |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| subscriptions_pkey | id | BTREE UNIQUE | — | PK |
| subscriptions_org_key | organization_id | BTREE UNIQUE | — | Одна подписка на орг. |
| subscriptions_period_idx | current_period_end | BTREE | WHERE status = 'active' | Поиск истекающих подписок |

### Ограничения

- FK: `organization_id` → `organizations.id` ON DELETE CASCADE
- FK: `plan_id` → `plans.id` ON DELETE RESTRICT
- CHECK: `current_period_end > current_period_start` — корректный период

### Enum-типы

```sql
CREATE TYPE subscription_status AS ENUM ('active', 'trialing', 'past_due', 'canceled', 'expired');
```

### Триггеры

- `trg_subscriptions_updated_at` — обновляет `updated_at` при UPDATE

### Типичные запросы

```sql
-- Получить план организации (JOIN для лимитов)
SELECT p.max_presentations_per_month, p.ai_tokens_per_month, p.features, s.status
FROM subscriptions s
JOIN plans p ON p.id = s.plan_id
WHERE s.organization_id = $1;
```

### Связи

- `organizations` (многие к одному) через `organization_id`
- `plans` (многие к одному) через `plan_id`

---

## Таблица: `usage_records`

**Домен:** Billing
**Назначение:** Учёт потребления ресурсов по периодам для биллинга и fair-use мониторинга.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| organization_id | UUID | ✓ | — | FK | Организация |
| period_start | DATE | ✓ | — | — | Начало периода (1-е число месяца) |
| period_end | DATE | ✓ | — | — | Конец периода |
| presentations_generated | INT | ✓ | 0 | CHECK >= 0 | Сгенерировано презентаций |
| slides_generated | INT | ✓ | 0 | CHECK >= 0 | Сгенерировано слайдов |
| tokens_used | BIGINT | ✓ | 0 | CHECK >= 0 | Использовано LLM-токенов |
| storage_bytes_used | BIGINT | ✓ | 0 | CHECK >= 0 | Использовано байт хранилища |
| cost_usd | NUMERIC(12,4) | ✓ | 0 | CHECK >= 0 | Стоимость LLM-вызовов в USD |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания |
| updated_at | TIMESTAMPTZ | ✓ | now() | — | Дата обновления |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| usage_pkey | id | BTREE UNIQUE | — | PK |
| usage_org_period_key | (organization_id, period_start) | BTREE UNIQUE | — | Один период на организацию |
| usage_period_idx | period_start DESC | BTREE | — | Текущий и прошлый периоды |

### Ограничения

- FK: `organization_id` → `organizations.id` ON DELETE CASCADE
- CHECK: `period_end > period_start` — корректный диапазон

### Типичные запросы

```sql
-- Использование организации в текущем месяце
SELECT presentations_generated, tokens_used, cost_usd
FROM usage_records
WHERE organization_id = $1
  AND period_start = date_trunc('month', now())::DATE;

-- Атомарное увеличение счётчиков (UPSERT)
INSERT INTO usage_records (organization_id, period_start, period_end, slides_generated, tokens_used, cost_usd)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (organization_id, period_start)
DO UPDATE SET
    slides_generated = usage_records.slides_generated + EXCLUDED.slides_generated,
    tokens_used = usage_records.tokens_used + EXCLUDED.tokens_used,
    cost_usd = usage_records.cost_usd + EXCLUDED.cost_usd,
    updated_at = now();
```

### Связи

- `organizations` (многие к одному) через `organization_id`

---

## Таблица: `brand_kits`

**Домен:** Presentation
**Назначение:** Корпоративный стиль организации — цвета, шрифты, логотип, шаблон.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| organization_id | UUID | ✓ | — | FK | Организация-владелец |
| name | VARCHAR(100) | ✓ | — | — | Название кита |
| is_default | BOOLEAN | ✓ | FALSE | — | Применяется ли по умолчанию |
| primary_color | CHAR(7) | ✗ | NULL | CHECK ~* | HEX цвет #RRGGBB |
| secondary_color | CHAR(7) | ✗ | NULL | CHECK ~* | HEX цвет |
| background_color | CHAR(7) | ✗ | NULL | CHECK ~* | HEX цвет фона |
| accent_color | CHAR(7) | ✗ | NULL | CHECK ~* | HEX акцентный цвет |
| text_color | CHAR(7) | ✗ | NULL | CHECK ~* | HEX цвет текста |
| logo_url | TEXT | ✗ | NULL | — | URL логотипа (SVG/PNG) |
| font_heading | VARCHAR(100) | ✗ | NULL | — | Шрифт заголовков |
| font_body | VARCHAR(100) | ✗ | NULL | — | Шрифт тела |
| additional_settings | JSONB | ✗ | '{}' | — | Дополнительные параметры |
| template_s3_key | TEXT | ✗ | NULL | — | S3-ключ PPTX-шаблона |
| created_by | UUID | ✓ | — | FK | Кто создал |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания |
| updated_at | TIMESTAMPTZ | ✓ | now() | — | Дата обновления |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| brand_kits_pkey | id | BTREE UNIQUE | — | PK |
| brand_kits_org_name_key | (organization_id, name) | BTREE UNIQUE | — | Уникальность имени в организации |
| brand_kits_org_default_idx | (organization_id, is_default) | BTREE | WHERE is_default = TRUE | Быстрый доступ к дефолтному |

### Ограничения

- FK: `organization_id` → `organizations.id` ON DELETE CASCADE
- FK: `created_by` → `users.id` ON DELETE RESTRICT
- CHECK: `primary_color ~* '^#[0-9A-F]{6}$'` — формат HEX-цвета (аналогично для всех color полей)

### Триггеры

- `trg_brand_kits_single_default` — при установке `is_default = TRUE` снимает флаг со всех других кит-сетов организации:

```sql
CREATE OR REPLACE FUNCTION fn_ensure_single_default_brand_kit()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_default = TRUE THEN
        UPDATE brand_kits
        SET is_default = FALSE
        WHERE organization_id = NEW.organization_id AND id != NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### Типичные запросы

```sql
-- Получить дефолтный Brand Kit организации
SELECT id, primary_color, secondary_color, font_heading, font_body, logo_url, template_s3_key
FROM brand_kits
WHERE organization_id = $1 AND is_default = TRUE;
```

### Связи

- `organizations` (многие к одному) через `organization_id`
- `presentations` (один ко многим) через `brand_kit_id`

---

## Таблица: `projects`

**Домен:** Presentation
**Назначение:** Контейнер для группировки презентаций внутри организации.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| organization_id | UUID | ✓ | — | FK | Организация-владелец |
| name | VARCHAR(255) | ✓ | — | — | Название проекта |
| description | TEXT | ✗ | NULL | — | Описание проекта |
| is_archived | BOOLEAN | ✓ | FALSE | — | Архивирован ли |
| created_by | UUID | ✓ | — | FK | Создатель |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания |
| updated_at | TIMESTAMPTZ | ✓ | now() | — | Дата обновления |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| projects_pkey | id | BTREE UNIQUE | — | PK |
| projects_org_idx | (organization_id, is_archived) | BTREE | WHERE is_archived = FALSE | Активные проекты организации |
| projects_created_by_idx | created_by | BTREE | — | Проекты пользователя |

### Ограничения

- FK: `organization_id` → `organizations.id` ON DELETE CASCADE
- FK: `created_by` → `users.id` ON DELETE RESTRICT

### Типичные запросы

```sql
-- Список активных проектов с количеством презентаций
SELECT p.id, p.name, p.description, COUNT(pr.id) AS presentation_count
FROM projects p
LEFT JOIN presentations pr ON pr.project_id = p.id AND pr.deleted_at IS NULL
WHERE p.organization_id = $1 AND p.is_archived = FALSE
GROUP BY p.id
ORDER BY p.updated_at DESC;
```

### Связи

- `organizations` (многие к одному) через `organization_id`
- `presentations` (один ко многим) через `project_id`

---

## Таблица: `presentations`

**Домен:** Presentation
**Назначение:** Основная сущность — презентация со всеми метаданными.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| project_id | UUID | ✓ | — | FK | Проект-контейнер |
| title | VARCHAR(500) | ✓ | — | — | Заголовок презентации |
| description | TEXT | ✗ | NULL | — | Описание / промпт |
| status | presentation_status | ✓ | 'draft' | — | Статус жизненного цикла |
| tone | tone_type | ✗ | NULL | — | Тональность |
| target_audience | VARCHAR(100) | ✗ | NULL | — | Целевая аудитория |
| language | CHAR(5) | ✓ | 'ru' | — | Язык (BCP 47: ru, en-US…) |
| slide_count | INT | ✓ | 0 | CHECK >= 0 | Денормализованный счётчик слайдов |
| thumbnail_url | TEXT | ✗ | NULL | — | URL превью |
| brand_kit_id | UUID | ✗ | NULL | FK | Применённый Brand Kit |
| current_generation_job_id | UUID | ✗ | NULL | — | Текущая задача генерации (soft FK) |
| created_by | UUID | ✓ | — | FK | Создатель |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания |
| updated_at | TIMESTAMPTZ | ✓ | now() | — | Дата обновления |
| deleted_at | TIMESTAMPTZ | ✗ | NULL | — | Soft delete |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| presentations_pkey | id | BTREE UNIQUE | — | PK |
| presentations_project_idx | (project_id, created_at DESC) | BTREE | WHERE deleted_at IS NULL | Список презентаций проекта |
| presentations_creator_idx | (created_by, status) | BTREE | WHERE deleted_at IS NULL | Мои презентации по статусу |
| presentations_status_idx | status | BTREE | WHERE status IN ('generating') | Мониторинг активных генераций |

### Ограничения

- FK: `project_id` → `projects.id` ON DELETE CASCADE
- FK: `brand_kit_id` → `brand_kits.id` ON DELETE SET NULL
- FK: `created_by` → `users.id` ON DELETE RESTRICT

### Enum-типы

```sql
CREATE TYPE presentation_status AS ENUM ('draft', 'outline_ready', 'generating', 'ready', 'error');
CREATE TYPE tone_type AS ENUM ('formal', 'business', 'persuasive', 'technical', 'educational', 'friendly');
```

### Триггеры

- `trg_presentations_updated_at` — обновляет `updated_at` при UPDATE
- `trg_presentations_slide_count` — обновляет `slide_count` при INSERT/DELETE в таблице `slides`:

```sql
CREATE OR REPLACE FUNCTION fn_update_slide_count()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE presentations
    SET slide_count = (SELECT COUNT(*) FROM slides WHERE presentation_id = COALESCE(NEW.presentation_id, OLD.presentation_id)),
        updated_at = now()
    WHERE id = COALESCE(NEW.presentation_id, OLD.presentation_id);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
```

### Типичные запросы

```sql
-- Список презентаций в проекте с пагинацией
SELECT id, title, status, slide_count, thumbnail_url, created_at, updated_at
FROM presentations
WHERE project_id = $1 AND deleted_at IS NULL
ORDER BY updated_at DESC
LIMIT 20 OFFSET $2;

-- Полная презентация со слайдами (при открытии редактора)
SELECT p.*, json_agg(
    json_build_object('id', s.id, 'position', s.position, 'title', s.title,
                      'slide_type', s.slide_type, 'status', s.status, 'content', s.content)
    ORDER BY s.position
) AS slides
FROM presentations p
LEFT JOIN slides s ON s.presentation_id = p.id
WHERE p.id = $1 AND p.deleted_at IS NULL
GROUP BY p.id;
```

### Связи

- `projects` (многие к одному) через `project_id`
- `slides` (один ко многим) через `presentation_id`
- `brand_kits` (многие к одному) через `brand_kit_id`
- `generation_jobs` (один ко многим) через `presentation_id`
- `export_jobs` (один ко многим) через `presentation_id`
- `presentation_sources` (один ко многим) через `presentation_id`

---

## Таблица: `slides`

**Домен:** Presentation
**Назначение:** Отдельный слайд презентации с контентом и метаданными атрибуции.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| presentation_id | UUID | ✓ | — | FK | Родительская презентация |
| position | SMALLINT | ✓ | — | CHECK > 0 | Порядковый номер (1-based) |
| title | TEXT | ✗ | NULL | — | Заголовок слайда |
| content | JSONB | ✓ | '{}' | — | Контент: блоки текста, графики, таблицы |
| slide_type | slide_type | ✓ | 'content' | — | Тип слайда |
| status | slide_status | ✓ | 'pending' | — | Статус генерации |
| source_refs | JSONB | ✓ | '[]' | — | Ссылки на источники для attribution |
| hallucination_flags | JSONB | ✓ | '[]' | — | Флаги проверки фактов |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания |
| updated_at | TIMESTAMPTZ | ✓ | now() | — | Дата обновления |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| slides_pkey | id | BTREE UNIQUE | — | PK |
| slides_presentation_pos_key | (presentation_id, position) | BTREE UNIQUE | — | Уникальность позиции |
| slides_pres_status_idx | (presentation_id, status) | BTREE | WHERE status != 'ready' | Мониторинг незавершённых слайдов |

### Ограничения

- FK: `presentation_id` → `presentations.id` ON DELETE CASCADE
- CHECK: `position > 0` — позиция положительная

### Enum-типы

```sql
CREATE TYPE slide_type AS ENUM ('title_slide', 'content', 'chart', 'table', 'image', 'quote', 'divider');
CREATE TYPE slide_status AS ENUM ('pending', 'generating', 'ready', 'error');
```

### Триггеры

- `trg_slides_updated_at` — обновляет `updated_at` при UPDATE
- `trg_slides_version_snapshot` — при UPDATE создаёт запись в `slide_versions` (если контент изменился):

```sql
CREATE OR REPLACE FUNCTION fn_snapshot_slide_version()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.content IS DISTINCT FROM NEW.content THEN
        INSERT INTO slide_versions (slide_id, version_number, content, created_by, created_at)
        VALUES (
            OLD.id,
            (SELECT COALESCE(MAX(version_number), 0) + 1 FROM slide_versions WHERE slide_id = OLD.id),
            OLD.content,
            current_setting('app.current_user_id', true)::uuid,
            now()
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### Типичные запросы

```sql
-- Слайды презентации в порядке
SELECT id, position, title, slide_type, status, content, source_refs
FROM slides
WHERE presentation_id = $1
ORDER BY position;

-- Обновление контента слайда (инициирует триггер версионирования)
UPDATE slides
SET content = $2, status = 'ready', updated_at = now()
WHERE id = $1;
```

### Связи

- `presentations` (многие к одному) через `presentation_id`
- `slide_versions` (один ко многим) через `slide_id`

---

## Таблица: `slide_versions`

**Домен:** Presentation
**Назначение:** История версий контента слайда (до 20 версий согласно US-405).

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| slide_id | UUID | ✓ | — | FK | Родительский слайд |
| version_number | SMALLINT | ✓ | — | CHECK > 0 | Номер версии |
| content | JSONB | ✓ | — | — | Снимок контента слайда |
| created_by | UUID | ✗ | NULL | FK | Кто инициировал изменение |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Время создания версии |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| slide_versions_pkey | id | BTREE UNIQUE | — | PK |
| slide_ver_slide_num_key | (slide_id, version_number) | BTREE UNIQUE | — | Уникальность версии |
| slide_ver_slide_idx | (slide_id, version_number DESC) | BTREE | — | История версий в обратном порядке |

### Ограничения

- FK: `slide_id` → `slides.id` ON DELETE CASCADE
- FK: `created_by` → `users.id` ON DELETE SET NULL
- CHECK: `version_number > 0`

### Типичные запросы

```sql
-- История версий слайда (до 20 записей)
SELECT version_number, created_at, created_by
FROM slide_versions
WHERE slide_id = $1
ORDER BY version_number DESC
LIMIT 20;

-- Восстановить версию N
UPDATE slides
SET content = (SELECT content FROM slide_versions WHERE slide_id = $1 AND version_number = $2)
WHERE id = $1;
```

### Связи

- `slides` (многие к одному) через `slide_id`

---

## Таблица: `presentation_shares`

**Домен:** Presentation
**Назначение:** Публичные ссылки для просмотра / комментирования / редактирования презентации.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| presentation_id | UUID | ✓ | — | FK | Презентация |
| token | CHAR(32) | ✓ | — | UNIQUE | Случайный токен ссылки |
| access_level | share_access | ✓ | 'view' | — | Уровень доступа |
| password_hash | TEXT | ✗ | NULL | — | Хеш пароля (bcrypt, если защищена) |
| expires_at | TIMESTAMPTZ | ✗ | NULL | — | Срок действия (NULL = бессрочная) |
| view_count | INT | ✓ | 0 | CHECK >= 0 | Счётчик просмотров |
| created_by | UUID | ✓ | — | FK | Кто создал |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| shares_pkey | id | BTREE UNIQUE | — | PK |
| shares_token_key | token | BTREE UNIQUE | — | Быстрый поиск по токену из URL |
| shares_pres_idx | presentation_id | BTREE | — | Ссылки презентации |

### Ограничения

- FK: `presentation_id` → `presentations.id` ON DELETE CASCADE
- FK: `created_by` → `users.id` ON DELETE RESTRICT

### Enum-типы

```sql
CREATE TYPE share_access AS ENUM ('view', 'comment', 'edit');
```

### Типичные запросы

```sql
-- Валидация токена ссылки
SELECT ps.presentation_id, ps.access_level, ps.password_hash
FROM presentation_shares ps
WHERE ps.token = $1
  AND (ps.expires_at IS NULL OR ps.expires_at > now());
```

### Связи

- `presentations` (многие к одному) через `presentation_id`

---

## Таблица: `source_documents`

**Домен:** AI
**Назначение:** Метаданные исходных документов, загруженных пользователем для RAG-пайплайна.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| organization_id | UUID | ✓ | — | FK | Организация-владелец |
| original_filename | TEXT | ✓ | — | — | Оригинальное имя файла |
| file_type | source_file_type | ✓ | — | — | Тип источника |
| s3_key | TEXT | ✗ | NULL | — | S3-ключ файла (NULL для URL) |
| file_size_bytes | BIGINT | ✗ | NULL | CHECK >= 0 | Размер файла |
| content_hash | CHAR(64) | ✗ | NULL | — | SHA-256 для дедупликации |
| url | TEXT | ✗ | NULL | — | URL веб-источника |
| ingestion_status | ingestion_status | ✓ | 'pending' | — | Статус обработки |
| page_count | INT | ✗ | NULL | CHECK >= 0 | Количество страниц |
| word_count | INT | ✗ | NULL | CHECK >= 0 | Количество слов |
| created_by | UUID | ✓ | — | FK | Загрузил |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата загрузки |
| updated_at | TIMESTAMPTZ | ✓ | now() | — | Дата обновления |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| source_docs_pkey | id | BTREE UNIQUE | — | PK |
| source_docs_hash_idx | content_hash | BTREE | WHERE content_hash IS NOT NULL | Дедупликация файлов |
| source_docs_org_status_idx | (organization_id, ingestion_status) | BTREE | — | Фильтр по статусу индексации |
| source_docs_org_idx | organization_id | BTREE | — | Документы организации |

### Ограничения

- FK: `organization_id` → `organizations.id` ON DELETE CASCADE
- FK: `created_by` → `users.id` ON DELETE RESTRICT
- CHECK: `(s3_key IS NOT NULL AND url IS NULL) OR (s3_key IS NULL AND url IS NOT NULL)` — либо файл, либо URL

### Enum-типы

```sql
CREATE TYPE source_file_type AS ENUM ('pdf', 'docx', 'xlsx', 'csv', 'pptx', 'url', 'image', 'txt');
CREATE TYPE ingestion_status AS ENUM ('pending', 'processing', 'indexed', 'failed');
```

### Типичные запросы

```sql
-- Проверить дубликат перед загрузкой
SELECT id, ingestion_status FROM source_documents
WHERE organization_id = $1 AND content_hash = $2;

-- Источники, использованные в презентации
SELECT sd.id, sd.original_filename, sd.file_type, sd.ingestion_status
FROM source_documents sd
JOIN presentation_sources ps ON ps.source_document_id = sd.id
WHERE ps.presentation_id = $1;
```

### Связи

- `organizations` (многие к одному) через `organization_id`
- `presentation_sources` (один ко многим) через `source_document_id`
- `document_ingestion_jobs` (один ко многим) через `source_document_id`

---

## Таблица: `presentation_sources`

**Домен:** AI
**Назначение:** Связь M:N между презентациями и исходными документами.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| presentation_id | UUID | ✓ | — | FK | Презентация |
| source_document_id | UUID | ✓ | — | FK | Исходный документ |
| added_at | TIMESTAMPTZ | ✓ | now() | — | Когда добавлен источник |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| pres_sources_pkey | id | BTREE UNIQUE | — | PK |
| pres_sources_unique_key | (presentation_id, source_document_id) | BTREE UNIQUE | — | Нет дублей |
| pres_sources_pres_idx | presentation_id | BTREE | — | Источники презентации |
| pres_sources_doc_idx | source_document_id | BTREE | — | Презентации, использующие документ |

### Ограничения

- FK: `presentation_id` → `presentations.id` ON DELETE CASCADE
- FK: `source_document_id` → `source_documents.id` ON DELETE RESTRICT

### Связи

- `presentations` (многие к одному) через `presentation_id`
- `source_documents` (многие к одному) через `source_document_id`

---

## Таблица: `document_ingestion_jobs`

**Домен:** AI
**Назначение:** Задачи асинхронной обработки документа (chunking + embedding + Qdrant).

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| source_document_id | UUID | ✓ | — | FK | Обрабатываемый документ |
| status | job_status | ✓ | 'pending' | — | Статус задачи |
| chunks_created | INT | ✗ | NULL | CHECK >= 0 | Создано чанков |
| embeddings_created | INT | ✗ | NULL | CHECK >= 0 | Создано embeddings |
| worker_id | VARCHAR(100) | ✗ | NULL | — | Celery worker ID |
| started_at | TIMESTAMPTZ | ✗ | NULL | — | Начало обработки |
| completed_at | TIMESTAMPTZ | ✗ | NULL | — | Окончание обработки |
| error_message | TEXT | ✗ | NULL | — | Сообщение об ошибке |
| retry_count | SMALLINT | ✓ | 0 | CHECK >= 0 | Количество повторов |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| ingest_jobs_pkey | id | BTREE UNIQUE | — | PK |
| ingest_jobs_doc_idx | source_document_id | BTREE | — | Задачи документа |
| ingest_jobs_pending_idx | (created_at, status) | BTREE | WHERE status = 'pending' | Очередь задач для Celery |

### Ограничения

- FK: `source_document_id` → `source_documents.id` ON DELETE CASCADE

### Enum-типы

```sql
CREATE TYPE job_status AS ENUM ('pending', 'running', 'completed', 'failed', 'retrying');
```

### Связи

- `source_documents` (многие к одному) через `source_document_id`

---

## Таблица: `generation_jobs`

**Домен:** AI
**Назначение:** Задачи генерации презентаций через LLM (LangGraph pipeline).

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| presentation_id | UUID | ✓ | — | FK | Целевая презентация |
| status | job_status | ✓ | 'pending' | — | Статус задачи |
| llm_provider | llm_provider | ✗ | NULL | — | Использованный LLM |
| outline_tokens_used | INT | ✗ | NULL | CHECK >= 0 | Токены на генерацию outline |
| generation_tokens_used | INT | ✗ | NULL | CHECK >= 0 | Токены на генерацию слайдов |
| total_tokens_used | INT | ✗ | NULL | CHECK >= 0 | Суммарные токены |
| total_cost_usd | NUMERIC(10,6) | ✗ | NULL | CHECK >= 0 | Стоимость генерации |
| slides_completed | INT | ✓ | 0 | CHECK >= 0 | Готово слайдов |
| slides_total | INT | ✗ | NULL | CHECK > 0 | Всего слайдов |
| worker_id | VARCHAR(100) | ✗ | NULL | — | Celery worker ID |
| started_at | TIMESTAMPTZ | ✗ | NULL | — | Начало генерации |
| completed_at | TIMESTAMPTZ | ✗ | NULL | — | Окончание генерации |
| error_message | TEXT | ✗ | NULL | — | Сообщение об ошибке |
| retry_count | SMALLINT | ✓ | 0 | CHECK >= 0 | Количество повторов |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| gen_jobs_pkey | id | BTREE UNIQUE | — | PK |
| gen_jobs_pres_idx | presentation_id | BTREE | — | Задачи презентации |
| gen_jobs_pending_idx | (created_at, status) | BTREE | WHERE status IN ('pending','running') | Мониторинг активных задач |

### Ограничения

- FK: `presentation_id` → `presentations.id` ON DELETE CASCADE

### Enum-типы

```sql
CREATE TYPE llm_provider AS ENUM ('claude', 'gpt4o', 'llama3', 'gemini');
```

### Триггеры

- `trg_generation_jobs_sync_status` — при изменении `status` в `generation_jobs` синхронизирует `presentations.status`:

```sql
CREATE OR REPLACE FUNCTION fn_sync_presentation_status()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE presentations SET
        status = CASE NEW.status
            WHEN 'running'   THEN 'generating'::presentation_status
            WHEN 'completed' THEN 'ready'::presentation_status
            WHEN 'failed'    THEN 'error'::presentation_status
            ELSE presentations.status
        END,
        updated_at = now()
    WHERE id = NEW.presentation_id
      AND current_generation_job_id = NEW.id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### Типичные запросы

```sql
-- Прогресс генерации для WebSocket stream
SELECT slides_completed, slides_total, status, error_message
FROM generation_jobs
WHERE id = $1;

-- Cost analytics за период
SELECT llm_provider, SUM(total_cost_usd) AS total_cost, COUNT(*) AS jobs_count
FROM generation_jobs
WHERE presentation_id IN (
    SELECT id FROM presentations WHERE project_id IN (
        SELECT id FROM projects WHERE organization_id = $1
    )
) AND completed_at BETWEEN $2 AND $3
GROUP BY llm_provider;
```

### Связи

- `presentations` (многие к одному) через `presentation_id`

---

## Таблица: `export_jobs`

**Домен:** AI
**Назначение:** Задачи экспорта презентации в PPTX, PDF, Google Slides, PNG.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| presentation_id | UUID | ✓ | — | FK | Исходная презентация |
| format | export_format | ✓ | — | — | Формат экспорта |
| status | job_status | ✓ | 'pending' | — | Статус задачи |
| s3_key | TEXT | ✗ | NULL | — | S3-ключ результата (PPTX/PDF) |
| google_file_id | TEXT | ✗ | NULL | — | Google Drive file ID |
| download_url | TEXT | ✗ | NULL | — | Presigned S3 URL для скачивания |
| expires_at | TIMESTAMPTZ | ✗ | NULL | — | Срок жизни ссылки |
| slide_range | INT[] | ✗ | NULL | — | Диапазон слайдов (NULL = все) |
| created_by | UUID | ✓ | — | FK | Инициатор |
| started_at | TIMESTAMPTZ | ✗ | NULL | — | Начало экспорта |
| completed_at | TIMESTAMPTZ | ✗ | NULL | — | Окончание |
| error_message | TEXT | ✗ | NULL | — | Сообщение об ошибке |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| export_jobs_pkey | id | BTREE UNIQUE | — | PK |
| export_jobs_pres_idx | (presentation_id, format) | BTREE | — | Экспорты презентации |
| export_jobs_pending_idx | status | BTREE | WHERE status = 'pending' | Очередь |
| export_jobs_expires_idx | expires_at | BTREE | WHERE expires_at IS NOT NULL | Очистка истёкших |

### Ограничения

- FK: `presentation_id` → `presentations.id` ON DELETE CASCADE
- FK: `created_by` → `users.id` ON DELETE RESTRICT

### Enum-типы

```sql
CREATE TYPE export_format AS ENUM ('pptx', 'pdf', 'google_slides', 'png', 'web');
```

### Связи

- `presentations` (многие к одному) через `presentation_id`

---

## Таблица: `webhook_subscriptions`

**Домен:** AI / Интеграции
**Назначение:** Зарегистрированные webhook-endpoints организаций для получения событий.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| organization_id | UUID | ✓ | — | FK | Организация |
| url | TEXT | ✓ | — | — | HTTPS-endpoint для доставки |
| secret_hash | TEXT | ✓ | — | — | HMAC-SHA256 подпись (хеш секрета) |
| events | TEXT[] | ✓ | — | CHECK | Подписанные типы событий |
| is_active | BOOLEAN | ✓ | TRUE | — | Активна ли подписка |
| created_by | UUID | ✓ | — | FK | Создатель |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Дата создания |
| updated_at | TIMESTAMPTZ | ✓ | now() | — | Дата обновления |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| webhooks_pkey | id | BTREE UNIQUE | — | PK |
| webhooks_org_idx | organization_id | BTREE | WHERE is_active = TRUE | Активные подписки орг. |

### Ограничения

- FK: `organization_id` → `organizations.id` ON DELETE CASCADE
- FK: `created_by` → `users.id` ON DELETE RESTRICT
- CHECK: `url ~ '^https://'` — только HTTPS endpoints
- CHECK: `array_length(events, 1) > 0` — минимум одно событие

### Типичные запросы

```sql
-- Найти активные подписки для события
SELECT id, url, secret_hash, organization_id
FROM webhook_subscriptions
WHERE is_active = TRUE AND $1 = ANY(events);
```

### Связи

- `organizations` (многие к одному) через `organization_id`
- `webhook_events` (один ко многим) через `webhook_subscription_id`

---

## Таблица: `webhook_events`

**Домен:** AI / Интеграции
**Назначение:** Журнал доставки webhook-событий с гарантией at-least-once.

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Уникальный event_id (идемпотентность на стороне клиента) |
| webhook_subscription_id | UUID | ✓ | — | FK | Подписка |
| event_type | VARCHAR(100) | ✓ | — | — | Тип события |
| payload | JSONB | ✓ | — | — | Тело события |
| status | webhook_status | ✓ | 'pending' | — | Статус доставки |
| http_status_code | SMALLINT | ✗ | NULL | — | HTTP-ответ от клиента |
| attempts | SMALLINT | ✓ | 0 | CHECK >= 0 | Количество попыток |
| last_attempt_at | TIMESTAMPTZ | ✗ | NULL | — | Последняя попытка |
| next_retry_at | TIMESTAMPTZ | ✗ | NULL | — | Следующая попытка (backoff) |
| delivered_at | TIMESTAMPTZ | ✗ | NULL | — | Время успешной доставки |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Время создания события |

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| wh_events_pkey | id | BTREE UNIQUE | — | PK |
| wh_events_sub_status_idx | (webhook_subscription_id, status) | BTREE | — | События подписки |
| wh_events_retry_idx | next_retry_at | BTREE | WHERE status = 'pending' AND attempts < 5 | Retry scheduler |

### Ограничения

- FK: `webhook_subscription_id` → `webhook_subscriptions.id` ON DELETE CASCADE
- CHECK: `attempts <= 5` — максимум 5 попыток доставки

### Enum-типы

```sql
CREATE TYPE webhook_status AS ENUM ('pending', 'delivered', 'failed', 'abandoned');
```

### Триггеры

- `trg_webhook_events_partition` — автоматическое удаление записей старше 7 дней через pg_cron

### Типичные запросы

```sql
-- Выбрать события для retry (exponential backoff)
SELECT id, webhook_subscription_id, payload, attempts
FROM webhook_events
WHERE status = 'pending'
  AND attempts < 5
  AND (next_retry_at IS NULL OR next_retry_at <= now())
ORDER BY created_at
LIMIT 100;
```

### Связи

- `webhook_subscriptions` (многие к одному) через `webhook_subscription_id`

---

## Таблица: `audit_logs`

**Домен:** Auth
**Назначение:** Полный журнал аудита всех значимых действий (хранение 90 дней, партиционирование по месяцам).

### Поля

| Поле | Тип | NOT NULL | Default | Ограничения | Описание |
|------|-----|----------|---------|-------------|----------|
| id | UUID | ✓ | gen_random_uuid() | PK | Первичный ключ |
| organization_id | UUID | ✓ | — | — | Организация (без FK — для надёжности хранения) |
| user_id | UUID | ✗ | NULL | — | Пользователь (NULL — системные действия) |
| action | VARCHAR(100) | ✓ | — | — | Действие: `presentation.created`, `user.deleted`… |
| resource_type | VARCHAR(50) | ✗ | NULL | — | Тип ресурса: presentation, user, brand_kit… |
| resource_id | UUID | ✗ | NULL | — | ID ресурса |
| metadata | JSONB | ✗ | '{}' | — | Дополнительный контекст (diff, параметры) |
| ip_address | INET | ✗ | NULL | — | IP-адрес клиента |
| user_agent | TEXT | ✗ | NULL | — | User-Agent браузера |
| created_at | TIMESTAMPTZ | ✓ | now() | — | Время события |

### Партиционирование

```sql
CREATE TABLE audit_logs (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    user_id UUID,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id UUID,
    metadata JSONB DEFAULT '{}',
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- Создание ежемесячных партиций (автоматически через pg_cron)
CREATE TABLE audit_logs_2026_03
    PARTITION OF audit_logs
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
```

### Индексы

| Имя индекса | Поля | Тип | Условие (PARTIAL) | Причина |
|-------------|------|-----|-------------------|---------|
| audit_pkey | (id, created_at) | BTREE UNIQUE | — | PK (включает partition key) |
| audit_org_time_idx | (organization_id, created_at DESC) | BTREE | — | Лог организации за период |
| audit_user_idx | (user_id, created_at DESC) | BTREE | WHERE user_id IS NOT NULL | Действия пользователя |
| audit_action_idx | action | BTREE | — | Поиск по типу действия |

### Типичные запросы

```sql
-- Аудит-лог организации за последние 7 дней
SELECT action, resource_type, resource_id, user_id, ip_address, created_at
FROM audit_logs
WHERE organization_id = $1
  AND created_at >= now() - INTERVAL '7 days'
ORDER BY created_at DESC
LIMIT 100;
```

### Связи

Намеренно без FK — для гарантированной записи независимо от удаления связанных сущностей.

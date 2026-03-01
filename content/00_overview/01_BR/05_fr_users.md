---
title: "FR_03: Управление пользователями"
description: "Функциональные требования к аутентификации, авторизации, управлению организациями и RBAC."
weight: 5
draft: false
slug: ""
titleIcon: "fa-solid fa-list-check"
---

## Содержание

- [US-025: Регистрация и вход в систему](#us-025-регистрация-и-вход-в-систему)
- [US-026: Управление организацией и приглашения](#us-026-управление-организацией-и-приглашения)
- [US-027: Управление проектами](#us-027-управление-проектами)
- [US-028: Управление профилем пользователя](#us-028-управление-профилем-пользователя)
- [US-029: Управление презентациями](#us-029-управление-презентациями)

> **Нумерация:** FR-025 — FR-040. Продолжение в [06_fr_admin.md](./06_fr_admin.md) с FR-041.

---

## US-025: Регистрация и вход в систему

> Как **пользователь**, я хочу зарегистрироваться и войти в систему через корпоративный SSO или email, чтобы получить доступ к сервису.

**Источник:** [users](../../../03_backend/01_info_models/relational.md) — `email`, `is_email_verified`, `last_login_at`; [oauth_connections](../../../03_backend/01_info_models/relational.md) — `provider`; [cache.md](../../../03_backend/01_info_models/cache.md) — `session:{id}`, `user_sessions:{user_id}`; [01_architecture/_index.md](../../../01_architecture/_index.md) — SSO

### FR-025: Регистрация через email и подтверждение

**Описание:** POST `/auth/register` принимает `email`, `name`, `password`. Пароль хэшируется bcrypt (work factor ≥ 12). Отправляется письмо с подтверждением. До подтверждения `is_email_verified = false`; доступ к генерации ограничен. Пользователь без подтверждения email не может создавать организации.

**Приоритет:** Must

**Зависимости:** NFR-004 (bcrypt ≥ 12 rounds), NFR-007 (персональные данные — 152-ФЗ)

### FR-026: Вход через SSO (OAuth 2.0 / SAML 2.0)

**Описание:** Поддерживаются провайдеры: Google (OAuth 2.0), Microsoft (OAuth 2.0), Okta (SAML 2.0). При первом входе через SSO создаётся `users` + `oauth_connections`. JWT-токен (срок жизни 15 мин) + refresh-token (7 дней, httpOnly cookie). Сессия кэшируется в Redis: `session:{session_id}` с TTL 24 часа.

**Приоритет:** Must

**Зависимости:** NFR-004 (JWT, TLS 1.3), NFR-006 (MFA обязателен для Enterprise)

### FR-027: MFA (Multi-Factor Authentication) для Enterprise

**Описание:** При входе пользователей организаций с планом Enterprise и включённым MFA — после первичной аутентификации запрашивается TOTP-код (RFC 6238, Google Authenticator / Authy). Если MFA не настроен — пользователь обязан настроить до доступа к системе.

**Приоритет:** Must (для Enterprise), Could (для Pro/Free)

**Зависимости:** FR-026, NFR-006

### FR-028: Выход и инвалидация сессий

**Описание:** POST `/auth/logout` удаляет `session:{session_id}` из Redis и удаляет session_id из `user_sessions:{user_id}`. POST `/auth/logout-all` завершает все активные сессии пользователя через `revoke_all_user_sessions(user_id)` (Lua-скрипт SCAN + DEL). Refresh-token аннулируется на стороне сервера.

**Приоритет:** Must

**Зависимости:** FR-026, NFR-007 (право пользователя управлять сессиями)

#### Критерии приёмки FR-025 — FR-028

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Регистрация по email | `email`, `name`, `password` ≥ 8 символов | HTTP 201, письмо с подтверждением отправлено; `is_email_verified = false` |
| 2 | Вход через Google SSO | OAuth callback с валидным code | JWT (15 мин) + refresh-token (7 дней, httpOnly); сессия в Redis; `last_login_at` обновлён |
| 3 | MFA — верный TOTP | Enterprise пользователь, TOTP код верный | Вход разрешён, JWT выдан |
| 4 | MFA — неверный TOTP | TOTP код неверный | HTTP 401, `{"error": "invalid_totp"}` |
| 5 | Logout-all | POST `/auth/logout-all` | Все `session:*` пользователя удалены из Redis; следующий запрос с любым токеном → 401 |
| 6 | Слабый пароль | `password = "123"` | HTTP 422, `{"error": "password_too_weak", "min_length": 8}` |
| 7 | Повторная регистрация с тем же email | Email уже существует | HTTP 409, `{"error": "email_already_registered"}` |

#### Примечания архитектора
> ⚙️ JWT содержит минимум claims: `sub` (user_id), `org_id` (активная организация), `role`, `plan`, `exp`. Полные данные сессии читаются из Redis HASH за O(1). При смене роли пользователя — немедленная инвалидация через `revoke_all_user_sessions`.

---

## US-026: Управление организацией и приглашения

> Как **администратор организации**, я хочу приглашать сотрудников, назначать им роли и удалять из организации, чтобы контролировать доступ к корпоративным данным.

**Источник:** [organizations](../../../03_backend/01_info_models/relational.md); [organization_members](../../../03_backend/01_info_models/relational.md) — `role` (admin/editor/viewer); [audit_logs](../../../03_backend/01_info_models/relational.md)

### FR-029: Создание организации

**Описание:** POST `/organizations` — доступно только верифицированным пользователям. Создаются: `organizations` (name, slug = уникальный URL-slug), `organization_members` (роль admin для создателя), `subscriptions` (план Free). `slug` генерируется автоматически из `name` (lowercase, дефисы), но может быть изменён при создании.

**Приоритет:** Must

**Зависимости:** FR-025 (email верифицирован)

### FR-030: Приглашение члена организации

**Описание:** POST `/organizations/{id}/members/invite` с `email` и `role` (editor/viewer). Система отправляет письмо с invite-ссылкой (токен, TTL 72 часа). При переходе по ссылке: если пользователь с таким email существует — добавляется в организацию; иначе — сначала регистрация, затем добавление. Один пользователь может состоять в нескольких организациях (`organization_members`).

**Приоритет:** Must

**Зависимости:** FR-029, NFR-007 (приглашение по email — персональные данные)

### FR-031: Изменение роли и удаление члена

**Описание:** PATCH `/organizations/{id}/members/{user_id}` — изменение роли (admin/editor/viewer). При изменении роли немедленно инвалидируются все сессии пользователя (`revoke_all_user_sessions`). DELETE `/organizations/{id}/members/{user_id}` — удаление из организации. Последний admin организации не может быть удалён или разжалован. Все действия логируются в `audit_logs`.

**Приоритет:** Must

**Зависимости:** FR-030, FR-028 (инвалидация сессий)

#### Матрица RBAC

| Операция | Admin | Editor | Viewer |
|----------|-------|--------|--------|
| Создать/удалить организацию | ✅ | ❌ | ❌ |
| Приглашать членов | ✅ | ❌ | ❌ |
| Изменять роли | ✅ | ❌ | ❌ |
| Создавать/редактировать презентации | ✅ | ✅ | ❌ |
| Просматривать презентации | ✅ | ✅ | ✅ |
| Загружать/удалять источники | ✅ | ✅ | ❌ |
| Управлять Brand Kit | ✅ | ❌ | ❌ |
| Создавать API-ключи | ✅ | ❌ | ❌ |
| Просматривать аудит-лог | ✅ | ❌ | ❌ |
| Просматривать биллинг | ✅ | ❌ | ❌ |

#### Критерии приёмки FR-029 — FR-031

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Создание организации | POST `/organizations`, name: "Acme Corp" | HTTP 201, slug = "acme-corp", роль admin выдана создателю |
| 2 | Конфликт slug | name: "Acme Corp" при существующем slug | slug автоматически становится "acme-corp-2" |
| 3 | Приглашение | POST invite, email: "bob@acme.com", role: editor | Письмо отправлено; `organization_members` создан после принятия |
| 4 | Изменение роли editor → admin | PATCH role: admin | Роль обновлена; сессии пользователя инвалидированы; событие в `audit_logs` |
| 5 | Удаление последнего admin | DELETE последнего admin | HTTP 422, `{"error": "cannot_remove_last_admin"}` |
| 6 | Viewer пытается создать презентацию | POST `/presentations` | HTTP 403, `{"error": "insufficient_role", "required": "editor"}` |

---

## US-027: Управление проектами

> Как **пользователь**, я хочу группировать презентации в проекты, чтобы поддерживать порядок в рабочем пространстве.

**Источник:** [projects](../../../03_backend/01_info_models/relational.md) — `name`, `description`, `is_archived`; [presentations](../../../03_backend/01_info_models/relational.md) — `project_id`

### FR-032: CRUD проектов

**Описание:**
- POST `/projects` — создание проекта (`name`, `description`, `organization_id`). Права: editor+.
- GET `/projects` — список проектов организации. Поддерживает фильтр `is_archived`.
- PATCH `/projects/{id}` — редактирование имени и описания. Права: editor+.
- PATCH `/projects/{id}` с `is_archived: true` — архивирование. Архивированный проект скрыт по умолчанию, но его презентации доступны по прямой ссылке. Права: admin.
- DELETE `/projects/{id}` — удаление только пустого проекта (без презентаций). Права: admin.

**Приоритет:** Must

**Зависимости:** FR-029 (организация создана), NFR-001 (CRUD ≤ 500 мс)

#### Критерии приёмки FR-032

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Создание проекта | POST `/projects`, name: "Q1 2026 Reports" | HTTP 201, project с UUID |
| 2 | Архивирование | PATCH is_archived: true | Проект скрыт из основного списка; GET с `include_archived=true` — виден |
| 3 | Удаление непустого проекта | DELETE при наличии презентаций | HTTP 422, `{"error": "project_not_empty", "presentations_count": 5}` |

---

## US-028: Управление профилем пользователя

> Как **пользователь**, я хочу управлять своим профилем и запросить удаление аккаунта, чтобы контролировать свои персональные данные.

**Источник:** [users](../../../03_backend/01_info_models/relational.md) — `deleted_at` (soft delete); NFR-007 (GDPR/152-ФЗ)

### FR-033: Просмотр и редактирование профиля

**Описание:** GET `/users/me` возвращает `name`, `email`, `avatar_url`, `is_email_verified`, `last_login_at`, список организаций. PATCH `/users/me` — изменение `name`, `avatar_url`. Изменение email требует повторной верификации.

**Приоритет:** Must

### FR-034: Удаление аккаунта (право на забвение — GDPR/152-ФЗ)

**Описание:** DELETE `/users/me` инициирует процедуру удаления:
1. Soft delete: `users.deleted_at = now()`.
2. Удаление персональных данных: `email`, `name`, `avatar_url` заменяются на `deleted_user_{id}@deleted.local`.
3. Все OAuth-токены (`oauth_connections`) удаляются.
4. Все сессии инвалидируются.
5. Данные пользователя в `audit_logs` сохраняются (без ФИО) — только `user_id` как UUID, согласно требованию аудита.
6. Ответ: HTTP 204. Операция необратима.

**Приоритет:** Must

**Зависимости:** NFR-007 (GDPR Art. 17, 152-ФЗ ст. 21), NFR-008 (срок хранения данных)

#### Критерии приёмки FR-033 — FR-034

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Редактирование имени | PATCH name: "Иван Петров" | HTTP 200, `name` обновлён |
| 2 | Смена email | PATCH email: "new@company.ru" | Письмо подтверждения на новый email; старый email действует до подтверждения |
| 3 | Удаление аккаунта | DELETE `/users/me` | HTTP 204; следующий login с этим email → 401; персональные данные анонимизированы в БД в течение 30 сек |

---

## US-029: Управление презентациями

> Как **пользователь**, я хочу создавать, копировать и удалять презентации, чтобы организовать рабочий процесс.

**Источник:** [presentations](../../../03_backend/01_info_models/relational.md) — `status`, `deleted_at`; [slides](../../../03_backend/01_info_models/relational.md)

### FR-035: CRUD презентаций

**Описание:**
- POST `/presentations` — создание (см. FR-010).
- GET `/presentations` — список презентаций проекта с фильтрами: `status`, `created_by`. Пагинация: cursor-based, `limit` max 50.
- GET `/presentations/{id}` — детали с полным списком слайдов.
- PATCH `/presentations/{id}` — обновление `title`, `description`, `brand_kit_id`, `tone`.
- POST `/presentations/{id}/duplicate` — полное копирование презентации (все слайды, source_refs), без копирования `presentation_sources` (источники не переносятся). Новая презентация в статусе `draft`.
- DELETE `/presentations/{id}` — soft delete (`deleted_at = now()`). Данные хранятся 30 дней, затем физически удаляются вместе с артефактами в S3.

**Приоритет:** Must

**Зависимости:** NFR-001 (список ≤ 500 мс, детали ≤ 500 мс)

### FR-036: Поиск по презентациям

**Описание:** GET `/presentations?q={query}` — полнотекстовый поиск по `title` и `description` внутри организации. Реализован через PostgreSQL `pg_trgm` (GIN-индекс). Не требует отдельного поискового движка на MVP.

**Приоритет:** Should

**Зависимости:** FR-035

#### Критерии приёмки FR-035 — FR-036

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Список презентаций | GET `/presentations?project_id={id}` | JSON-массив с cursor пагинацией |
| 2 | Дублирование | POST `/presentations/{id}/duplicate` | Новая презентация с `(copy)` в title, статус `draft`, слайды скопированы |
| 3 | Мягкое удаление | DELETE `/presentations/{id}` | HTTP 204; GET `/presentations/{id}` → 404; через 30 дней физическое удаление |
| 4 | Поиск | GET `/presentations?q=квартальный отчёт` | Возвращены презентации с совпадением в title/description |
| 5 | Viewer удаляет презентацию | DELETE, роль viewer | HTTP 403, `{"error": "insufficient_role", "required": "editor"}` |

### FR-037: Управление слайдами вручную

**Описание:** Помимо AI-генерации, пользователь может:
- POST `/presentations/{id}/slides` — добавить пустой слайд заданного `slide_type`.
- PATCH `/slides/{id}` — редактировать `content` (JSONB) напрямую.
- DELETE `/slides/{id}` — удалить слайд (пересчёт `position` соседних слайдов).
- POST `/presentations/{id}/slides/reorder` — изменить порядок слайдов (`positions: [{id, position}]`).

**Приоритет:** Should

**Зависимости:** FR-012, NFR-001 (операции ≤ 300 мс)

#### Критерии приёмки FR-037

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Добавление слайда | POST, slide_type: chart | Слайд создан с `position` = last + 1 |
| 2 | Реордеринг | POST reorder, [{id1, pos: 2}, {id2, pos: 1}] | Позиции обменяны атомарно (транзакция) |
| 3 | Удаление слайда | DELETE слайда на position 3 из 5 | Слайды 4 и 5 перемещены на позиции 3 и 4 |

### FR-038: Просмотр использования токенов и лимитов

**Описание:** GET `/organizations/{id}/usage` возвращает текущее потребление из Redis (`usage:{org_id}:{period}`): `presentations_generated`, `slides_generated`, `tokens_used`, `cost_usd`; лимиты из `plan_limits:{org_id}` Redis-кэша. При достижении 80% лимита токенов — UI показывает предупреждение. При достижении 100% — генерация блокируется с HTTP 429.

**Приоритет:** Must

**Зависимости:** NFR-001 (ответ ≤ 200 мс из Redis)

#### Критерии приёмки FR-038

| # | Сценарий | Входные данные | Ожидаемый результат |
|---|----------|---------------|---------------------|
| 1 | Просмотр лимитов | GET `/organizations/{id}/usage` | JSON: `{presentations_used: 23, presentations_limit: 100, tokens_used: 4500000, tokens_limit: 5000000}` |
| 2 | Превышение лимита токенов | 101-я генерация при лимите 100 | HTTP 429, `{"error": "token_limit_exceeded", "upgrade_url": "..."}` |

### FR-039: Управление подпиской

**Описание:** GET `/organizations/{id}/subscription` — текущий план, статус, `current_period_end`. POST `/organizations/{id}/subscription/upgrade` — инициирует Stripe Checkout Session для апгрейда плана. Webhook от Stripe обновляет `subscriptions` + инвалидирует `plan_limits:{org_id}` в Redis. POST `/organizations/{id}/subscription/cancel` — устанавливает `cancel_at_period_end = true`.

**Приоритет:** Must

**Зависимости:** NFR-007 (биллинг — персональные данные)

### FR-040: Экспорт персональных данных (GDPR Art. 20)

**Описание:** POST `/users/me/export-data` инициирует создание ZIP-архива с: данными профиля (JSON), списком организаций, историей презентаций (метаданные, без слайдов). Архив готовится асинхронно ≤ 24 часов. Ссылка для скачивания высылается на email. Доступна 7 дней.

**Приоритет:** Must

**Зависимости:** NFR-007 (GDPR Art. 20), NFR-008

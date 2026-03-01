---
title: "POST /projects"
description: "Создание нового проекта в организации. Синхронный эндпоинт без участия LLM."
weight: 1
draft: false
slug: ""
titleIcon: "fa-solid fa-folder-plus"
---

## Содержание

- [Обзор](#обзор)
- [Алгоритм](#алгоритм)
- [Параметры](#параметры)
- [Тело запроса](#тело-запроса)
- [Ответы](#ответы)
- [Валидации](#валидации)
- [Безопасность](#безопасность)

---

## Обзор

| Свойство       | Значение                                  |
|----------------|-------------------------------------------|
| Метод          | `POST`                                    |
| URL            | `/projects`                               |
| Тип            | Синхронный                                |
| LLM            | Нет                                       |
| Успешный код   | `201 Created`                             |
| Теги           | Projects                                  |
| Требования     | FR-041 (управление организацией)          |

Создаёт новый проект в рамках организации. Проект — логический контейнер для группировки презентаций. После создания проект доступен через `GET /projects/{project_id}` и используется при создании презентаций как `project_id`.

---

## Алгоритм

1. Проверка Bearer JWT или `X-API-Key`; извлечение `user_id` и `org_id` из токена.
2. Проверка RBAC: роль пользователя должна быть `admin` или `editor`; роль `viewer` получает `403`.
3. Если в теле передан `org_id` — проверка, что пользователь является `admin` этой организации.
4. Валидация тела запроса по схеме `ProjectCreate`; поле `name` обязательно.
5. Вставка строки в таблицу `projects` (PostgreSQL) в рамках RLS-политики текущей организации.
6. Возврат созданного объекта `Project` с кодом `201 Created`.

---

## Параметры

Эндпоинт не принимает параметров пути или строки запроса.

---

## Тело запроса

**Content-Type:** `application/json`

```typescript
interface ProjectCreate {
  /** Название проекта. Обязательное поле. */
  name: string;
  /** Произвольное описание проекта. */
  description?: string;
  /**
   * UUID организации.
   * Если не указан — подставляется из JWT.
   * Явная передача доступна только роли admin.
   */
  org_id?: string; // uuid
}
```

**Пример запроса:**

```json
{
  "name": "Q1 2026 — Инвестиционный питч",
  "description": "Презентации для инвесторов серии A",
  "org_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6"
}
```

---

## Ответы

### 201 Created

```typescript
interface Project {
  id: string;                // uuid
  name: string;
  description?: string;
  org_id?: string;           // uuid
  presentation_count: number;
  created_at: string;        // ISO 8601
  updated_at?: string;       // ISO 8601
}
```

```json
{
  "id": "c47f1234-89ab-cdef-0123-456789abcdef",
  "name": "Q1 2026 — Инвестиционный питч",
  "description": "Презентации для инвесторов серии A",
  "org_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "presentation_count": 0,
  "created_at": "2026-03-01T10:00:00Z",
  "updated_at": "2026-03-01T10:00:00Z"
}
```

### 401 Unauthorized

```json
{
  "error": "UNAUTHORIZED",
  "message": "Invalid or expired token",
  "request_id": "req_01HXABCDE"
}
```

### 403 Forbidden

```json
{
  "error": "INSUFFICIENT_ROLE",
  "message": "Role 'viewer' cannot create projects. Required: admin or editor.",
  "request_id": "req_01HXABCDE"
}
```

### 422 Unprocessable Entity

```json
{
  "error": "VALIDATION_ERROR",
  "message": "Request body validation failed",
  "details": {
    "name": "Field required"
  },
  "request_id": "req_01HXABCDE"
}
```

---

## Валидации

| Поле           | Правило                                                      | HTTP-код | Код ошибки          |
|----------------|--------------------------------------------------------------|----------|---------------------|
| `name`         | Обязательное, непустая строка                                | 422      | `VALIDATION_ERROR`  |
| `org_id`       | Если передан — валидный UUID; только для роли `admin`        | 403      | `INSUFFICIENT_ROLE` |
| JWT / API-ключ | Должен быть действующим и не отозванным                      | 401      | `UNAUTHORIZED`      |
| Роль           | Должна быть `admin` или `editor`                             | 403      | `INSUFFICIENT_ROLE` |

---

## Безопасность

- **Аутентификация:** Bearer JWT (TTL 15 мин) или `X-API-Key` (хранится как SHA-256-хеш в таблице `api_keys`).
- **Авторизация:** RBAC — роль `viewer` не имеет права создавать проекты.
- **Мультиарендность:** PostgreSQL RLS обеспечивает изоляцию: проект создаётся строго в рамках `org_id` из токена.
- **Транспорт:** TLS 1.3 (обязательно; см. NFR-006).

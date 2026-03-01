---
title: "POST /presentations"
description: "Создание новой презентации в черновом статусе. Синхронный эндпоинт без участия LLM."
weight: 2
draft: false
slug: ""
titleIcon: "fa-solid fa-file-powerpoint"
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

| Свойство       | Значение                                                       |
|----------------|----------------------------------------------------------------|
| Метод          | `POST`                                                         |
| URL            | `/presentations`                                               |
| Тип            | Синхронный                                                     |
| LLM            | Нет                                                            |
| Успешный код   | `201 Created`                                                  |
| Теги           | Presentations                                                  |
| Требования     | FR-010 (инициализация генерации), FR-025 (RBAC)                |

Создаёт новую презентацию в статусе `draft`. Объект служит контейнером для последующих шагов: загрузки источников, генерации структуры (`generateOutline`) и слайдов (`generateSlides`). Поля `tone`, `goal`, `audience` и `prompt` передаются в LLM на этапе генерации и могут быть уточнены позднее через `PATCH /presentations/{id}`.

---

## Алгоритм

1. Проверка Bearer JWT или `X-API-Key`; извлечение `user_id` и `org_id`.
2. Проверка RBAC: роли `admin` и `editor` могут создавать презентации; `viewer` — нет.
3. Валидация тела запроса по схеме `PresentationCreate`; поле `title` обязательно.
4. Если передан `brand_kit_id` — проверка существования Brand Kit в рамках организации.
5. Если передан `project_id` — проверка существования проекта и доступа к нему.
6. Вставка строки в таблицу `presentations` со статусом `draft` (PostgreSQL, RLS).
7. Возврат объекта `Presentation` с кодом `201 Created`.

---

## Параметры

Эндпоинт не принимает параметров пути или строки запроса.

---

## Тело запроса

**Content-Type:** `application/json`

```typescript
type ToneType = "formal" | "business" | "persuasive" | "technical" | "educational";

type PresentationGoal =
  | "investor_pitch"
  | "management_report"
  | "client_adaptation"
  | "educational"
  | "consulting_report"
  | "internal_pitch"
  | "custom";

type AudienceType = "investor" | "management" | "client" | "team" | "student" | "custom";

interface PresentationCreate {
  /** Заголовок презентации. Обязательное поле. */
  title: string;
  /** UUID проекта-контейнера. Если не указан — презентация создаётся без проекта. */
  project_id?: string; // uuid
  /**
   * Язык генерации контента. ISO 639-1.
   * @default "ru"
   */
  language?: string;
  /** Тон подачи материала. */
  tone?: ToneType;
  /** Цель презентации — влияет на структуру, выбираемую LLM. */
  goal?: PresentationGoal;
  /** Целевая аудитория. */
  audience?: AudienceType;
  /** UUID корпоративного Brand Kit. */
  brand_kit_id?: string; // uuid
  /**
   * Свободное описание темы и цели — передаётся в LLM при generateOutline.
   * Минимум 10, максимум 2000 символов.
   */
  prompt?: string;
}
```

**Пример запроса:**

```json
{
  "title": "Ежеквартальный отчёт для совета директоров — Q1 2026",
  "project_id": "c47f1234-89ab-cdef-0123-456789abcdef",
  "language": "ru",
  "tone": "formal",
  "goal": "management_report",
  "audience": "management",
  "brand_kit_id": "aabbccdd-1234-5678-9012-aabbccddeeff",
  "prompt": "Обзор результатов Q1 2026: выручка, ключевые метрики, отклонения от плана и прогноз на Q2"
}
```

---

## Ответы

### 201 Created

```typescript
type PresentationStatus = "draft" | "outline_ready" | "generating" | "ready" | "error";

interface Presentation {
  id: string;               // uuid
  title: string;
  status: PresentationStatus;
  project_id?: string;      // uuid
  slide_count: number;
  language?: string;
  tone?: ToneType;
  goal?: PresentationGoal;
  audience?: AudienceType;
  brand_kit_id?: string;    // uuid
  created_at: string;       // ISO 8601
  updated_at?: string;      // ISO 8601
}
```

```json
{
  "id": "f1a2b3c4-d5e6-7890-abcd-ef1234567890",
  "title": "Ежеквартальный отчёт для совета директоров — Q1 2026",
  "status": "draft",
  "project_id": "c47f1234-89ab-cdef-0123-456789abcdef",
  "slide_count": 0,
  "language": "ru",
  "tone": "formal",
  "goal": "management_report",
  "audience": "management",
  "brand_kit_id": "aabbccdd-1234-5678-9012-aabbccddeeff",
  "created_at": "2026-03-01T10:05:00Z",
  "updated_at": "2026-03-01T10:05:00Z"
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
  "message": "Role 'viewer' cannot create presentations",
  "request_id": "req_01HXABCDE"
}
```

### 404 Not Found

```json
{
  "error": "BRAND_KIT_NOT_FOUND",
  "message": "Brand Kit 'aabbccdd-...' not found in your organization",
  "request_id": "req_01HXABCDE"
}
```

### 422 Unprocessable Entity

```json
{
  "error": "VALIDATION_ERROR",
  "message": "Request body validation failed",
  "details": {
    "title": "Field required",
    "prompt": "String should have at least 10 characters"
  },
  "request_id": "req_01HXABCDE"
}
```

---

## Валидации

| Поле           | Правило                                              | HTTP-код | Код ошибки             |
|----------------|------------------------------------------------------|----------|------------------------|
| `title`        | Обязательное, непустая строка                        | 422      | `VALIDATION_ERROR`     |
| `prompt`       | Если передан: длина 10–2000 символов                 | 422      | `VALIDATION_ERROR`     |
| `project_id`   | Если передан: UUID, проект должен принадлежать организации | 404 | `PROJECT_NOT_FOUND`    |
| `brand_kit_id` | Если передан: UUID, Brand Kit должен принадлежать организации | 404 | `BRAND_KIT_NOT_FOUND` |
| `tone`         | Если передан: одно из перечисленных значений `ToneType` | 422  | `VALIDATION_ERROR`     |
| `goal`         | Если передан: одно из значений `PresentationGoal`   | 422      | `VALIDATION_ERROR`     |
| `audience`     | Если передан: одно из значений `AudienceType`        | 422      | `VALIDATION_ERROR`     |
| Роль           | `admin` или `editor`                                 | 403      | `INSUFFICIENT_ROLE`    |

---

## Безопасность

- **Аутентификация:** Bearer JWT (TTL 15 мин) или `X-API-Key` (хранится как SHA-256-хеш).
- **Авторизация:** RBAC — роль `viewer` не имеет права создавать презентации.
- **Мультиарендность:** PostgreSQL RLS — созданная презентация автоматически привязана к `org_id` из JWT; доступ к `project_id` и `brand_kit_id` проверяется через ту же политику.
- **Транспорт:** TLS 1.3 (NFR-006).

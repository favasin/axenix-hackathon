---
title: "POST /presentations/{id}/generate/outline"
description: "Синхронная генерация структуры (оглавления) презентации через RAG + LLM. Цель: p95 ≤ 10 с."
weight: 3
draft: false
slug: ""
titleIcon: "fa-solid fa-list-ol"
---

## Содержание

- [Обзор](#обзор)
- [Алгоритм](#алгоритм)
- [Параметры](#параметры)
- [Тело запроса](#тело-запроса)
- [Ответы](#ответы)
- [Валидации](#валидации)
- [Диаграмма последовательности](#диаграмма-последовательности)
- [Безопасность](#безопасность)

---

## Обзор

| Свойство       | Значение                                                                  |
|----------------|---------------------------------------------------------------------------|
| Метод          | `POST`                                                                    |
| URL            | `/presentations/{presentation_id}/generate/outline`                       |
| Тип            | **Синхронный** (ответ возвращается в теле, не через задачу)               |
| LLM            | Claude Sonnet (primary) / GPT-4o (fallback)                               |
| RAG            | Qdrant — поиск по `source_file_ids`, порог косинусного сходства ≥ 0.72   |
| Успешный код   | `200 OK`                                                                  |
| SLA            | p95 ≤ 10 секунд (NFR-001)                                                 |
| Теги           | Generation                                                                |
| Требования     | FR-010 (RAG-поиск), FR-011 (генерация структуры)                          |

Генерирует структуру презентации: список слайдов с заголовками, ключевыми тезисами и рекомендуемыми типами контента. Перед вызовом слайды (`source_file_ids`) должны быть в статусе `ready`. Результат (`Outline`) сохраняется на сервере — презентация переходит в статус `outline_ready`. Структуру можно отредактировать через `PUT /presentations/{id}/generate/outline` перед запуском `generateSlides`.

---

## Алгоритм

1. **Аутентификация и авторизация.** Проверка JWT / API-ключа; роли `editor` и `admin` разрешены.
2. **Проверка лимита тарифного плана.** Если исчерпан лимит презентаций за период — `402 Payment Required`.
3. **Rate limit.** Проверка `ratelimit:{key_id}:{min}` в Redis; при превышении — `429 Too Many Requests` с заголовком `Retry-After`.
4. **Проверка статуса презентации.** Статус должен быть `draft` или `outline_ready` (повторная генерация разрешена).
5. **Валидация источников.** Для каждого `source_file_id` — проверка `file_status = ready` в таблице `source_documents`.
6. **Семантический кэш.** Проверка ключа `semantic_cache:{hash}` (Redis + Qdrant-коллекция `semantic_cache`). При совпадении (cosine ≥ 0.95) — возврат кэшированного `Outline` без LLM-вызова.
7. **RAG-поиск.** LangChain выполняет embedding запроса (text-embedding-3-large, 3072d), ищет топ-20 чанков в Qdrant (`org_{id}_docs`), применяет cross-encoder re-ranking — оставляет топ-10.
8. **LLM-генерация.** Промпт с контекстом RAG + инструкции по структуре (тип `goal`, аудитория, желаемое число слайдов) передаётся Claude Sonnet. LLM возвращает JSON-структуру `Outline`. При ошибке LLM — Circuit Breaker (NFR-011) переключает на GPT-4o.
9. **Постпроцессинг.** Проверка флагов `hallucination_flags` (источник знаний модели vs. файл пользователя) и запись в MongoDB `generation_traces`.
10. **Сохранение.** `Outline` записывается в PostgreSQL; статус презентации → `outline_ready`; семантический кэш обновляется (TTL 24 ч).
11. **Ответ.** Возврат объекта `Outline` с `structure_rationale` и массивом `slides`.

---

## Параметры

| Параметр          | Тип    | Расположение | Обязательный | Описание                         |
|-------------------|--------|--------------|:------------:|----------------------------------|
| `presentation_id` | uuid   | path         | Да           | UUID презентации в статусе `draft` или `outline_ready` |

---

## Тело запроса

**Content-Type:** `application/json`

```typescript
type PresentationGoal =
  | "investor_pitch"
  | "management_report"
  | "client_adaptation"
  | "educational"
  | "consulting_report"
  | "internal_pitch"
  | "custom";

type AudienceType = "investor" | "management" | "client" | "team" | "student" | "custom";

type SlideContentType = "text" | "chart" | "table" | "image" | "quote" | "mixed";

interface GenerateOutlineRequest {
  /**
   * Свободное описание темы и цели презентации.
   * Если не передано — берётся из `presentations.prompt`.
   * Длина: 10–2000 символов.
   */
  prompt?: string;
  /** Цель презентации — влияет на выбор структурного шаблона LLM. */
  goal?: PresentationGoal;
  /** Целевая аудитория. */
  audience?: AudienceType;
  /** Язык генерации. ISO 639-1. */
  language?: string;
  /**
   * Желаемое количество слайдов.
   * LLM может скорректировать в пределах ±3.
   * Диапазон: 5–30.
   */
  slide_count_hint?: number;
  /** UUIDs файлов-источников, проиндексированных в Qdrant. */
  source_file_ids?: string[]; // uuid[]
}
```

**Пример запроса:**

```json
{
  "prompt": "Анализ результатов продаж за Q1 2026: динамика по регионам, топ-продукты, прогноз Q2",
  "goal": "management_report",
  "audience": "management",
  "language": "ru",
  "slide_count_hint": 12,
  "source_file_ids": [
    "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "b2c3d4e5-f6a7-8901-bcde-f12345678901"
  ]
}
```

---

## Ответы

### 200 OK

```typescript
interface OutlineSlide {
  position: number;                 // 1-based
  title: string;
  key_thesis: string;               // ключевой тезис слайда
  content_type?: SlideContentType;  // рекомендуемый тип контента
  suggested_data_source?: string;   // какой файл будет использован как источник
}

interface Outline {
  presentation_id: string;      // uuid
  /**
   * Объяснение выбранной структуры (принцип прозрачности, NFR-012).
   * Пример: "Для питч-дека инвестора применена структура Problem→Solution→Market
   * в соответствии со стандартом Y Combinator"
   */
  structure_rationale: string;
  slides: OutlineSlide[];
}
```

```json
{
  "presentation_id": "f1a2b3c4-d5e6-7890-abcd-ef1234567890",
  "structure_rationale": "Для отчёта совету директоров применена структура Executive Summary → Финансы → Операции → Риски → Прогноз, обеспечивающая последовательное раскрытие ключевых метрик",
  "slides": [
    {
      "position": 1,
      "title": "Executive Summary",
      "key_thesis": "Q1 2026: выручка +18% к плану, EBITDA-маржа 22%",
      "content_type": "text",
      "suggested_data_source": "q1_2026_financials.xlsx"
    },
    {
      "position": 2,
      "title": "Динамика продаж по регионам",
      "key_thesis": "Центральный ФО — лидер роста (+34%), Сибирь ниже плана на 8%",
      "content_type": "chart",
      "suggested_data_source": "sales_report_q1.pdf"
    },
    {
      "position": 3,
      "title": "Топ-10 продуктов по выручке",
      "key_thesis": "Продукт A генерирует 41% выручки; продукт C показал рост ×2.3",
      "content_type": "table",
      "suggested_data_source": "q1_2026_financials.xlsx"
    }
  ]
}
```

### 402 Payment Required

```json
{
  "error": "PLAN_LIMIT_EXCEEDED",
  "message": "Monthly presentation limit reached. Upgrade your plan to continue.",
  "details": {
    "limit": 5,
    "used": 5,
    "plan": "free"
  },
  "request_id": "req_01HXABCDE"
}
```

### 429 Too Many Requests

```json
{
  "error": "RATE_LIMIT_EXCEEDED",
  "message": "Too many generation requests. Retry after 60 seconds.",
  "request_id": "req_01HXABCDE"
}
```

Заголовок ответа: `Retry-After: 60`

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
  "message": "Role 'viewer' cannot trigger generation",
  "request_id": "req_01HXABCDE"
}
```

### 404 Not Found

```json
{
  "error": "PRESENTATION_NOT_FOUND",
  "message": "Presentation 'f1a2b3c4-...' not found",
  "request_id": "req_01HXABCDE"
}
```

---

## Валидации

| Поле / условие          | Правило                                                          | HTTP-код | Код ошибки              |
|-------------------------|------------------------------------------------------------------|----------|-------------------------|
| `presentation_id`       | Должен существовать и принадлежать организации                   | 404      | `PRESENTATION_NOT_FOUND`|
| Статус презентации      | `draft` или `outline_ready` (повторная генерация допустима)      | 422      | `INVALID_STATUS`        |
| `prompt`                | Если передан: 10–2000 символов                                   | 422      | `VALIDATION_ERROR`      |
| `slide_count_hint`      | Если передан: целое число от 5 до 30                             | 422      | `VALIDATION_ERROR`      |
| `source_file_ids`       | Каждый UUID должен существовать и иметь `status = ready`         | 422      | `FILE_NOT_READY`        |
| Лимит тарифа            | Число презентаций в периоде < `plans.max_presentations_per_month`| 402      | `PLAN_LIMIT_EXCEEDED`   |
| Rate limit              | Не более N запросов в минуту на API-ключ                         | 429      | `RATE_LIMIT_EXCEEDED`   |
| Роль                    | `admin` или `editor`                                             | 403      | `INSUFFICIENT_ROLE`     |

---

## Диаграмма последовательности

```mermaid
sequenceDiagram
    autonumber
    participant Client as Клиент
    participant API as FastAPI
    participant Redis as Redis
    participant Qdrant as Qdrant
    participant LLM as LLM API (Claude / GPT-4o)
    participant PG as PostgreSQL
    participant Mongo as MongoDB

    Client->>API: POST /presentations/{id}/generate/outline
    API->>PG: Проверка статуса презентации и прав
    API->>Redis: Проверка rate limit (ratelimit:{key_id}:{min})
    API->>Redis: Проверка семантического кэша (semantic_cache:{hash})
    alt Кэш найден (cosine ≥ 0.95)
        Redis-->>API: Cached Outline
        API-->>Client: 200 OK — Outline (из кэша)
    else Кэш не найден
        API->>Qdrant: Embedding-поиск по source_file_ids (top-20 → re-rank → top-10)
        Qdrant-->>API: Релевантные чанки с атрибуцией
        API->>LLM: Промпт (RAG-контекст + goal + audience + slide_count_hint)
        alt LLM доступен
            LLM-->>API: JSON с Outline
        else Circuit Breaker (NFR-011)
            API->>LLM: Fallback → GPT-4o
            LLM-->>API: JSON с Outline
        end
        API->>Mongo: Запись generation_traces (hallucination_flags)
        API->>PG: Сохранение Outline; статус → outline_ready
        API->>Redis: Обновление семантического кэша (TTL 24 ч)
        API-->>Client: 200 OK — Outline
    end
```

---

## Безопасность

- **Аутентификация:** Bearer JWT (TTL 15 мин) или `X-API-Key`.
- **Авторизация:** RBAC — `viewer` не может инициировать генерацию.
- **Мультиарендность:** Qdrant-поиск ограничен коллекцией `org_{id}_docs`; доступ к чужим чанкам исключён на уровне payload-фильтра.
- **Контроль стоимости:** семантический кэш снижает количество LLM-вызовов (цель: cache hit ≥ 15%, см. NFR-022). Лимит слайдов и тарифные ограничения — дополнительная защита от злоупотреблений.
- **Прозрачность:** `structure_rationale` в ответе и `hallucination_flags` в `generation_traces` обеспечивают объяснимость (Explainability Engine, NFR-012).
- **Транспорт:** TLS 1.3 (NFR-006).

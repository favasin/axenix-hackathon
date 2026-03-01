---
title: "POST /presentations/{id}/generate/slides"
description: "Асинхронная генерация всех слайдов по утверждённой структуре. Результат доставляется через WebSocket. Цель: p95 ≤ 60 с."
weight: 4
draft: false
slug: ""
titleIcon: "fa-solid fa-wand-magic-sparkles"
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

| Свойство       | Значение                                                                       |
|----------------|--------------------------------------------------------------------------------|
| Метод          | `POST`                                                                         |
| URL            | `/presentations/{presentation_id}/generate/slides`                             |
| Тип            | **Асинхронный** — возвращает `task_id`, прогресс через WebSocket               |
| LLM            | Claude Sonnet (primary) / GPT-4o (fallback); Claude Haiku — постпроцессинг     |
| RAG            | Qdrant — по source_file_ids из утверждённой структуры                          |
| Успешный код   | `202 Accepted`                                                                 |
| SLA            | p95 ≤ 60 секунд для 15 слайдов (NFR-002)                                      |
| Теги           | Generation                                                                     |
| Требования     | FR-012 (генерация слайдов), FR-013 (постпроцессинг), FR-014 (checkpoint-восстановление) |

Запускает генерацию всех слайдов по ранее утверждённому `Outline`. Операция ставится в очередь Celery; клиент отслеживает прогресс через WebSocket (события `slide_completed`, `generation_done`, `generation_error`). Поддерживается checkpoint-восстановление через LangGraph: при сбое воркера новый воркер продолжает с последнего завершённого слайда.

> **Предусловие:** презентация должна находиться в статусе `outline_ready`. Если статус `draft` — сначала вызовите `POST /presentations/{id}/generate/outline`.

---

## Алгоритм

1. **Аутентификация и авторизация.** Проверка JWT / API-ключа; роли `editor` и `admin` разрешены.
2. **Проверка статуса.** `presentation.status` должен быть `outline_ready`; иначе — `422 INVALID_STATUS`.
3. **Проверка лимитов тарифного плана.** Если исчерпан лимит — `402 Payment Required`.
4. **Rate limit.** Проверка Redis `ratelimit:{key_id}:{min}`; при превышении — `429`.
5. **Создание задачи Celery.** Задача помещается в очередь `celery_queue:generation`; генерируется `task_id` (UUID). Статус презентации → `generating`.
6. **Возврат `202 Accepted`.** Клиент получает `task_id` и `estimated_seconds`.

**Параллельно (воркер Celery / LangGraph):**

7. **Инициализация checkpoint.** Запись начального состояния LangGraph в Redis HASH `gen_checkpoint:{task_id}` (TTL 1 ч).
8. **Цикл по слайдам.** Для каждого слайда из `Outline`:
   a. RAG-поиск в Qdrant по `suggested_data_source` и `key_thesis` (top-10 чанков).
   b. LLM-генерация контента слайда (Claude Sonnet): заголовок, bullets / chart / table, speaker_notes (если запрошены), атрибуция источников (`AttributionItem`).
   c. Постпроцессинг (Claude Haiku): фильтрация AI-клише, проверка `forbidden_words` из Brand Kit, запись `hallucination_flags`.
   d. Обновление прогресса: Redis Stream `gen_progress:{task_id}`, публикация в `pubsub:gen_progress`.
   e. Обновление checkpoint в Redis.
   f. Push события `slide_completed` через WebSocket.
9. **Завершение.** Статус презентации → `ready`; создание версии в `presentation_versions`. Push события `generation_done` через WebSocket.
10. **Обработка сбоя.** При падении воркера новый воркер читает checkpoint из Redis и возобновляет с последнего записанного слайда. При исчерпании retry — статус `error`, push события `generation_error`.

---

## Параметры

| Параметр          | Тип  | Расположение | Обязательный | Описание                   |
|-------------------|------|--------------|:------------:|----------------------------|
| `presentation_id` | uuid | path         | Да           | UUID презентации со статусом `outline_ready` |

---

## Тело запроса

**Content-Type:** `application/json`

```typescript
type ToneType = "formal" | "business" | "persuasive" | "technical" | "educational";

interface GenerateSlidesRequest {
  /**
   * Тон генерируемого контента.
   * Если не передан — используется `presentations.tone`.
   */
  tone?: ToneType;
  /**
   * Включить генерацию заметок докладчика для каждого слайда.
   * @default false
   */
  include_speaker_notes?: boolean;
  /**
   * UUID Brand Kit для применения стиля, шрифтов и forbidden_words.
   * Если не передан — используется Brand Kit, указанный при создании презентации.
   */
  brand_kit_id?: string; // uuid
}
```

**Пример запроса:**

```json
{
  "tone": "formal",
  "include_speaker_notes": true,
  "brand_kit_id": "aabbccdd-1234-5678-9012-aabbccddeeff"
}
```

Тело может быть пустым объектом `{}` — в этом случае используются настройки из созданной презентации.

---

## Ответы

### 202 Accepted

```typescript
type TaskStatusEnum = "pending" | "running" | "completed" | "failed" | "cancelled";

interface TaskResponse {
  task_id: string;              // uuid — использовать для GET /tasks/{task_id}
  status: TaskStatusEnum;       // при 202 всегда "pending"
  estimated_seconds?: number;   // оценочное время выполнения
}
```

```json
{
  "task_id": "d4e5f6a7-b8c9-0123-def0-123456789abc",
  "status": "pending",
  "estimated_seconds": 45
}
```

После получения `task_id` клиент подписывается на WebSocket-события:

```typescript
// Событие: один слайд сгенерирован
interface SlideCompletedEvent {
  event_type: "slide_completed";
  presentation_id: string;  // uuid
  slide_id: string;          // uuid
  position: number;
  progress_percent: number;  // 0–100
}

// Событие: генерация завершена
interface GenerationDoneEvent {
  event_type: "generation_done";
  presentation_id: string;  // uuid
  task_id: string;           // uuid
  slide_count: number;
}

// Событие: генерация завершилась с ошибкой
interface GenerationErrorEvent {
  event_type: "generation_error";
  presentation_id: string;  // uuid
  task_id: string;           // uuid
  error_code: string;
  message: string;
  last_completed_slide: number;  // слайд, с которого возможно возобновление
}
```

### Опрос статуса (polling-альтернатива WebSocket)

```http
GET /tasks/{task_id}
```

```typescript
interface TaskStatus {
  task_id: string;
  status: TaskStatusEnum;
  progress?: number;         // 0–100
  result?: object;           // заполняется после completed
  error?: string;
  created_at: string;        // ISO 8601
  completed_at?: string;     // ISO 8601
}
```

### 402 Payment Required

```json
{
  "error": "PLAN_LIMIT_EXCEEDED",
  "message": "Monthly presentation limit reached. Upgrade your plan to continue.",
  "details": { "limit": 5, "used": 5, "plan": "free" },
  "request_id": "req_01HXABCDE"
}
```

### 422 Unprocessable Entity

```json
{
  "error": "INVALID_STATUS",
  "message": "Presentation must be in 'outline_ready' status to generate slides. Current status: 'draft'.",
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

---

## Валидации

| Условие                    | Правило                                                           | HTTP-код | Код ошибки              |
|----------------------------|-------------------------------------------------------------------|----------|-------------------------|
| `presentation_id`          | Должен существовать и принадлежать организации                    | 404      | `PRESENTATION_NOT_FOUND`|
| Статус презентации         | Должен быть `outline_ready`                                       | 422      | `INVALID_STATUS`        |
| `tone`                     | Если передан: одно из значений `ToneType`                         | 422      | `VALIDATION_ERROR`      |
| `brand_kit_id`             | Если передан: UUID, Brand Kit принадлежит организации             | 404      | `BRAND_KIT_NOT_FOUND`   |
| Лимит тарифа               | Число презентаций < `plans.max_presentations_per_month`           | 402      | `PLAN_LIMIT_EXCEEDED`   |
| Rate limit                 | Не более N запросов в минуту на API-ключ                          | 429      | `RATE_LIMIT_EXCEEDED`   |
| Роль                       | `admin` или `editor`                                              | 403      | `INSUFFICIENT_ROLE`     |

---

## Диаграмма последовательности

```mermaid
sequenceDiagram
    autonumber
    participant Client as Клиент
    participant WS as WebSocket
    participant API as FastAPI
    participant Redis as Redis
    participant Celery as Celery Worker
    participant Qdrant as Qdrant
    participant LLM as LLM API (Claude Sonnet)
    participant LLMh as Claude Haiku (постпроц.)
    participant PG as PostgreSQL
    participant Mongo as MongoDB

    Client->>API: POST /presentations/{id}/generate/slides
    API->>PG: Проверка статуса (outline_ready) и прав
    API->>Redis: Rate limit check
    API->>Celery: Постановка задачи в очередь generation
    API->>PG: Статус презентации → generating
    API-->>Client: 202 Accepted — {task_id, estimated_seconds}

    Client->>WS: Подписка на события presentation_id

    loop Для каждого слайда из Outline
        Celery->>Qdrant: RAG-поиск по key_thesis (top-10 чанков)
        Qdrant-->>Celery: Релевантные чанки
        Celery->>LLM: Промпт (слайд + RAG-контекст + tone + brand_kit)
        LLM-->>Celery: SlideContent + AttributionItems
        Celery->>LLMh: Постпроцессинг (AI-cliché filter, forbidden_words)
        LLMh-->>Celery: Очищенный контент + hallucination_flags
        Celery->>PG: Сохранение слайда
        Celery->>Mongo: Запись generation_traces
        Celery->>Redis: Обновление gen_checkpoint:{task_id}
        Celery->>Redis: Публикация в gen_progress stream
        Redis-->>WS: pubsub:gen_progress
        WS-->>Client: slide_completed {position, progress_percent}
    end

    Celery->>PG: Статус презентации → ready; создание версии
    Celery->>Redis: Обновление task status → completed
    Redis-->>WS: pubsub:gen_progress (done)
    WS-->>Client: generation_done {slide_count}
```

---

## Безопасность

- **Аутентификация:** Bearer JWT (TTL 15 мин) или `X-API-Key`; WebSocket использует тот же JWT в заголовке `Authorization` при рукопожатии.
- **Авторизация:** RBAC — только `editor` и `admin`; `viewer` получает `403`.
- **Мультиарендность:** Qdrant-поиск ограничен коллекцией `org_{id}_docs`; Brand Kit применяется только из организации пользователя.
- **Checkpoint-безопасность:** состояние LangGraph в Redis `gen_checkpoint:{task_id}` имеет TTL 1 ч; при завершении ключ удаляется.
- **Стоимость:** постпроцессинг (Claude Haiku) сокращает стоимость относительно Sonnet; семантический кэш на уровне слайдов снижает повторные LLM-вызовы. Цель: ≤ $0.15 за презентацию (NFR-022).
- **Транспорт:** TLS 1.3; WebSocket — WSS (NFR-006).

---
title: "POST /presentations/{id}/generate/slide/{slide_id}"
description: "Синхронная регенерация одного слайда по инструкции пользователя. Цель: p95 ≤ 5 с."
weight: 5
draft: false
slug: ""
titleIcon: "fa-solid fa-rotate-right"
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

| Свойство       | Значение                                                                      |
|----------------|-------------------------------------------------------------------------------|
| Метод          | `POST`                                                                        |
| URL            | `/presentations/{presentation_id}/generate/slide/{slide_id}`                  |
| Тип            | **Синхронный** — ответ возвращается в теле запроса                            |
| LLM            | Claude Sonnet (primary) / GPT-4o (fallback)                                   |
| RAG            | Нет нового поиска — используются чанки текущего слайда из `generation_traces` |
| Успешный код   | `200 OK`                                                                      |
| SLA            | p95 ≤ 5 секунд (NFR-001)                                                     |
| Теги           | Generation                                                                    |
| Требования     | FR-015 (итеративное редактирование слайдов)                                   |

Перегенерирует один конкретный слайд по инструкции в свободной форме. Контекст слайда (RAG-чанки, тезис, attribution) загружается из MongoDB `generation_traces` — повторный поиск в Qdrant не выполняется. Результат немедленно возвращается в ответе и сохраняется в PostgreSQL. Версионирование: создаётся запись в `presentation_versions` с `change_summary = "slide_regenerated"`.

> **Предусловие:** презентация должна быть в статусе `ready`. Слайды до полной генерации недоступны для перегенерации.

---

## Алгоритм

1. **Аутентификация и авторизация.** Проверка JWT / API-ключа; роли `editor` и `admin` разрешены.
2. **Rate limit.** Проверка Redis `ratelimit:{key_id}:{min}`.
3. **Проверка существования.** `presentation_id` должен принадлежать организации, статус `ready`; `slide_id` должен принадлежать этой презентации.
4. **Загрузка контекста слайда.** Из MongoDB `generation_traces` извлекаются: исходный тезис, RAG-чанки, текущий контент, `hallucination_flags`.
5. **Построение промпта.** Системный промпт включает: текущий контент слайда, исходные чанки, `instruction`, `instruction_type`. При `instruction_type = "shorten"` — дополнительное ограничение токенов вывода.
6. **LLM-вызов.** Claude Sonnet генерирует обновлённый `SlideContent`. При недоступности — Circuit Breaker переключает на GPT-4o.
7. **Постпроцессинг.** Claude Haiku: фильтрация AI-клише, проверка `forbidden_words` из Brand Kit, обновление `hallucination_flags`.
8. **Сохранение.** Обновление строки `slides` в PostgreSQL; создание новой записи в `presentation_versions`; обновление `generation_traces` в MongoDB.
9. **Ответ.** Возврат обновлённого объекта `Slide` с `200 OK`.

---

## Параметры

| Параметр          | Тип  | Расположение | Обязательный | Описание                                       |
|-------------------|------|--------------|:------------:|------------------------------------------------|
| `presentation_id` | uuid | path         | Да           | UUID презентации в статусе `ready`             |
| `slide_id`        | uuid | path         | Да           | UUID слайда, который необходимо перегенерировать |

---

## Тело запроса

**Content-Type:** `application/json`

```typescript
type InstructionType =
  | "shorten"       // сократить контент слайда
  | "expand"        // расширить, добавить детали
  | "change_tone"   // изменить тон подачи
  | "add_data"      // добавить данные / статистику из источников
  | "rewrite"       // переписать полностью
  | "custom";       // произвольная инструкция

interface RegenerateSlideRequest {
  /**
   * Инструкция для AI в свободной форме.
   * Обязательное поле.
   * Пример: "Сделай этот слайд короче, убери все слова, которые звучат как ИИ написал"
   */
  instruction: string;
  /**
   * Тип инструкции — подсказка для выбора стратегии промпта.
   * @default "custom"
   */
  instruction_type?: InstructionType;
}
```

**Примеры запросов:**

*Сократить слайд:*
```json
{
  "instruction": "Оставь только три ключевых метрики, убери вводные фразы",
  "instruction_type": "shorten"
}
```

*Добавить данные:*
```json
{
  "instruction": "Добавь сравнение с аналогичным периодом прошлого года из загруженного отчёта",
  "instruction_type": "add_data"
}
```

*Произвольное редактирование:*
```json
{
  "instruction": "Перефразируй bullets в стиле McKinsey: каждый bullet — одно действие с измеримым результатом",
  "instruction_type": "custom"
}
```

---

## Ответы

### 200 OK

```typescript
type SlideContentType = "text" | "chart" | "table" | "image" | "quote" | "mixed";

interface SlideContent {
  bullets?: string[];
  body_text?: string;
  chart?: ChartData;
  table?: TableData;
  image_url?: string;     // uri
  speaker_notes?: string;
}

interface AttributionItem {
  fact_text: string;                                              // утверждение
  source_type: "user_file" | "url" | "model_knowledge";
  source_file_id?: string;  // uuid
  source_url?: string;      // uri
  page_number?: number;
  excerpt?: string;          // цитата из источника
}

interface Slide {
  id: string;                       // uuid
  position: number;                 // 1-based
  title: string;
  content_type?: SlideContentType;
  content?: SlideContent;
  attribution?: AttributionItem[];
  /**
   * true, если слайд содержит факты из знаний модели
   * (не из файлов пользователя). Индикатор для UI.
   */
  has_unverified_facts: boolean;
}
```

```json
{
  "id": "e5f6a7b8-c9d0-1234-ef01-23456789abcd",
  "position": 3,
  "title": "Ключевые метрики Q1 2026",
  "content_type": "text",
  "content": {
    "bullets": [
      "Выручка: 847 млн руб. (+18% к плану)",
      "EBITDA-маржа: 22% (план 20%)",
      "NPS клиентов: 71 (+8 пунктов к Q4 2025)"
    ],
    "speaker_notes": "Подчеркни опережение плана по всем трём метрикам; акцент на рост NPS как ведущий индикатор."
  },
  "attribution": [
    {
      "fact_text": "Выручка: 847 млн руб. (+18% к плану)",
      "source_type": "user_file",
      "source_file_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "page_number": 4,
      "excerpt": "Итоговая выручка Q1 2026 составила 847,3 млн руб."
    }
  ],
  "has_unverified_facts": false
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
  "message": "Role 'viewer' cannot regenerate slides",
  "request_id": "req_01HXABCDE"
}
```

### 404 Not Found

```json
{
  "error": "SLIDE_NOT_FOUND",
  "message": "Slide 'e5f6a7b8-...' not found in presentation 'f1a2b3c4-...'",
  "request_id": "req_01HXABCDE"
}
```

### 422 Unprocessable Entity

```json
{
  "error": "VALIDATION_ERROR",
  "message": "Request body validation failed",
  "details": {
    "instruction": "Field required"
  },
  "request_id": "req_01HXABCDE"
}
```

### 429 Too Many Requests

```json
{
  "error": "RATE_LIMIT_EXCEEDED",
  "message": "Too many generation requests. Retry after 30 seconds.",
  "request_id": "req_01HXABCDE"
}
```

---

## Валидации

| Поле / условие     | Правило                                                            | HTTP-код | Код ошибки              |
|--------------------|--------------------------------------------------------------------|----------|-------------------------|
| `presentation_id`  | Должен существовать и принадлежать организации                     | 404      | `PRESENTATION_NOT_FOUND`|
| Статус презентации | Должен быть `ready`                                                | 422      | `INVALID_STATUS`        |
| `slide_id`         | Должен принадлежать указанной презентации                          | 404      | `SLIDE_NOT_FOUND`       |
| `instruction`      | Обязательное, непустая строка                                      | 422      | `VALIDATION_ERROR`      |
| `instruction_type` | Если передан: одно из значений `InstructionType`                   | 422      | `VALIDATION_ERROR`      |
| Rate limit         | Не более N запросов в минуту на API-ключ                           | 429      | `RATE_LIMIT_EXCEEDED`   |
| Роль               | `admin` или `editor`                                               | 403      | `INSUFFICIENT_ROLE`     |

---

## Диаграмма последовательности

```mermaid
sequenceDiagram
    autonumber
    participant Client as Клиент
    participant API as FastAPI
    participant Redis as Redis
    participant Mongo as MongoDB
    participant LLM as LLM API (Claude Sonnet)
    participant LLMh as Claude Haiku (постпроц.)
    participant PG as PostgreSQL

    Client->>API: POST /presentations/{id}/generate/slide/{slide_id}
    API->>PG: Проверка статуса презентации (ready) и прав
    API->>PG: Проверка принадлежности slide_id
    API->>Redis: Rate limit check

    API->>Mongo: Загрузка контекста слайда из generation_traces
    Mongo-->>API: RAG-чанки, key_thesis, текущий контент

    API->>LLM: Промпт (текущий слайд + чанки + instruction + instruction_type)
    alt LLM доступен
        LLM-->>API: Обновлённый SlideContent + AttributionItems
    else Circuit Breaker (NFR-011)
        API->>LLM: Fallback → GPT-4o
        LLM-->>API: Обновлённый SlideContent
    end

    API->>LLMh: Постпроцессинг (AI-cliché filter, forbidden_words)
    LLMh-->>API: Очищенный контент + has_unverified_facts

    API->>PG: Обновление слайда; создание записи в presentation_versions
    API->>Mongo: Обновление generation_traces (новый вариант слайда)

    API-->>Client: 200 OK — Slide
```

---

## Безопасность

- **Аутентификация:** Bearer JWT (TTL 15 мин) или `X-API-Key`.
- **Авторизация:** RBAC — только `editor` и `admin`; `viewer` получает `403`.
- **Мультиарендность:** доступ к слайду проверяется через RLS-политику по `org_id`; загрузка контекста из MongoDB фильтруется по `presentation_id` + `org_id`.
- **Атрибуция и прозрачность:** каждый факт в `attribution` содержит ссылку на файл/страницу (Explainability Engine). Поле `has_unverified_facts` позволяет UI предупредить пользователя о данных из знаний модели.
- **Транспорт:** TLS 1.3 (NFR-006).

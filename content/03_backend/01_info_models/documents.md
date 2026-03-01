---
title: "Документные коллекции"
description: "Схемы документных коллекций для хранения трейсов генерации и аналитики."
weight: 3
draft: false
slug: "documents"
titleIcon: "fa-solid fa-file-code"
---

# Документные коллекции

> **Хранилище:** MongoDB 7.0 / PostgreSQL JSONB (альтернатива)
> **Назначение:** Полуструктурированные данные с высокой вариативностью схемы: трейсы AI-генерации, аналитика просмотров, шаблоны промптов.

Эти коллекции хранят данные, которые плохо ложатся в реляционную модель: вложенные объекты с переменным числом полей, большие JSON-деревья состояний LangGraph-пайплайна, потоковые события аналитики.

---

## Коллекция: `generation_traces`

**Назначение:** Полный трейс выполнения LangGraph-пайплайна генерации — каждый узел, prompt, ответ LLM, retrieval results, postprocessing.

### Схема документа

```typescript
interface GenerationTrace {
  _id: ObjectId;
  generation_job_id: string;      // UUID, FK → generation_jobs.id
  presentation_id: string;        // UUID, FK → presentations.id
  organization_id: string;        // UUID для фильтрации

  started_at: Date;
  completed_at?: Date;
  total_duration_ms?: number;

  outline_step?: OutlineStep;     // Шаг генерации outline
  slide_steps: SlideStep[];       // Шаги генерации каждого слайда

  llm_summary: LLMSummary;        // Агрегированная статистика LLM-вызовов
  retrieval_summary: RetrievalSummary; // Статистика retrieval
}

interface OutlineStep {
  prompt_tokens: number;
  completion_tokens: number;
  llm_provider: string;           // 'claude' | 'gpt4o' | 'llama3'
  llm_model: string;              // 'claude-sonnet-4-6' etc.
  prompt_text: string;            // Системный + пользовательский промпт
  raw_response: string;           // Сырой ответ LLM
  parsed_outline: OutlineItem[];  // Распарсенная структура
  duration_ms: number;
  cost_usd: number;
}

interface OutlineItem {
  slide_number: number;
  title: string;
  key_thesis: string;
  slide_type: string;
  data_required: boolean;
}

interface SlideStep {
  slide_id: string;               // UUID
  slide_number: number;
  slide_type: string;

  retrieval_chunks: RetrievalChunk[];   // Найденные чанки из Qdrant
  prompt_tokens: number;
  completion_tokens: number;
  llm_provider: string;
  llm_model: string;
  prompt_text: string;
  raw_response: string;
  parsed_content: object;         // Структурированный контент слайда

  postprocessing: PostprocessingResult;
  duration_ms: number;
  cost_usd: number;
}

interface RetrievalChunk {
  chunk_id: string;
  source_document_id: string;
  source_filename: string;
  page_number?: number;
  text_fragment: string;
  similarity_score: number;       // 0.0 – 1.0
  rank: number;
}

interface PostprocessingResult {
  ai_cliche_count: number;        // Найдено AI-клише до фильтрации
  ai_cliche_removed: number;      // Удалено клише
  hallucination_flags: HallucinationFlag[];
  fact_checks: FactCheck[];
}

interface HallucinationFlag {
  claim: string;
  flag_type: 'not_in_sources' | 'contradicts_source' | 'uncertain';
  confidence: number;
}

interface FactCheck {
  claim: string;
  value_extracted: string;
  found_in_sources: boolean;
  source_chunk_id?: string;
  delta_percent?: number;         // Отклонение числа от источника
}

interface LLMSummary {
  total_calls: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cost_usd: number;
  providers_used: string[];
  fallback_triggered: boolean;    // Был ли failover на запасной LLM
}

interface RetrievalSummary {
  total_retrieval_calls: number;
  avg_chunks_per_slide: number;
  avg_similarity_score: number;
  qdrant_collection: string;
}
```

### Пример документа

```json
{
  "_id": "65f2a3b4c9e8d71234567890",
  "generation_job_id": "018e9a1f-b3c2-7654-9abc-def012345678",
  "presentation_id": "018e9a1f-b3c2-7654-9abc-def012345679",
  "organization_id": "018e9a1f-b3c2-7654-9abc-def012345680",
  "started_at": "2026-03-01T10:15:00.000Z",
  "completed_at": "2026-03-01T10:15:47.320Z",
  "total_duration_ms": 47320,
  "outline_step": {
    "prompt_tokens": 1850,
    "completion_tokens": 420,
    "llm_provider": "claude",
    "llm_model": "claude-sonnet-4-6",
    "prompt_text": "System: You are a professional presentation architect...\nUser: Create an outline for investor pitch about SaaS product growth...",
    "raw_response": "```json\n[{\"slide_number\": 1, \"title\": \"Market Opportunity\"...}]\n```",
    "parsed_outline": [
      {"slide_number": 1, "title": "Рыночная возможность", "key_thesis": "Рынок $2.1B, рост 35% в год", "slide_type": "content", "data_required": true},
      {"slide_number": 2, "title": "Решение", "key_thesis": "RAG + LLM для корпоративных данных", "slide_type": "content", "data_required": false}
    ],
    "duration_ms": 3200,
    "cost_usd": 0.0089
  },
  "slide_steps": [
    {
      "slide_id": "018e9a1f-b3c2-7654-9abc-def012345681",
      "slide_number": 1,
      "slide_type": "content",
      "retrieval_chunks": [
        {
          "chunk_id": "chunk_a1b2c3d4",
          "source_document_id": "018e9a1f-b3c2-7654-9abc-def012345682",
          "source_filename": "market_research_2026.pdf",
          "page_number": 12,
          "text_fragment": "Глобальный рынок AI-инструментов для презентаций оценивается в $2.1 млрд...",
          "similarity_score": 0.94,
          "rank": 1
        }
      ],
      "prompt_tokens": 2100,
      "completion_tokens": 380,
      "llm_provider": "claude",
      "llm_model": "claude-sonnet-4-6",
      "prompt_text": "Generate slide content for 'Market Opportunity'...",
      "raw_response": "...",
      "parsed_content": {
        "title": "Рыночная возможность",
        "bullets": ["$2.1B рынок AI-презентаций в 2026", "Рост 35% YoY"]
      },
      "postprocessing": {
        "ai_cliche_count": 2,
        "ai_cliche_removed": 2,
        "hallucination_flags": [],
        "fact_checks": [
          {"claim": "$2.1B рынок", "value_extracted": "2.1", "found_in_sources": true, "source_chunk_id": "chunk_a1b2c3d4", "delta_percent": 0}
        ]
      },
      "duration_ms": 4100,
      "cost_usd": 0.0096
    }
  ],
  "llm_summary": {
    "total_calls": 16,
    "total_prompt_tokens": 28400,
    "total_completion_tokens": 6200,
    "total_cost_usd": 0.1340,
    "providers_used": ["claude"],
    "fallback_triggered": false
  },
  "retrieval_summary": {
    "total_retrieval_calls": 15,
    "avg_chunks_per_slide": 4.2,
    "avg_similarity_score": 0.87,
    "qdrant_collection": "org_018e9a1f_docs"
  }
}
```

### Индексы

| Поле(я) | Тип | sparse | unique | TTL | Причина |
|---------|-----|--------|--------|-----|---------|
| `generation_job_id` | ASCENDING | false | true | — | Поиск трейса по job ID |
| `presentation_id` | ASCENDING | false | false | — | Трейсы презентации |
| `organization_id` | ASCENDING | false | false | — | Трейсы организации |
| `started_at` | DESCENDING | false | false | 90 дней | Retention policy |
| `llm_summary.fallback_triggered` | ASCENDING | true | false | — | Мониторинг failover-событий |

### Валидаторы уровня БД

```json
{
  "$jsonSchema": {
    "bsonType": "object",
    "required": ["generation_job_id", "presentation_id", "organization_id", "started_at", "slide_steps", "llm_summary"],
    "properties": {
      "generation_job_id": { "bsonType": "string", "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" },
      "presentation_id": { "bsonType": "string" },
      "organization_id": { "bsonType": "string" },
      "started_at": { "bsonType": "date" },
      "slide_steps": {
        "bsonType": "array",
        "items": {
          "bsonType": "object",
          "required": ["slide_id", "slide_number", "slide_type", "duration_ms"]
        }
      },
      "llm_summary": {
        "bsonType": "object",
        "required": ["total_calls", "total_cost_usd", "providers_used"]
      }
    }
  }
}
```

---

## Коллекция: `presentation_analytics`

**Назначение:** Событийная аналитика просмотров и взаимодействий с опубликованными презентациями (согласно US-503 — аналитика просмотров).

### Схема документа

```typescript
interface PresentationAnalyticsEvent {
  _id: ObjectId;
  presentation_id: string;        // UUID
  share_token?: string;           // Токен публичной ссылки
  organization_id: string;        // UUID
  session_id: string;             // Случайный UUID сессии просмотра
  viewer_id?: string;             // UUID пользователя (если залогинен)

  event_type: 'view_started' | 'slide_viewed' | 'slide_time' | 'view_ended' | 'link_clicked' | 'download_triggered';

  slide_number?: number;
  time_on_slide_ms?: number;      // Время на слайде (для slide_time)
  total_view_time_ms?: number;    // Общее время просмотра (для view_ended)
  slides_viewed_count?: number;   // Сколько слайдов посмотрено
  completion_rate?: number;       // 0.0 – 1.0

  referrer?: string;
  user_agent: string;
  ip_hash: string;                // Хеш IP (не сам IP, GDPR)
  country_code?: string;          // GeoIP, 2 буквы
  device_type: 'desktop' | 'mobile' | 'tablet';

  occurred_at: Date;
}
```

### Пример документа

```json
{
  "_id": "65f2a3b4c9e8d71234567891",
  "presentation_id": "018e9a1f-b3c2-7654-9abc-def012345679",
  "share_token": "abc12345def67890ghij1234",
  "organization_id": "018e9a1f-b3c2-7654-9abc-def012345680",
  "session_id": "sess_xyz789abc123",
  "viewer_id": null,
  "event_type": "slide_time",
  "slide_number": 3,
  "time_on_slide_ms": 42000,
  "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)...",
  "ip_hash": "sha256:a1b2c3d4e5f6...",
  "country_code": "RU",
  "device_type": "desktop",
  "occurred_at": "2026-03-01T14:32:15.000Z"
}
```

### Индексы

| Поле(я) | Тип | sparse | unique | TTL | Причина |
|---------|-----|--------|--------|-----|---------|
| `presentation_id, occurred_at` | COMPOUND | false | false | — | Аналитика по презентации |
| `organization_id, occurred_at` | COMPOUND | false | false | — | Аналитика по организации |
| `session_id` | ASCENDING | false | false | — | Группировка сессий |
| `occurred_at` | ASCENDING | false | false | 365 дней | Retention policy (TTL index) |
| `share_token` | ASCENDING | true | false | — | Аналитика конкретной ссылки |

### Валидаторы уровня БД

```json
{
  "$jsonSchema": {
    "bsonType": "object",
    "required": ["presentation_id", "organization_id", "session_id", "event_type", "user_agent", "ip_hash", "device_type", "occurred_at"],
    "properties": {
      "event_type": {
        "enum": ["view_started", "slide_viewed", "slide_time", "view_ended", "link_clicked", "download_triggered"]
      },
      "completion_rate": {
        "bsonType": ["double", "null"],
        "minimum": 0.0,
        "maximum": 1.0
      },
      "device_type": {
        "enum": ["desktop", "mobile", "tablet"]
      },
      "occurred_at": { "bsonType": "date" }
    }
  }
}
```

---

## Коллекция: `prompt_templates`

**Назначение:** Версионированные промпт-шаблоны для LangGraph-узлов — позволяет A/B-тестировать и откатывать промпты без деплоя.

### Схема документа

```typescript
interface PromptTemplate {
  _id: ObjectId;
  template_key: string;           // Уникальный ключ: 'outline_generator_v1'
  version: number;                // Монотонно возрастающий номер версии
  is_active: boolean;             // Используется ли в продакшн
  ab_weight?: number;             // 0.0 – 1.0 для A/B тестирования

  node_type: 'outline' | 'slide_gen' | 'postprocess' | 'fact_check';
  tone_variant?: string;          // NULL = все тональности, или 'formal', 'persuasive'...
  language?: string;              // NULL = все языки, или 'ru', 'en'

  system_prompt: string;          // Системная часть промпта
  user_prompt_template: string;   // Шаблон с переменными {{variable}}
  variables: PromptVariable[];    // Документация переменных

  model_params: ModelParams;
  quality_metrics?: QualityMetrics;

  created_by: string;             // UUID пользователя
  created_at: Date;
  deprecated_at?: Date;
}

interface PromptVariable {
  name: string;
  type: 'string' | 'number' | 'json' | 'list';
  description: string;
  required: boolean;
}

interface ModelParams {
  temperature: number;
  max_tokens: number;
  top_p?: number;
  stop_sequences?: string[];
}

interface QualityMetrics {
  avg_csat_score?: number;
  ai_detection_rate?: number;     // % текстов, определяемых как AI (GPTZero)
  avg_hallucination_flags?: number;
  sample_size?: number;
  evaluated_at?: Date;
}
```

### Пример документа

```json
{
  "_id": "65f2a3b4c9e8d71234567892",
  "template_key": "outline_generator",
  "version": 3,
  "is_active": true,
  "ab_weight": 1.0,
  "node_type": "outline",
  "tone_variant": null,
  "language": "ru",
  "system_prompt": "Ты — опытный бизнес-аналитик и эксперт по структуре презентаций. Ты создаёшь логичные, убедительные структуры на основе предоставленных данных. Никогда не используй клише вроде 'в современном мире', 'это позволяет нам'...",
  "user_prompt_template": "Создай outline для презентации.\nЦель: {{goal}}\nАудитория: {{audience}}\nДоступные данные:\n{{source_summary}}\nКоличество слайдов: {{slide_count}}\n\nВерни JSON-массив...",
  "variables": [
    {"name": "goal", "type": "string", "description": "Цель презентации", "required": true},
    {"name": "audience", "type": "string", "description": "Целевая аудитория", "required": true},
    {"name": "source_summary", "type": "string", "description": "Краткое резюме загруженных источников", "required": false},
    {"name": "slide_count", "type": "number", "description": "Желаемое кол-во слайдов", "required": true}
  ],
  "model_params": {
    "temperature": 0.3,
    "max_tokens": 2000,
    "top_p": 0.9
  },
  "quality_metrics": {
    "avg_csat_score": 4.3,
    "ai_detection_rate": 0.18,
    "avg_hallucination_flags": 0.2,
    "sample_size": 150,
    "evaluated_at": "2026-02-15T00:00:00.000Z"
  },
  "created_by": "018e9a1f-b3c2-7654-9abc-def012345683",
  "created_at": "2026-02-01T10:00:00.000Z"
}
```

### Индексы

| Поле(я) | Тип | sparse | unique | TTL | Причина |
|---------|-----|--------|--------|-----|---------|
| `template_key, version` | COMPOUND | false | true | — | Уникальность версии шаблона |
| `template_key, is_active` | COMPOUND | false | false | — | Активный шаблон для ключа |
| `node_type, is_active` | COMPOUND | false | false | — | Активные шаблоны по типу узла |

### Валидаторы уровня БД

```json
{
  "$jsonSchema": {
    "bsonType": "object",
    "required": ["template_key", "version", "is_active", "node_type", "system_prompt", "user_prompt_template", "model_params", "created_at"],
    "properties": {
      "version": { "bsonType": "int", "minimum": 1 },
      "node_type": { "enum": ["outline", "slide_gen", "postprocess", "fact_check"] },
      "ab_weight": { "bsonType": ["double", "null"], "minimum": 0.0, "maximum": 1.0 },
      "model_params": {
        "bsonType": "object",
        "required": ["temperature", "max_tokens"],
        "properties": {
          "temperature": { "bsonType": "double", "minimum": 0.0, "maximum": 2.0 },
          "max_tokens": { "bsonType": "int", "minimum": 1, "maximum": 32000 }
        }
      }
    }
  }
}
```

---
title: "Кэш и очереди (Redis)"
description: "Схемы Redis-ключей: сессии, семантический кэш LLM, checkpoint генерации, rate limiting."
weight: 5
draft: false
slug: "cache"
titleIcon: "fa-solid fa-bolt"
---

# Redis 7 — Кэш и очереди

> **Конфигурация:** Redis 7 Cluster Mode (3 master + 3 replica)
> **Политика вытеснения:** `allkeys-lru` для кэш-узлов, `noeviction` для очередей
> **Persistence:** AOF (appendonly yes, fsync=everysec) + RDB snapshot каждые 15 мин

---

## Ключ: `session:{session_id}`

**Тип Redis:** HASH

**Схема значения:**

```typescript
interface CachedSession {
  user_id: string;          // UUID пользователя
  organization_id: string;  // UUID активной организации
  role: string;             // Роль в организации: admin | editor | viewer
  email: string;            // Email для быстрой идентификации
  plan: string;             // Тарифный план: free | pro | team | enterprise
  created_at: string;       // ISO 8601 timestamp
  last_active: string;      // Последняя активность (обновляется при каждом запросе)
  ip: string;               // IP при создании сессии
}
```

**Пример:**

```json
{
  "user_id": "018e9a1f-b3c2-7654-9abc-def012345678",
  "organization_id": "018e9a1f-b3c2-7654-9abc-def012345680",
  "role": "editor",
  "email": "anna@company.ru",
  "plan": "team",
  "created_at": "2026-03-01T10:00:00Z",
  "last_active": "2026-03-01T14:32:00Z",
  "ip": "95.24.128.55"
}
```

**TTL:** 86400 секунд (24 часа) — сдвигается при каждом запросе (`EXPIRE session:{id} 86400`)

**Инвалидация:** При явном logout — `DEL session:{session_id}`. При принудительном завершении всех сессий пользователя — Lua-скрипт `SCAN + DEL` по паттерну с фильтрацией по `user_id`.

**Причина кэширования:** Исключает запрос к PostgreSQL при каждом HTTP-запросе для проверки аутентификации и RBAC. Снижает нагрузку на БД в 50–100×.

**Риски:** При изменении роли пользователя — stale данные в кэше до истечения TTL (24 ч). **Митигация:** при изменении роли через Admin API — явно удаляем `session:*` пользователя с помощью вспомогательной структуры `user_sessions:{user_id}` (SET со списком session_id).

---

## Ключ: `user_sessions:{user_id}`

**Тип Redis:** SET

**Схема значения:** `{session_id}` — множество активных session_id пользователя

**Пример:**

```json
["sess_abc123", "sess_def456", "sess_xyz789"]
```

**TTL:** 86400 секунд

**Инвалидация:** Используется для принудительного завершения всех сессий пользователя при смене роли или блокировке:

```python
async def revoke_all_user_sessions(user_id: str) -> int:
    session_ids = await redis.smembers(f"user_sessions:{user_id}")
    if session_ids:
        pipeline = redis.pipeline()
        for sid in session_ids:
            pipeline.delete(f"session:{sid}")
        pipeline.delete(f"user_sessions:{user_id}")
        await pipeline.execute()
    return len(session_ids)
```

**Причина кэширования:** Быстрый поиск всех сессий пользователя без сканирования Redis.

**Риски:** Небольшой race condition — сессия может быть создана после SMEMBERS и до DELETE. **Митигация:** После revoke — пользователь всё равно получит 401 при следующем запросе, так как `session:{id}` уже удалён.

---

## Ключ: `gen_checkpoint:{job_id}`

**Тип Redis:** HASH

**Схема значения:**

```typescript
interface GenerationCheckpoint {
  job_id: string;               // UUID задачи генерации
  presentation_id: string;      // UUID презентации
  status: string;               // running | completed | failed
  outline: string;              // JSON-строка outline презентации
  slides_completed: string;     // Число завершённых слайдов (строка из-за HASH)
  slides_total: string;         // Всего слайдов
  completed_slide_ids: string;  // JSON-массив UUID завершённых слайдов
  last_updated: string;         // ISO 8601 timestamp последнего обновления
  worker_id: string;            // ID Celery worker
  langgraph_state: string;      // JSON-дамп состояния LangGraph (для recovery)
}
```

**Пример:**

```json
{
  "job_id": "018e9a1f-b3c2-7654-9abc-def012345678",
  "presentation_id": "018e9a1f-b3c2-7654-9abc-def012345679",
  "status": "running",
  "outline": "[{\"slide_number\":1,\"title\":\"Рынок\"}...]",
  "slides_completed": "7",
  "slides_total": "15",
  "completed_slide_ids": "[\"uuid1\",\"uuid2\"...]",
  "last_updated": "2026-03-01T10:15:42Z",
  "worker_id": "celery@worker-3.pod",
  "langgraph_state": "{\"current_node\":\"slide_gen_node\",\"slide_index\":7...}"
}
```

**TTL:** 3600 секунд (1 час) — достаточно для любой генерации; обновляется при каждом checkpoint

**Инвалидация:** При успешном завершении генерации — `DEL gen_checkpoint:{job_id}` после записи в PostgreSQL. При провале (max retries) — `HSET status=failed`, TTL не сбрасывается.

**Причина кэширования:** **Checkpoint-based recovery** — если worker умирает после генерации 7 из 15 слайдов, новый worker читает checkpoint и продолжает с 8-го слайда. Без этого — потеря всей генерации и повторные LLM-затраты.

**Риски:** При падении Redis с потерей данных — генерация начнётся сначала. **Митигация:** AOF persistence с fsync=everysec; RPO = 1 секунда. Параллельно ключевые поля (slides_completed) обновляются в PostgreSQL.

---

## Ключ: `gen_progress:{job_id}`

**Тип Redis:** STREAM

**Схема записи:**

```typescript
interface GenerationProgressEvent {
  event_type: string;      // 'slide_started' | 'slide_completed' | 'generation_done' | 'error'
  slide_number?: string;   // Номер слайда
  slide_id?: string;       // UUID слайда
  slide_title?: string;    // Заголовок слайда
  progress_pct: string;    // 0–100, процент выполнения
  timestamp: string;       // Unix timestamp (ms)
  error_message?: string;  // Только для event_type=error
}
```

**Пример записи в stream:**

```python
await redis.xadd(
    f"gen_progress:{job_id}",
    {
        "event_type": "slide_completed",
        "slide_number": "7",
        "slide_id": "018e9a1f-b3c2-7654-9abc-def012345681",
        "slide_title": "Рыночная возможность",
        "progress_pct": "46",
        "timestamp": "1740829200000",
    },
    maxlen=200,    # Хранить не более 200 событий
)
```

**TTL:** 7200 секунд (2 часа) — достаточно для завершения генерации + буфер для клиента

**Инвалидация:** `DEL gen_progress:{job_id}` через 2 часа после `generation_done`-события (или через TTL).

**Причина кэширования:** WebSocket-стриминг прогресса на клиент. API Service читает stream с последней позиции (`XREAD BLOCK 30000 STREAMS gen_progress:{job_id} $`) и пушит события в WebSocket без опроса PostgreSQL.

**Риски:** При переподключении клиента — может пропустить события. **Митигация:** Клиент передаёт `last_event_id`; сервер делает `XREAD STREAMS gen_progress:{job_id} {last_event_id}`.

---

## Ключ: `semantic_cache:{hash}`

**Тип Redis:** STRING (JSON)

**Схема значения:**

```typescript
interface SemanticCacheEntry {
  query_embedding_hash: string;   // SHA-256 от rounded embedding (для ключа)
  original_query: string;         // Исходный запрос
  response: string;               // Ответ LLM (JSON-строка)
  tokens_saved: number;           // Токены, сэкономленные при хите
  llm_provider: string;
  created_at: string;
  hit_count: number;              // Количество хитов кэша
}
```

**Пример:**

```json
{
  "query_embedding_hash": "a1b2c3d4e5f6...",
  "original_query": "Создай outline для питч-дека стартапа в B2B SaaS, аудитория — венчурные инвесторы",
  "response": "[{\"slide_number\":1,\"title\":\"Проблема рынка\"...}]",
  "tokens_saved": 2100,
  "llm_provider": "claude",
  "created_at": "2026-03-01T09:00:00Z",
  "hit_count": 12
}
```

**Стратегия семантического кэширования:**

```python
async def get_or_create_semantic_cache(
    query: str,
    generate_fn,
    threshold: float = 0.95,  # Cosine similarity порог
) -> str:
    # 1. Получить embedding запроса
    query_embedding = await embed(query)

    # 2. Поиск ближайшего в кэше (через Qdrant semantic cache коллекцию)
    cached = await qdrant.search(
        collection_name="semantic_cache",
        query_vector=query_embedding,
        limit=1,
        score_threshold=threshold,
    )

    if cached:
        cache_key = cached[0].payload["redis_key"]
        entry = await redis.get(cache_key)
        if entry:
            data = json.loads(entry)
            await redis.hincrby(cache_key, "hit_count", 1)
            return data["response"]

    # 3. Cache miss — вызвать LLM
    response = await generate_fn(query)

    # 4. Сохранить в кэш
    cache_key = f"semantic_cache:{hashlib.sha256(query_embedding_bytes).hexdigest()[:32]}"
    await redis.setex(
        cache_key,
        86400,  # TTL 24 часа
        json.dumps({
            "original_query": query,
            "response": response,
            "created_at": datetime.now().isoformat(),
            "hit_count": 0,
        })
    )
    return response
```

**TTL:** 86400 секунд (24 часа) — outline-запросы актуальны в течение дня

**Инвалидация:** По TTL. Принудительная инвалидация не предусмотрена (данные stateless).

**Причина кэширования:** Согласно архитектуре, похожие outline-запросы (cosine > 0.95) отдаются из кэша без вызова LLM. Экономия: ~$0.01 на хит кэша × 1000 похожих запросов = $10/день.

**Риски:** stale outline при изменении источников данных. **Митигация:** Ключ кэша включает хеш source_document_ids — при добавлении нового документа ключ меняется автоматически.

---

## Ключ: `ratelimit:{api_key_id}:{minute}`

**Тип Redis:** STRING (счётчик)

**Схема значения:** Целое число — количество запросов в текущую минуту

**Пример:** `42` (42 запроса из 60 разрешённых за текущую минуту)

```python
async def check_rate_limit(api_key_id: str, limit_per_minute: int) -> bool:
    now = datetime.now()
    window_key = f"ratelimit:{api_key_id}:{now.strftime('%Y%m%d%H%M')}"

    pipeline = redis.pipeline()
    pipeline.incr(window_key)
    pipeline.expire(window_key, 120)  # TTL 2 минуты — гарантия очистки
    results = await pipeline.execute()

    current_count = results[0]
    return current_count <= limit_per_minute
```

**TTL:** 120 секунд (2 минуты) — скользящее окно в 1 минуту + буфер

**Инвалидация:** Автоматически по TTL (ключ включает минуту).

**Причина кэширования:** Низкая latency rate limiting без обращения к БД. Sliding window per API key per minute согласно: Free — 10 req/min, Pro — 60 req/min, Enterprise — custom.

**Риски:** Race condition при высоком параллелизме — INCR атомарен в Redis, race condition отсутствует. Потеря данных при Redis failover — небольшой всплеск запросов до восстановления (допустимо).

---

## Ключ: `ratelimit:user:{user_id}:{minute}`

**Тип Redis:** STRING (счётчик)

**Назначение:** Rate limiting на уровне пользователя для WebUI (не API-ключей).

**TTL:** 120 секунд

**Причина кэширования:** Защита от злоупотребления (abuse prevention) без нагрузки на PostgreSQL.

---

## Ключ: `plan_limits:{organization_id}`

**Тип Redis:** HASH

**Схема значения:**

```typescript
interface PlanLimitsCache {
  plan_name: string;                  // free | pro | team | enterprise
  max_presentations_per_month: string; // число или 'unlimited'
  max_file_size_mb: string;
  ai_tokens_per_month: string;        // число или 'unlimited'
  storage_gb: string;
  features: string;                   // JSON-строка feature-flags
  subscription_status: string;        // active | trialing | past_due
  period_end: string;                 // ISO 8601
}
```

**Пример:**

```json
{
  "plan_name": "team",
  "max_presentations_per_month": "100",
  "max_file_size_mb": "50",
  "ai_tokens_per_month": "5000000",
  "storage_gb": "50",
  "features": "{\"brand_kit\":true,\"api_access\":true,\"webhooks\":true}",
  "subscription_status": "active",
  "period_end": "2026-04-01T00:00:00Z"
}
```

**TTL:** 300 секунд (5 минут)

**Инвалидация:** При изменении тарифа через Admin API — `DEL plan_limits:{organization_id}`.

**Причина кэширования:** Лимиты проверяются при каждом запросе на генерацию/загрузку. JOIN `subscriptions + plans` заменяется одним HGETALL.

**Риски:** 5-минутная задержка применения нового тарифа. **Митигация:** При апгрейде плана — немедленная инвалидация; при даунгрейде — 5 минут некритичны.

---

## Ключ: `usage:{organization_id}:{period}`

**Тип Redis:** HASH

**Схема значения:**

```typescript
interface UsageCounters {
  presentations: string;   // Счётчик презентаций в текущем периоде
  slides: string;          // Счётчик слайдов
  tokens: string;          // Счётчик токенов
  cost_cents: string;      // Стоимость в центах (для точности)
}
```

**Пример:**

```json
{
  "presentations": "23",
  "slides": "312",
  "tokens": "4500000",
  "cost_cents": "1340"
}
```

```python
# Атомарное увеличение счётчиков после генерации
period = datetime.now().strftime("%Y-%m")
pipe = redis.pipeline()
pipe.hincrby(f"usage:{org_id}:{period}", "presentations", 1)
pipe.hincrby(f"usage:{org_id}:{period}", "slides", slides_count)
pipe.hincrby(f"usage:{org_id}:{period}", "tokens", tokens_used)
pipe.hincrby(f"usage:{org_id}:{period}", "cost_cents", int(cost_usd * 100))
pipe.expire(f"usage:{org_id}:{period}", 90 * 24 * 3600)  # 90 дней
await pipe.execute()
```

**TTL:** 90 дней (7776000 секунд) — хранить счётчики за 3 прошлых месяца

**Инвалидация:** Не инвалидируется вручную; по TTL. Периодически (раз в час) flush в `usage_records` PostgreSQL.

**Причина кэширования:** Atomic HINCRBY без блокировок. Счётчики обновляются после каждой генерации без JOIN-запросов к PostgreSQL.

**Риски:** При потере Redis — потеря счётчиков с момента последнего flush. **Митигация:** Flush каждые 15 минут в PostgreSQL через Celery beat; возможен пересчёт из `generation_jobs`.

---

## Ключ: `celery_queue:generation`

**Тип Redis:** LIST (используется Celery)

**Назначение:** Очередь задач генерации презентаций.

**Схема значения:** JSON-encoded Celery task message

**Пример:**

```json
{
  "id": "018e9a1f-b3c2-7654-celery-000000000001",
  "task": "tasks.generation.generate_presentation",
  "args": ["018e9a1f-b3c2-7654-9abc-def012345678"],
  "kwargs": {},
  "retries": 0,
  "eta": null,
  "expires": "2026-03-01T11:15:00Z"
}
```

**TTL:** без TTL (Celery управляет жизненным циклом)

**Инвалидация:** Celery worker делает LPOP при получении задачи. При revoke задачи — специальный CELERY_REVOKES set.

**Причина кэширования:** Асинхронная очередь задач. Разделение API (приём запроса) и Worker (выполнение) — ключ паттерна.

**Риски:** При потере Redis — потеря необработанных задач. **Митигация:** Persistence (AOF + RDB); `CELERY_TASK_TRACK_STARTED=True`; при старте системы — переопубликовать задачи в статусе `pending` из PostgreSQL.

---

## Ключ: `celery_queue:ingestion`

**Тип Redis:** LIST

**Назначение:** Очередь задач индексации документов (chunking + embedding). Выделена отдельно от `generation` чтобы большие файлы не блокировали генерацию.

**TTL:** без TTL

---

## Ключ: `celery_queue:export`

**Тип Redis:** LIST

**Назначение:** Очередь задач экспорта (PPTX/PDF/Google Slides).

**TTL:** без TTL

---

## Ключ: `ws_connections:{user_id}`

**Тип Redis:** SET

**Схема значения:** Множество `{server_id}:{connection_id}` — идентификаторы WebSocket соединений пользователя (на каких Pod)

**Пример:**

```json
["api-pod-1:ws_abc123", "api-pod-1:ws_def456"]
```

**TTL:** 300 секунд (обновляется при каждом heartbeat)

**Причина кэширования:** При горизонтальном масштабировании (несколько API pod) — нужно знать, на каком pod висит WebSocket соединение пользователя для push-уведомлений (Celery worker → Pub/Sub → нужный pod → WebSocket).

**Инвалидация:** При disconnect — SREM. По TTL при потере соединения без корректного disconnect.

---

## Ключ: `pubsub:gen_progress`

**Тип Redis:** PUB/SUB Channel

**Назначение:** Broadcast событий генерации от Celery workers к API pods.

```python
# Worker публикует
await redis.publish(
    "pubsub:gen_progress",
    json.dumps({
        "job_id": job_id,
        "user_id": user_id,
        "event": progress_event,
    })
)

# API pod подписан и пушит в WebSocket
async def handle_pubsub():
    async with redis.pubsub() as pubsub:
        await pubsub.subscribe("pubsub:gen_progress")
        async for message in pubsub.listen():
            if message["type"] == "message":
                data = json.loads(message["data"])
                if data["user_id"] in local_connections:
                    await send_websocket(data["user_id"], data["event"])
```

**TTL:** без TTL (pub/sub канал, не хранит данные)

---

## Ключ: `presentation_view_count:{presentation_id}`

**Тип Redis:** STRING (счётчик)

**Назначение:** Счётчик просмотров публичных ссылок (для быстрого отображения в UI).

**Пример:** `847`

**TTL:** без TTL (постоянный счётчик)

**Инвалидация:** Периодически (раз в минуту) sync в `presentation_shares.view_count` через GETSET + PostgreSQL UPDATE.

**Причина кэширования:** INCR атомарен и O(1); исключает UPDATE-транзакции при каждом просмотре под нагрузкой.

**Риски:** При перезапуске Redis — потеря счётчиков за период с последнего sync. **Митигация:** Sync каждую минуту; потеря ≤ 60 секунд просмотров — допустимо.

---

## Сводная таблица Redis-ключей

| Ключ | Тип | TTL | Назначение |
|------|-----|-----|-----------|
| `session:{id}` | HASH | 24ч | Данные сессии пользователя |
| `user_sessions:{user_id}` | SET | 24ч | Список сессий для revoke |
| `gen_checkpoint:{job_id}` | HASH | 1ч | Checkpoint генерации (recovery) |
| `gen_progress:{job_id}` | STREAM | 2ч | Прогресс для WebSocket |
| `semantic_cache:{hash}` | STRING | 24ч | Кэш LLM-ответов |
| `ratelimit:{key_id}:{min}` | STRING | 2мин | Rate limiting API keys |
| `ratelimit:user:{uid}:{min}` | STRING | 2мин | Rate limiting UI users |
| `plan_limits:{org_id}` | HASH | 5мин | Лимиты тарифа организации |
| `usage:{org_id}:{period}` | HASH | 90д | Счётчики использования |
| `celery_queue:generation` | LIST | — | Очередь генерации |
| `celery_queue:ingestion` | LIST | — | Очередь индексации |
| `celery_queue:export` | LIST | — | Очередь экспорта |
| `ws_connections:{user_id}` | SET | 5мин | WebSocket соединения пользователя |
| `pubsub:gen_progress` | PUB/SUB | — | Broadcast прогресса |
| `presentation_view_count:{id}` | STRING | — | Счётчик просмотров |

---
title: "Архитектура"
description: "Назначение раздела и принятые архитектурные решения системы."
weight: 2
draft: false
slug: ""
titleIcon: "fa-solid fa-diagram-project"
---

Раздел описывает целевую архитектуру решения: состав подсистем, их ответственности и взаимодействия. Здесь фиксируются ключевые архитектурные решения, допущения и ограничения, влияющие на реализацию и эксплуатацию.

Материалы используются как опорная точка для согласования интерфейсов, распределения ответственности между компонентами и оценки последствий изменений.

# Архитектурный документ: AI-сервис генерации презентаций

> **Версия:** 1.0 | **Дата:** 28.02.2026 | **Статус:** Ready for Development

---

## Executive Summary

Сервис генерации презентаций строится на принципе **«смысл прежде дизайна»**: RAG-пайплайн извлекает данные из пользовательских источников, LLM формирует аргументированную структуру, шаблонизатор применяет корпоративный Brand Kit, и только затем генерируется финальный слайд-дек.

**Ключевые архитектурные решения:**

| Решение | Выбор | Обоснование |
|---|---|---|
| Бэкенд | Python (FastAPI) | Нативная экосистема ML/AI, async, высокая производительность |
| AI-оркестрация | LangChain + LangGraph | Зрелый RAG-фреймворк, поддержка агентов и итеративных цепочек |
| LLM (основной) | Claude claude-sonnet-4-6 / GPT-4o (fallback) | Качество генерации, мультимодальность, API-доступность |
| Векторное хранилище | Qdrant | Производительность, self-hosted вариант для on-premise |
| СУБД | PostgreSQL + Redis | Надёжность + кэширование/очереди |
| Очереди задач | Celery + Redis / AWS SQS | Асинхронная обработка тяжёлых файлов |
| Генерация PPTX | python-pptx | Нативная библиотека, полная редактируемость |
| Фронтенд | Next.js (React) | SSR, производительность, богатая экосистема |
| Инфраструктура | Kubernetes (EKS/GKE) | Горизонтальное масштабирование, управление ресурсами |

**Целевые показатели надёжности:** uptime 99.5%, Time-to-First-Slide < 5 сек, генерация 15 слайдов < 60 сек.

---

## Этап 0. Анализ бизнес-контекста и архитектурных драйверов

### Прогнозируемые нагрузки

**Временные горизонты и DAU:**

| Период | MAU | DAU | Пик RPS (генерация) |
|---|---|---|---|
| Мес. 3 | 5 000 | 500 | 5–10 |
| Мес. 6 | 25 000 | 2 500 | 25–50 |
| Мес. 12 | 100 000 | 10 000 | 100–200 |

**Объём генерируемого контента:**
- Средний размер входных данных: 2–15 МБ (PDF/DOCX/XLSX)
- Средний размер итогового PPTX: 3–8 МБ
- Презентаций на активного пользователя: 6–8/мес
- Расчётный объём хранилища на 12 мес.: ~50 ТБ

**Требования к скорости отклика:**

| Операция | Синхронная цель | Критическое значение |
|---|---|---|
| Генерация outline | < 10 сек | < 20 сек |
| Генерация одного слайда | < 5 сек | < 10 сек |
| Полная презентация (15 слайдов) | < 60 сек | < 120 сек |
| Обработка файла 50 МБ | < 30 сек (async) | < 60 сек |
| Экспорт PPTX | < 15 сек | < 30 сек |
| Смена тональности | < 30 сек | < 60 сек |

**Целевой uptime:** 99.5% (≈ 43 часа простоя в год допустимо).

**Географическое распределение:** Приоритет — РФ и СНГ (152-ФЗ), затем EU (GDPR). Основной регион развёртывания — РФ или EU-West с репликацией.

### Ранжирование атрибутов качества

| Приоритет | Атрибут | Обоснование |
|---|---|---|
| 1 | **Экономическая эффективность (AI-затраты)** | LLM API — главная статья COGS; без контроля марже не выжить при масштабировании |
| 2 | **Безопасность данных и compliance** | Блокирует Enterprise-сегмент без 152-ФЗ/GDPR/on-premise; без него нет B корпоративных продаж |
| 3 | **Устойчивость к сбоям** | Потеря сессии генерации = потеря доверия; критично для платящих пользователей |
| 4 | **Горизонтальное масштабирование** | Рост нагрузки в 20× за год требует архитектуры без single bottleneck |
| 5 | **Гибкость замены AI-компонентов** | Рынок LLM меняется быстро; vendor lock-in на одну модель — стратегический риск |
| 6 | **Удобство разработки** | Важно, но вторично относительно продуктовых атрибутов |

---

## Этап 1. Архитектурные требования и ограничения

### Мультитенантность и изоляция данных

Применяется **гибридная модель** изоляции:

- **Free/Pro:** общая БД PostgreSQL со схемой `tenant_id` во всех таблицах. Row-level security (RLS).
- **Team:** общая БД + отдельный S3 bucket per организация для файлов.
- **Enterprise:** опция отдельной схемы PostgreSQL или выделенного инстанса. On-premise: полная изоляция в контуре клиента.

Векторное хранилище (Qdrant): коллекция per tenant с namespace-изоляцией.

### Безопасность и соответствие стандартам

- **Аутентификация:** SSO через SAML 2.0 и OAuth 2.0 (Google, Microsoft, Okta). MFA обязателен для Enterprise.
- **Авторизация:** RBAC на уровне организации и проекта (Admin / Editor / Viewer).
- **Шифрование:** AES-256 at-rest, TLS 1.3 in-transit.
- **152-ФЗ:** данные граждан РФ хранятся в российском регионе.
- **GDPR:** право на удаление, право на экспорт, DPA-соглашения.
- **SOC 2 Type II:** дорожная карта — 18 месяцев после запуска.
- **Аудит:** полный audit log всех действий (кто, что, когда) с хранением 90 дней.

### Интеграция с внешними экосистемами

**Источники данных (входящие):** Google Drive, Microsoft OneDrive/SharePoint (OAuth 2.0), Notion, Confluence (API Token), URL web scraping, file upload (PDF, DOCX, XLSX, CSV, PPTX).

**Рабочее окружение (исходящие события):** Slack slash-command, Microsoft Teams App, webhooks.

**Форматы вывода:** PPTX, PDF, Google Slides (API), веб-ссылка (PWA), PNG/JPEG.

**Влияние на API-дизайн:** публичный REST API + webhook-система с гарантиями доставки, OAuth 2.0 для сторонних интеграций, rate limiting per tenant.

---

## Этап 2. Технологический стек

### Итоговый выбор технологий

| Компонент | Технология | Версия/уровень |
|---|---|---|
| Бэкенд API | Python 3.12 + FastAPI | Production |
| AI-оркестрация | LangChain + LangGraph | Production |
| LLM (primary) | Anthropic Claude API (Sonnet) | Production |
| LLM (fallback) | OpenAI GPT-4o | Failover |
| LLM (on-premise) | vLLM + Llama 3 / Mistral | Enterprise |
| Embeddings | text-embedding-3-large / BGE-M3 | Production |
| Векторное хранилище | Qdrant | Production |
| Реляционная БД | PostgreSQL 16 | Production |
| Кэш / Брокер | Redis 7 (Cluster) | Production |
| Очереди задач | Celery + Redis | Production |
| Object Storage | S3-совместимое (AWS S3 / Yandex S3) | Production |
| Генерация PPTX | python-pptx | Production |
| Парсинг документов | Apache Tika / unstructured.io | Production |
| Генерация графиков | Matplotlib + Plotly | Production |
| Фронтенд | Next.js 14 (React) | Production |
| Realtime | WebSocket (FastAPI native) | Production |
| Gateway | Kong / AWS API Gateway | Production |
| Контейнеризация | Docker + Kubernetes | Production |
| IaC | Terraform + Helm | Production |
| CI/CD | GitHub Actions | Production |
| Мониторинг | Prometheus + Grafana + Jaeger | Production |
| Логирование | ELK Stack (Elasticsearch, Logstash, Kibana) | Production |

---

## Этап 3. Детальное проектирование архитектуры

### 3.1 Высокоуровневая диаграмма C4 (уровень 1 — System Context)

```mermaid
C4Context
    title Система генерации презентаций — Контекст

    Person(user, "Пользователь", "PMM / BA / Консультант / Enterprise-команда")
    Person(admin, "Администратор", "Управление Brand Kit и пользователями")

    System(presgen, "PresentAI", "Сервис генерации презентаций на основе данных пользователя")

    System_Ext(llm, "LLM API", "Anthropic Claude / OpenAI GPT-4o")
    System_Ext(gdrive, "Google Drive / Docs", "Источник данных")
    System_Ext(onedrive, "Microsoft OneDrive / SharePoint", "Источник данных")
    System_Ext(notion, "Notion / Confluence", "Источник данных")
    System_Ext(slack, "Slack / MS Teams", "Уведомления и slash-команды")
    System_Ext(gslides, "Google Slides API", "Экспорт")
    System_Ext(sso, "SSO Provider", "Аутентификация")

    Rel(user, presgen, "Использует", "HTTPS / WebSocket")
    Rel(admin, presgen, "Управляет", "HTTPS")
    Rel(presgen, llm, "Запросы к модели", "HTTPS / REST")
    Rel(presgen, gdrive, "Импорт данных", "OAuth 2.0 / REST")
    Rel(presgen, onedrive, "Импорт данных", "OAuth 2.0 / REST")
    Rel(presgen, notion, "Импорт данных", "API Token / REST")
    Rel(presgen, slack, "Уведомления и бот", "Webhook / Bot API")
    Rel(presgen, gslides, "Экспорт презентаций", "OAuth 2.0 / REST")
    Rel(presgen, sso, "Аутентификация", "SAML 2.0 / OAuth 2.0")
```

### 3.2 Диаграмма C4 (уровень 2 — Контейнеры)

```mermaid
C4Container
    title PresentAI - C4 Container Diagram

    Person(user, "Пользователь", "Работает с презентациями")

    System_Boundary(presgen, "PresentAI Platform") {
        Container(web, "Web App", "Next.js", "UI и редактор слайдов")
        Container(gateway, "API Gateway", "Kong", "Маршрутизация / auth / rate limit")
        Container(api, "API Service", "FastAPI", "REST API и WebSocket")
        Container(rag, "RAG Service", "LangChain", "Индексация и retrieval")
        Container(gen, "Generation Service", "LangGraph", "Оркестрация генерации")
        Container(export, "Export Service", "python-pptx", "Экспорт PPTX / PDF / Slides")
        ContainerDb(pg, "PostgreSQL", "PostgreSQL 16", "Пользователи / проекты / metadata")
        ContainerDb(redis, "Redis", "Redis 7", "Кэш / сессии / очереди")
        ContainerDb(qdrant, "Qdrant", "Vector DB", "Embeddings")
        ContainerDb(s3, "Object Storage", "S3", "Файлы и артефакты")
    }

    Rel(user, web, "Использует", "HTTPS")
    Rel(web, gateway, "API/WebSocket", "HTTPS/WSS")
    Rel(gateway, api, "Проксирование", "HTTP")
    Rel(api, rag, "Запросы retrieval", "gRPC/HTTP")
    Rel(api, gen, "Запуск генерации", "gRPC/HTTP")
    Rel(api, export, "Экспорт", "HTTP")
    Rel(api, pg, "Чтение/запись", "SQL")
    Rel(api, redis, "Кэш и очереди", "TCP")
    Rel(rag, qdrant, "Поиск embeddings", "gRPC")
    Rel(rag, s3, "Чтение документов", "S3 API")
    Rel(export, s3, "Сохранение артефактов", "S3 API")
```

### 3.3 Диаграмма высокоуровневой архитектуры (компоненты)

```mermaid
flowchart TB
    subgraph Client["Клиент"]
        WEB["Web App\nNext.js"]
        WS["WebSocket\nстриминг"]
    end

    subgraph GW["API Gateway (Kong)"]
        AUTH["Auth / JWT\nvalidation"]
        RL["Rate\nLimiting"]
        ROUTE["Routing"]
    end

    subgraph API["API Service (FastAPI)"]
        PROJ["Project\nController"]
        PRES["Presentation\nController"]
        BRAND["Brand Kit\nController"]
        EXP["Export\nController"]
    end

    subgraph RAG["RAG Service"]
        ING["Document\nIngestion"]
        CHUNK["Chunking &\nEmbedding"]
        RET["Retrieval &\nRe-ranking"]
    end

    subgraph GEN["Generation Service (LangGraph)"]
        OUTLINE["Outline\nGenerator"]
        SLIDE_GEN["Slide Content\nGenerator"]
        POST["Post-processor\n(anti-AI filter)"]
        VERIFY["Fact\nVerifier"]
    end

    subgraph EXPORT["Export Service"]
        PPTX_R["PPTX\nRenderer"]
        PDF_R["PDF\nRenderer"]
        GSLIDES["Google Slides\nExporter"]
    end

    subgraph DATA["Data Layer"]
        PG[("PostgreSQL")]
        REDIS[("Redis")]
        QDRANT[("Qdrant\nVector Store")]
        S3[("S3\nObject Storage")]
    end

    subgraph EXT["Внешние системы"]
        LLM_API["LLM API\nClaude / GPT-4o"]
        GDRIVE["Google Drive"]
        OD["OneDrive"]
        SLACK["Slack / Teams"]
    end

    WEB -->|HTTPS| AUTH
    AUTH --> RL
    RL --> ROUTE
    ROUTE --> PRES
    WEB <-->|WSS| WS

    PROJ --> PG
    PRES --> ING
    PRES --> OUTLINE
    EXP --> PPTX_R
    EXP --> PDF_R
    EXP --> GSLIDES

    ING --> S3
    ING --> CHUNK
    CHUNK --> QDRANT
    RET --> QDRANT
    RET --> LLM_API

    OUTLINE --> RET
    OUTLINE --> LLM_API
    SLIDE_GEN --> RET
    SLIDE_GEN --> LLM_API
    SLIDE_GEN --> POST
    POST --> VERIFY

    PPTX_R --> S3
    PDF_R --> S3

    PRES --> REDIS
    PRES --> PG
    GSLIDES --> GDRIVE
```


## 3.4 RAG-пайплайн и обработка данных

### Приём и обработка источников данных

```mermaid
flowchart LR
    subgraph INPUT_B["Источники данных"]
        PDF_SRC["PDF / DOCX"]
        XLS_SRC["XLSX / CSV"]
        URL_SRC["URL"]
        PPTX_SRC["PPTX"]
        IMG_SRC["PNG / JPG"]
    end

    subgraph EXTRACT_B["Извлечение"]
        TIKA["Apache Tika\n/ unstructured.io"]
        PANDAS["pandas\nтабличные данные"]
        SCRAPER["Web Scraper\nBeautifulSoup"]
        OCR["Tesseract OCR\nизображения"]
    end

    subgraph PROCESS_B["Обработка"]
        CHUNK["Chunking\n512 tokens, overlap 64"]
        EMBED["Embedding\ntext-embedding-3-large"]
        META["Метаданные\nисточник, страница, дата"]
    end

    subgraph STOR_B["Хранение"]
        QDRANT_ST[("Qdrant\nper-tenant collection")]
        S3_ST[("S3\nOriginal files")]
    end

    PDF_SRC --> TIKA
    PPTX_SRC --> TIKA
    XLS_SRC --> PANDAS
    URL_SRC --> SCRAPER
    IMG_SRC --> OCR

    TIKA --> CHUNK
    PANDAS --> CHUNK
    SCRAPER --> CHUNK
    OCR --> CHUNK

    CHUNK --> EMBED
    EMBED --> META
    META --> QDRANT_ST
    PDF_SRC --> S3_ST
    XLS_SRC --> S3_ST
```

### Механизмы обеспечения достоверности и борьба с галлюцинациями

**Стратегия атрибуции источников:**
- Каждый chunk при ingestion сохраняет метаданные: `source_file`, `page_number`, `url`, `extracted_at`.
- При генерации слайда модель получает релевантные chunks с метаданными и обязана явно ссылаться на источник в структурированном JSON-ответе.
- Интерфейс отображает иконку-ссылку рядом с каждым фактом; при наведении — preview оригинального фрагмента.

**Проверка числовых утверждений (AI-002):**
1. Пост-процессор парсит числа из сгенерированного текста.
2. Для каждого числа выполняется поиск в векторном хранилище: есть ли chunk с этим числом в ±5% диапазоне?
3. Если совпадения нет — утверждение помечается флагом «⚠ Источник: знания модели».
4. Противоречия между источниками (одна метрика с разными значениями) детектируются на этапе ingestion при сравнении embeddings с высоким cosine-similarity но разными числовыми значениями.

**Пайплайн генерации с проверкой:**

```mermaid
flowchart TD
    A["Запрос генерации слайда"] --> B["Retrieval: top-k chunks из Qdrant"]
    B --> C["LLM: генерация текста\nсо ссылками на источники"]
    C --> D{"Постпроцессинг"}
    D --> E["Удаление AI-клише\nanti-hallucination filter"]
    D --> F["Проверка числовых\nутверждений"]
    D --> G["Консистентность терминологии"]
    F --> H{"Найдено в\nисточниках?"}
    H -->|"Да"| I["Добавить attribution-метаданные"]
    H -->|"Нет"| J["Пометить флагом\nзнания модели"]
    E --> K["Финальный слайд"]
    I --> K
    J --> K
    G --> K
```

**Предотвращение AI-клише (NFR-102):**
- Системный промпт содержит список запрещённых конструкций.
- Выходной постпроцессор на основе регулярных выражений и классификатора заменяет паттерны.
- Целевая метрика: GPTZero классифицирует текст как «человеческий» с P > 70%.

---

## 3.5 Интеграционная архитектура для Enterprise

### Публичный API

```mermaid
flowchart LR
    CLIENT["API Client\nIntegrator"]

    subgraph API_GW_B["API Gateway (Kong)"]
        KEY["API Key\nValidation"]
        RATE["Rate Limiting\nper key, per tenant"]
        USAGE["Usage\nMetering"]
        LOG_GW["Audit\nLogging"]
    end

    subgraph ENDPOINTS_B["REST API v1"]
        PRES_EP["/presentations\nCRUD"]
        GEN_EP["/presentations/id/generate\nAsynchronous"]
        FILE_EP["/files\nUpload sources"]
        BRAND_EP["/brand-kits\nManage Brand Kit"]
        WH_EP["/webhooks\nManage subscriptions"]
        EXPORT_EP["/presentations/id/export\nPPTX / PDF / GSlides"]
    end

    CLIENT --> KEY
    KEY --> RATE
    RATE --> USAGE
    USAGE --> LOG_GW
    LOG_GW --> PRES_EP
    LOG_GW --> GEN_EP
    LOG_GW --> FILE_EP
    LOG_GW --> BRAND_EP
    LOG_GW --> WH_EP
    LOG_GW --> EXPORT_EP
```

**Модель авторизации API:**
- API Key per организация с возможностью создания нескольких ключей с разными scope.
- Rate limits: Free — 10 req/min, Pro — 60 req/min, Enterprise — custom.
- Usage metering: billing по количеству сгенерированных слайдов ($0.05/слайд).

### Webhook-система с гарантиями доставки

```mermaid
sequenceDiagram
    participant SYS as Generation Service
    participant WD as Webhook Dispatcher
    participant DB as PostgreSQL
    participant EXT as External System

    SYS->>DB: Создать событие (status=pending)
    SYS->>WD: Отправить событие
    WD->>EXT: POST /webhook (HMAC-подпись)
    alt Успех (2xx)
        EXT-->>WD: 200 OK
        WD->>DB: status=delivered
    else Ошибка
        EXT-->>WD: 5xx / timeout
        WD->>DB: status=failed, attempts++
        WD->>WD: Retry: exponential backoff 1m - 5m - 30m - 2h - 24h
        Note over WD: Максимум 5 попыток
    end
```

**Гарантии доставки:** at-least-once; идемпотентность на стороне клиента через `event_id`. Хранение событий 7 дней. HMAC-SHA256 подпись для верификации.

**События:** `presentation.generation.started`, `presentation.generation.completed`, `presentation.generation.failed`, `presentation.exported`, `file.processed`.

### Адаптеры экспорта

| Формат | Технология | Особенности |
|---|---|---|
| PPTX | python-pptx | Нативные объекты PowerPoint, встроенные шрифты, редактируемые графики |
| PDF | WeasyPrint / Puppeteer | Векторный, закладки по слайдам |
| Google Slides | Google Slides API v1 | OAuth 2.0, создание в Drive пользователя |
| Web (PWA) | Next.js SSG | Responsive, аналитика просмотров |
| PNG | Playwright headless | Рендеринг слайда через браузер |

---

## Этап 4. Операционные аспекты

### Observability

```mermaid
flowchart LR
    subgraph SVCS_B["Сервисы"]
        SVC1["API Service"]
        SVC2["RAG Service"]
        SVC3["Generation Service"]
        SVC4["Export Service"]
        SVC5["Workers"]
    end

    subgraph COLLECT_B["Сбор данных"]
        PROM["Prometheus\nметрики"]
        OTEL["OpenTelemetry\nтрассировка"]
        FLUENTD["Fluentd\nлоги"]
    end

    subgraph STOR_OBS["Хранение"]
        PROM_DB[("Prometheus TSDB")]
        JAEGER_DB[("Jaeger")]
        ES_DB[("Elasticsearch")]
    end

    subgraph VIZ_B["Визуализация"]
        GRAFANA["Grafana\nДашборды"]
        KIBANA["Kibana\nЛоги"]
        ALERTS["AlertManager\nАлерты - PagerDuty"]
    end

    SVC1 --> PROM
    SVC2 --> PROM
    SVC3 --> PROM
    SVC4 --> PROM
    SVC5 --> PROM
    SVC1 --> OTEL
    SVC2 --> OTEL
    SVC3 --> OTEL
    SVC1 --> FLUENTD
    SVC2 --> FLUENTD
    SVC3 --> FLUENTD
    SVC4 --> FLUENTD
    SVC5 --> FLUENTD
    PROM --> PROM_DB
    PROM_DB --> GRAFANA
    OTEL --> JAEGER_DB
    JAEGER_DB --> GRAFANA
    FLUENTD --> ES_DB
    ES_DB --> KIBANA
    GRAFANA --> ALERTS
```

**Ключевые метрики:**

| Категория | Метрика | Порог алерта |
|---|---|---|
| Производительность | P99 latency генерации outline | > 15 сек |
| Производительность | P99 latency full presentation | > 120 сек |
| Доступность | Uptime API | < 99.5% |
| AI-качество | LLM API error rate | > 2% |
| Бизнес | Presentations generated/hour | Падение > 30% от базового |
| Стоимость | LLM API spend / hour | > порога бюджета |
| Очереди | Celery queue depth | > 500 задач |

**Трассировка:** каждый запрос генерации имеет `trace_id`, который проходит через все сервисы. Особо трассируются: retrieval latency, LLM call latency, postprocessing latency.

### Паттерны отказоустойчивости

```mermaid
flowchart TD
    A["Запрос к LLM"] --> B{"Circuit Breaker"}
    B -->|"Closed"| C["Основной провайдер\nClaude Sonnet"]
    B -->|"Open / Error"| D["Fallback\nGPT-4o"]
    C -->|"Timeout"| E["Retry x2"]
    E -->|"Fail"| D
    D -->|"Timeout"| F["Деградированный режим\nупрощённая генерация"]

    G["Запрос к Qdrant"] --> H{"Health Check"}
    H -->|"OK"| I["Primary Qdrant"]
    H -->|"Fail"| J["Read Replica\nили cached results"]
```

**Паттерны:**
- **Circuit Breaker** для всех внешних API (LLM, Google Drive, OneDrive).
- **Retry с exponential backoff** для идемпотентных операций.
- **Graceful degradation:** при недоступности векторного хранилища — генерация только из промпта без RAG с предупреждением пользователю.
- **Streaming генерация:** слайды рендерятся по мере готовности — потеря соединения теряет только незаконченный слайд, не всю презентацию.
- **Checkpoint-based recovery:** состояние генерации сохраняется в Redis после каждого слайда.

### Резервное копирование и восстановление

| Компонент | Стратегия | RPO | RTO |
|---|---|---|---|
| PostgreSQL | Continuous WAL archiving + daily snapshot | 5 мин | 30 мин |
| Qdrant | Periodic snapshot → S3 (каждые 6 часов) | 6 часов | 1 час |
| S3 (файлы) | Cross-region replication | Real-time | Мгновенно |
| Redis | AOF + RDB snapshot | 1 мин | 15 мин |

### Управление затратами (Cost-Aware Architecture)

**Структура LLM-затрат на 1 презентацию (15 слайдов):**

| Операция | Токены (оценка) | Стоимость |
|---|---|---|
| Генерация outline | ~2 000 | $0.01–0.02 |
| Генерация 15 слайдов | ~15 000 | $0.06–0.10 |
| Postprocessing / verification | ~3 000 | $0.01–0.02 |
| Embeddings (RAG ingestion) | ~10 000 | $0.001 |
| **Итого** | **~30 000** | **$0.08–0.15** |

**Механизмы оптимизации:**
1. **Semantic caching:** похожие outline-запросы (~cosine similarity > 0.95) отдаются из кэша без вызова LLM.
2. **Model tiering:** для outline и постпроцессинга — более дешёвая модель (Haiku / GPT-4o mini); для финальной генерации слайдов — основная.
3. **Batching:** несколько слайдов генерируются в одном LLM-запросе где возможно.
4. **Usage anomaly detection:** алерт при превышении среднего потребления токенов на пользователя в 5×.
5. **Fair-use policy для Enterprise:** soft-лимит с уведомлением при превышении в 3× от плана.

---

## Этап 5. Развёртывание и жизненный цикл

### Инфраструктура как код

```mermaid
flowchart LR
    TF["Terraform\nInfrastructure"]
    HELM["Helm Charts\nKubernetes"]
    ANSIBLE["Ansible\nOn-premise"]

    VPC_R["VPC / Network"]
    EKS_R["EKS / GKE Cluster"]
    RDS_R["RDS PostgreSQL"]
    REDIS_R["ElastiCache Redis"]
    S3_R["S3 Buckets"]
    QDRANT_R["Qdrant Cloud /\nSelf-hosted"]

    API_D["API Service\nDeployment"]
    RAG_D["RAG Service\nDeployment"]
    GEN_D["Generation Service\nDeployment"]
    WORKER_D["Workers\nDeployment"]

    ON_P["Enterprise\non-premise setup"]

    TF --> VPC_R
    TF --> EKS_R
    TF --> RDS_R
    TF --> REDIS_R
    TF --> S3_R
    TF --> QDRANT_R
    HELM --> API_D
    HELM --> RAG_D
    HELM --> GEN_D
    HELM --> WORKER_D
    ANSIBLE --> ON_P
```

**Окружения:** `dev` → `staging` → `production` (EU/RU). Все конфиги хранятся в Git. Secrets через Vault / AWS Secrets Manager.

### CI/CD Pipeline

```mermaid
flowchart LR
    PR["Pull Request"] --> LINT["Lint &\nType Check"]
    LINT --> UNIT["Unit Tests\n(pytest, vitest)"]
    UNIT --> INT["Integration Tests\n(testcontainers)"]
    INT --> BUILD["Docker Build\n& Push"]
    BUILD --> DEPLOY_STAGING["Deploy to\nStaging"]
    DEPLOY_STAGING --> E2E["E2E Tests\n(Playwright)"]
    E2E --> LOAD["Load Tests\n(k6, 100 VU)"]
    LOAD -->|main branch| CANARY["Canary Deploy\n(5% трафик)"]
    CANARY -->|Метрики OK| FULL["Full Production\nDeploy"]
    CANARY -->|Аномалии| ROLLBACK["Auto Rollback"]
```

### Стратегии обновления без простоя

**Для stateless-сервисов (API, RAG, Export):** Rolling update с health check. Kubernetes `maxSurge: 25%`, `maxUnavailable: 0`.

**Для Generation Service (AI-компоненты):** Canary deployment:
1. 5% трафика → новая версия.
2. Мониторинг 30 мин: error rate, P99 latency, quality metrics.
3. При отсутствии аномалий — постепенное увеличение до 100%.
4. При аномалиях — автоматический откат.

**Для моделей (prompts/LangGraph chains):** A/B тестирование через feature flags (LaunchDarkly). Новая цепочка генерации активируется для 10% пользователей с мониторингом CSAT.

**Для баз данных:** Zero-downtime migrations через backward-compatible схемы (expand → migrate → contract). Инструмент: Alembic.

---

## Этап 6. Альтернативные решения и анализ компромиссов

### Альтернатива 1: Микросервисы vs Модульный монолит

| Критерий | Микросервисы (выбрано) | Модульный монолит |
|---|---|---|
| Масштабирование | Независимое масштабирование AI-компонентов | Только вертикально или целиком |
| Операционная сложность | Высокая (K8s, service mesh) | Низкая |
| Замена AI-компонентов | Изолированно, без риска для остальных | Требует полного деплоя |
| Time to market (MVP) | Медленнее на старте | Быстрее на старте |
| Команда < 5 чел. | Overhead значительный | Оптимально |
| Команда 10+ чел. | Оптимально | Coordination hell |

**Решение:** Начать с **модульного монолита** (MVP, 0–6 мес.), разрезать на сервисы по мере роста команды и нагрузки. Граница разреза определена заранее (RAG, Generation, Export — независимые модули).

### Альтернатива 2: Векторное хранилище

| Критерий | Qdrant (выбрано) | Pinecone | pgvector |
|---|---|---|---|
| Self-hosted / on-premise | Да (Docker) | Нет (SaaS only) | Да |
| Производительность (>1M vectors) | Отличная | Отличная | Приемлемая |
| Стоимость | Open Source | $70+/мес | Бесплатно (в PostgreSQL) |
| Namespace изоляция (multitenancy) | Да | Да | Через schema/table |
| Enterprise требование | Критично | Блокер | Ок |

**Решение:** Qdrant — единственный вариант с production-ready self-hosted для on-premise Enterprise.

### Альтернатива 3: Подход к генерации изображений

| Критерий | Лицензированные библиотеки (выбрано) | AI-генерация (DALL-E / SD) | Иконочные наборы |
|---|---|---|---|
| Правовые риски | Нет | Высокие (авторское право) | Нет |
| Качество | Стабильное | Непредсказуемое | Ограниченное |
| Стоимость | Фиксированная лицензия | $0.04/изображение | Бесплатно |
| Соответствие контексту | Ручной подбор AI | Высокое | Среднее |

**Решение:** Лицензированные библиотеки (Shutterstock/Getty API) + иконочные наборы (Font Awesome, Phosphor). AI-генерация изображений — только по явному запросу пользователя с предупреждением.

---

## Этап 7. План верификации архитектуры

### Виды тестирования

| Тип | Инструмент | Покрытие / Сценарий |
|---|---|---|
| Unit-тесты | pytest, vitest | >80% coverage, RAG-цепочки, постпроцессор |
| Integration-тесты | testcontainers (PostgreSQL, Redis, Qdrant) | Полный пайплайн ingestion→retrieval→generation |
| Contract-тесты | Pact | API между сервисами |
| E2E-тесты | Playwright | Ключевые user journeys: upload→generate→export |
| Load-тесты | k6 | 200 concurrent users, 30 мин; цель P99 < 10 сек |
| Chaos-тесты | Chaos Mesh | Отключение Qdrant, LLM timeout, Redis failover |
| AI Quality-тесты | GPTZero API, ручная оценка | NFR-102 (anti-AI), NFR-103 (attribution) |
| Security-тесты | OWASP ZAP, Trivy | OWASP Top 10, уязвимости контейнеров |

### Пилотное внедрение

**Фаза 1 (Мес. 1–2):** Closed beta с 50 пользователями из сегмента Early Adopters. Метрики: Time-to-First-Deck, CSAT, количество итераций до экспорта.

**Фаза 2 (Мес. 3):** Open beta. Нагрузочное тестирование с реальным трафиком. Мониторинг LLM-затрат и unit economics.

**Фаза 3 (Мес. 4–6):** Enterprise pilot с 2–3 компаниями. Тестирование on-premise деплоя, Brand Kit, SSO.

---

## Этап 8. Матрица рисков и митигация

| # | Риск | Вероятность | Влияние | Приоритет | Митигация |
|---|---|---|---|---|---|
| R-01 | Vendor lock-in на LLM API (Anthropic/OpenAI недоступны) | Средняя | Критическое | Высокий | Абстракция LLM-слоя через LangChain. Fallback: Claude → GPT-4o → Llama 3 on-premise. Контракт на резервный API. |
| R-02 | Рост LLM-затрат при масштабировании | Высокая | Высокое | Высокий | Semantic caching, model tiering, fair-use policy, мониторинг cost/presentation. Горизонт 18 мес: fine-tuned open-source модель. |
| R-03 | Утечка корпоративных данных пользователей | Низкая | Критическое | Высокий | Шифрование AES-256 + TLS 1.3. Изоляция per-tenant в S3 и Qdrant. On-premise для Enterprise. Audit log. Регулярный pentest. |
| R-04 | Деградация качества генерации на русском | Средняя | Высокое | Высокий | Тестирование моделей на RU corpus. Fine-tuning на деловых текстах RU. Постпроцессор с RU-специфичными фильтрами. |
| R-05 | Быстрый выход Microsoft Copilot / Google Gemini с аналогом | Высокая | Критическое | Высокий | Фокус на нише (консалтинг, корпоративные данные). On-premise как барьер для Enterprise. Скорость итераций > BigTech. |
| R-06 | Производительность Qdrant при росте > 10M векторов | Средняя | Среднее | Средний | Horizontal sharding Qdrant. Индексирование HNSW. Автоматическая очистка старых embeddings (TTL 90 дней). |
| R-07 | Пользователи не готовы платить (AI fatigue) | Средняя | Среднее | Средний | Агрессивный Free tier с реальной ценностью. ROI-калькулятор. NPS-мониторинг. |
| R-08 | Проблемы с авторским правом на дизайн-ассеты | Низкая | Среднее | Низкий | Только лицензированные библиотеки (Shutterstock, Getty). AI-генерация изображений только по явному consent. Юридическая проверка. |
| R-09 | Сложность on-premise деплоя для Enterprise | Средняя | Высокое | Средний | Docker Compose + Helm Chart. Поддержка air-gapped установки. Цель: < 4 часов с документацией. |
| R-10 | Несоответствие требованиям 152-ФЗ / GDPR | Низкая | Критическое | Высокий | Данные граждан РФ — только в RU-регионе. DPA-соглашения. Right to erasure. Консультация с DPO. |

---

## Инфраструктурная схема развёртывания

```mermaid
flowchart TB
    USERS["Пользователи"]
    CDN_N["CloudFront / CDN\nстатика Next.js"]
    EXT_SYS["External Systems\nSlack, Teams, CRM"]

    subgraph CLOUD["Cloud Region (EU / RU)"]
        WAF["WAF - OWASP rules"]
        ALB["Application\nLoad Balancer"]

        subgraph K8S["Kubernetes Cluster (EKS/GKE)"]
            subgraph NS_APP["Namespace: app"]
                API_POD["API Service\n3-10 pods"]
                RAG_POD["RAG Service\n2-6 pods"]
                GEN_POD["Generation Service\n3-8 pods"]
                EXP_POD["Export Service\n2-4 pods"]
                WORKER_POD["Celery Workers\n2-10 pods"]
            end

            subgraph NS_INFRA["Namespace: infra"]
                KONG_POD["Kong API Gateway"]
                WS_POD["WebSocket Hub"]
                WH_POD["Webhook Dispatcher"]
            end
        end

        subgraph MANAGED["Managed Services"]
            RDS_PG["RDS PostgreSQL 16\nMulti-AZ"]
            REDIS_MS["ElastiCache Redis 7\nCluster mode"]
            S3_MS["S3 Object Storage\nPer-tenant buckets"]
            QDRANT_MS["Qdrant\nSelf-hosted in K8s"]
        end

        subgraph OPS["Operations"]
            PROM_OPS["Prometheus"]
            GRAFANA_OPS["Grafana"]
            JAEGER_OPS["Jaeger"]
            ES_OPS["Elasticsearch"]
            VAULT_OPS["HashiCorp Vault\nSecrets"]
        end
    end

    subgraph ON_PREM["Enterprise On-Premise"]
        K8S_OP["Kubernetes\nклиентский контур"]
        LLAMA["vLLM + Llama 3\nлокальная LLM"]
        PG_OP["PostgreSQL"]
        QDRANT_OP["Qdrant"]
    end

    USERS --> CDN_N
    USERS --> WAF
    WAF --> ALB
    ALB --> KONG_POD
    KONG_POD --> API_POD
    KONG_POD --> WS_POD
    API_POD --> RAG_POD
    API_POD --> GEN_POD
    API_POD --> EXP_POD
    API_POD --> WORKER_POD
    API_POD --> RDS_PG
    API_POD --> REDIS_MS
    RAG_POD --> QDRANT_MS
    RAG_POD --> S3_MS
    WORKER_POD --> S3_MS
    WORKER_POD --> RDS_PG
    WH_POD --> EXT_SYS
    API_POD --> VAULT_OPS
    RAG_POD --> VAULT_OPS
    GEN_POD --> VAULT_OPS
```

**Конфигурация autoscaling:**

| Сервис | Min pods | Max pods | HPA trigger |
|---|---|---|---|
| API Service | 3 | 10 | CPU > 60% |
| Generation Service | 3 | 8 | Queue depth > 50 |
| RAG Service | 2 | 6 | CPU > 70% |
| Celery Workers | 2 | 10 | Queue depth > 100 |
| Export Service | 2 | 4 | CPU > 70% |

---

## Приложение: Описание ключевых компонентов

### API Service (FastAPI)
Центральный оркестратор. Отвечает за: аутентификацию и авторизацию (JWT + RBAC), маршрутизацию запросов к downstream сервисам, управление состоянием проектов и презентаций в PostgreSQL, WebSocket-соединения для стриминга прогресса генерации.

### RAG Service (LangChain)
Отвечает за весь пайплайн работы с данными пользователя: ingestion документов (Tika/unstructured), chunking, генерацию embeddings, хранение в Qdrant с per-tenant изоляцией, retrieval с re-ranking при генерации.

### Generation Service (LangGraph)
Реализует stateful граф генерации: `outline_node → [slide_gen_node × N] → postprocess_node → verify_node`. Поддерживает: checkpoint-based recovery, streaming output через WebSocket, итеративное улучшение в рамках сессии (AI-003).

### Export Service (python-pptx)
Рендеринг финального PPTX с нативными объектами PowerPoint: встроенными шрифтами, редактируемыми диаграммами Matplotlib, Brand Kit-параметрами. Конвертация в PDF через LibreOffice headless. Интеграция с Google Slides API.

### Task Workers (Celery)
Асинхронная обработка тяжёлых задач: ingestion больших файлов (> 5 МБ), генерация полных презентаций (non-interactive mode), массовый экспорт, отправка webhook-событий с retry.

---

*Документ подготовлен на основе PRD «Бизнес-контекст и БТ» для хакатона Axenix, трек «Промпт-инжиниринг», 2026.*

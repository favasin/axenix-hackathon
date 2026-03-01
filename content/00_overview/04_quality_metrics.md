---
title: "Метрики качества и итоговая сводка"
description: "Таблица соответствия требований и метрик, инструменты верификации и итоговая сводка SRS."
weight: 4
draft: false
slug: ""
titleIcon: "fa-solid fa-chart-bar"
---

## Содержание

- [Таблица соответствия требований и метрик](#таблица-соответствия-требований-и-метрик)
- [Итог](#итог)

---

## Таблица соответствия требований и метрик

### Функциональные требования — ключевые метрики

| ID требования | Формулировка (кратко) | Метод измерения | Инструмент | Пороговое значение |
|---------------|----------------------|-----------------|------------|-------------------|
| FR-001 | Загрузка файла в рамках лимита плана | Автотест: загрузка файла у границы лимита | Playwright | HTTP 202 за ≤ 2 сек |
| FR-002 | Дедупликация по SHA-256 | Автотест: повторная загрузка того же файла | Playwright | Идентичный source_document_id, 0 новых задач ingestion |
| FR-003 | Импорт веб-страницы | Автотест с mock-URL | testcontainers + httpretty | HTTP 202; `file_type = url`; ingestion запущена |
| FR-009 | Удаление источника + чанков из Qdrant | Интеграционный тест | testcontainers (Qdrant) | 0 чанков в коллекции через 60 сек |
| FR-011 | Генерация outline через RAG | E2E нагрузочный тест | k6, 50 VU | p95 ≤ 10 000 мс (NFR-001) |
| FR-012 | Генерация 15 слайдов с attribution | E2E тест полного flow | Playwright | Все слайды имеют `source_refs`; statус `ready` за ≤ 60 сек p95 |
| FR-013 (HIR) | Постпроцессинг: факт-чек числовых утверждений | Ручная верификация выборки 100 презентаций/нед | Ручная проверка + GPTZero API | Непомеченных галлюцинаций < 0.5 на 1000 презентаций |
| FR-013 (AI) | AI-клише фильтр | GPTZero API на выборке сгенерированных текстов | GPTZero API batch | P(human) ≥ 70% для ≥ 70% текстовых блоков |
| FR-014 | Checkpoint recovery | Chaos-тест: kill Celery worker на слайде 7 | Chaos Mesh | Новый worker подхватывает с слайда 8 за ≤ 60 сек |
| FR-018 | Экспорт PPTX | Нагрузочный тест: 30 concurrent exports | k6 | p95 ≤ 15 000 мс (NFR-003) |
| FR-022 | Создание публичной ссылки | Автотест | Playwright | HTTP 201, token 32 символа |
| FR-025 | Регистрация по email | Автотест | Playwright | HTTP 201; письмо отправлено (mock SMTP) |
| FR-026 | SSO OAuth вход | Интеграционный тест с mock OAuth | testcontainers | JWT и refresh-token выданы |
| FR-028 | Logout-all инвалидирует все сессии | Автотест: 3 активные сессии → logout-all | pytest | Все 3 токена → 401 немедленно |
| FR-031 | RBAC: viewer не может создать презентацию | Автотест матрицы ролей | pytest (15 комбинаций) | 0 нарушений RBAC |
| FR-034 | Удаление аккаунта (GDPR Art. 17) | Автотест: удаление → проверка анонимизации | pytest | Email = `deleted_...` за ≤ 30 сек; HTTP 401 при login |
| FR-041 | CRUD Brand Kit | Автотест | pytest | CRUD за ≤ 500 мс (NFR-004) |
| FR-044 | API-ключ: только хеш в БД | Аудит кода + автотест | pytest | `SELECT key_hash FROM api_keys` → SHA-256, не plaintext |
| FR-047 | Webhook retry (exponential backoff) | Интеграционный тест с failing endpoint | testcontainers | 5 попыток: 1 мин → 5 мин → 30 мин → 2 ч → 24 ч |
| FR-049 | Аудит-лог: запись действий | Автотест каждого события из FR-049 таблицы | pytest | Запись в `audit_logs` за ≤ 500 мс после действия |
| FR-055 | On-premise: 0 запросов к Anthropic API | Smoke-тест при on-premise конфигурации | Сетевой монитор (tcpdump) | 0 запросов к `api.anthropic.com` |

---

### Нефункциональные требования — метрики верификации

| ID требования | Формулировка (кратко) | Метод измерения | Инструмент | Пороговое значение |
|---------------|----------------------|-----------------|------------|-------------------|
| NFR-001 | p95 outline latency | Нагрузочный тест | k6, 50 VU | ≤ 10 000 мс |
| NFR-002 | p95 full presentation latency | Нагрузочный тест | k6, 20 VU | ≤ 60 000 мс |
| NFR-003 | p95 PPTX export latency | Нагрузочный тест | k6, 30 VU | ≤ 15 000 мс |
| NFR-004 | p95 CRUD latency | Нагрузочный тест | k6, 200 VU | ≤ 500 мс |
| NFR-005 | p95 ingestion (≤ 5 МБ) | Нагрузочный тест | k6, 20 VU | ≤ 30 000 мс |
| NFR-006 | Шифрование: AES-256 at-rest | Аудит кода; SELECT BYTEA из БД | pytest + sqlalchemy | access_token_encrypted — BYTEA, не строка |
| NFR-006 | TLS 1.3 in-transit | sslscan / testssl.sh | testssl.sh | Только TLS 1.3; TLS 1.2 отклонён |
| NFR-006 | Пароли: bcrypt ≥ 12 rounds | Аудит кода | ручная проверка | `bcrypt.verify()` с work factor ≥ 12 |
| NFR-007 | JWT access-token TTL ≤ 15 мин | Автотест: использование токена через 16 мин | pytest | HTTP 401 через 16 мин |
| NFR-007 | Блокировка после 5 неудачных login | Автотест | pytest | 6-я попытка → HTTP 429, lockout 15 мин |
| NFR-008 | Audit log: запись за ≤ 500 мс | Автотест | pytest | `created_at` в `audit_logs` ≤ now() + 500 мс |
| NFR-008 | Audit log: запрет DELETE | Автотест | pytest | `DELETE FROM audit_logs` → `permission denied` |
| NFR-009 | Uptime API ≥ 99.5% | Blackbox monitoring | Prometheus Blackbox Exporter | `probe_success` ≥ 99.5% за 30 дней |
| NFR-010 | PostgreSQL RPO ≤ 5 мин | DR drill: восстановление из WAL | ручной тест (квартально) | Потеря данных ≤ 5 мин |
| NFR-010 | PostgreSQL RTO ≤ 30 мин | DR drill: восстановление из snapshot | ручной тест | Восстановление ≤ 30 мин |
| NFR-011 | LLM failover ≤ 30 сек | Chaos-тест: timeout Claude API | Chaos Mesh | Failover на GPT-4o за ≤ 30 сек; `fallback_triggered = true` |
| NFR-012 | HIR < 0.5 на 1000 презентаций | Еженедельная ручная выборка | Ручная верификация (2 аналитика) | < 0.5 непомеченных галлюцинаций |
| NFR-012 | Attribution ≥ 90% числовых утверждений | Автоматический подсчёт из трейсов | Celery scheduled task | `source_refs.count / numeric_claims.count ≥ 0.9` |
| NFR-013 | HPA: scale-out при CPU > 60% | Нагрузочный тест в staging K8s | k6 + kubectl | Pod count увеличивается при нагрузке |
| NFR-014 | RLS: изоляция тенантов | Penetration test: запрос org_A → данные org_B | OWASP ZAP + ручной pentest | 0 строк чужого тенанта в ответе |
| NFR-015 | Qdrant p95 search ≤ 100 мс при 10M векторов | Нагрузочный тест Qdrant | k6 + Qdrant benchmark | p95 ≤ 100 мс |
| NFR-016 | WCAG 2.1 AA: 0 critical violations | Автотест в CI | axe-core | 0 critical / serious violations |
| NFR-017 | API обратная совместимость v1 | Contract-тесты | Pact | 0 breaking changes в v1 |
| NFR-020 | 152-ФЗ: данные РФ только в RU-регионе | Конфигурационный аудит + сетевой монитор | ручная проверка | 0 репликаций PD граждан РФ в EU/US |
| NFR-021 | GDPR: ip_hash вместо IP | Автотест + аудит MongoDB | pytest + pymongo | `ip_hash` присутствует; поля `ip_address` нет в `presentation_analytics` |
| NFR-021 | GDPR Art. 17: удаление за ≤ 30 дней | Функциональный тест FR-034 | pytest | Email анонимизирован за ≤ 30 сек (автоматически) |
| NFR-022 | LLM стоимость ≤ $0.15 / презентацию | Подсчёт из `generation_jobs.total_cost_usd` | Prometheus + Grafana | `avg(total_cost_usd) ≤ 0.15` за последние 7 дней |
| NFR-022 | Semantic cache hit rate ≥ 15% | Подсчёт кэш-хитов | Prometheus `semantic_cache_hits_total / outline_requests_total` | ≥ 0.15 после 1000 запросов |

---

## Итог

### Статистика требований

- **Функциональных требований:** 55 (FR-001 — FR-055)
  - Must: 34
  - Should: 15
  - Could: 6
- **Нефункциональных требований:** 22 (NFR-001 — NFR-022)
- **Ограничений:** 15 (CON-001 — CON-015)
- **Допущений:** 10 (ASS-001 — ASS-010)
- **Пользовательских историй:** 21 (US-001 — US-045, с группировкой)

### Покрытие CRUD по сущностям

| Сущность | C | R | U | D | Примечание |
|----------|---|---|---|---|-----------|
| `users` | FR-025 | FR-033 | FR-033 | FR-034 | Soft delete с анонимизацией |
| `organizations` | FR-029 | FR-029 | FR-029 | — | Удаление не предусмотрено в MVP |
| `organization_members` | FR-030 | FR-030 | FR-031 | FR-031 | |
| `api_keys` | FR-044 | FR-045 | FR-045 | FR-045 | Ротация = C+D |
| `projects` | FR-032 | FR-032 | FR-032 | FR-032 | |
| `brand_kits` | FR-041 | FR-041 | FR-041 | FR-041 | |
| `presentations` | FR-010 | FR-035 | FR-035 | FR-035 | Soft delete 30 дней |
| `slides` | FR-037 | FR-037 | FR-037 | FR-037 | + версионирование |
| `slide_versions` | FR-015 | FR-017 | — | авто | Max 10 версий |
| `source_documents` | FR-001 | FR-008 | — | FR-009 | |
| `presentation_sources` | FR-008 | FR-008 | — | FR-009 | |
| `document_ingestion_jobs` | авто | FR-008 | авто | — | |
| `generation_jobs` | авто | FR-035 | авто | — | |
| `export_jobs` | FR-018 | FR-018 | авто | — | |
| `webhook_subscriptions` | FR-046 | FR-046 | FR-046 | FR-046 | |
| `webhook_events` | авто | FR-048 | — | авто (TTL) | |
| `audit_logs` | авто | FR-050 | запрещено | запрещено | |
| `subscriptions` | авто | FR-039 | FR-039 | FR-039 | |
| `usage_records` | авто | FR-038 | авто | — | |
| `prompt_templates` (MongoDB) | FR-051 | FR-051 | FR-052 | — | Деактивация = soft delete |
| `generation_traces` (MongoDB) | авто | FR-054 | — | авто (TTL 90д) | |
| `presentation_analytics` (MongoDB) | авто | FR-024 | — | авто (TTL 365д) | |

---

### Топ-3 риска

| # | Риск | Вероятность | Влияние | Митигация |
|---|------|-------------|---------|-----------|
| R-1 | **Недоступность LLM API (Claude + GPT-4o одновременно)** — маловероятно, но катастрофично | Низкая | Критическое — полный сбой основной функции | Circuit Breaker + fallback GPT-4o; on-premise vLLM + Llama3 для Enterprise. Контракт на резервный API. Мониторинг `llm_error_rate > 2%` → алерт PagerDuty |
| R-2 | **Утечка корпоративных данных между тенантами** — SQL-инъекция или баг в RLS | Низкая | Критическое — репутационный и юридический ущерб | PostgreSQL RLS + penetration testing ежеквартально; per-tenant Qdrant коллекции; AES-256 at-rest; audit log; OWASP ZAP в CI. Для Enterprise — выделенная схема/инстанс |
| R-3 | **Рост LLM-затрат при масштабировании** — без кэширования и model tiering стоимость > $0.15/презентацию | Высокая | Высокое — маржа < 0, unit economics нарушена | Semantic caching (≥ 15% hit rate), model tiering (Haiku для постпроцессинга), batching слайдов, usage anomaly detection × 5. Мониторинг `avg_cost_usd/presentation` ежедневно |

### Требуют уточнения

> ⚠️ [ASS-007] Платёжный шлюз для RU-региона: Stripe ограничен в РФ с 2022 г. **Вариант А:** YooKassa как основной шлюз для RU-инстанса. **Вариант Б:** только ручное выставление счётов для RU Enterprise. От этого зависит: реализация биллингового модуля, интеграция `subscriptions.external_subscription_id`, UX оплаты.

> ⚠️ Фронтенд-спецификация (`content/02_frontend/_index.md`) содержит только заголовок без детального описания экранов. При проектировании UI использовались допущения по навигации (описаны в [03_interfaces.md](./03_interfaces.md)). Требуется детальный UX-документ для верификации сценариев NFR-019 (≤ 5 кликов до генерации).

### Рекомендация

**Статус: Ready for Sprint Planning.**

Пакет SRS покрывает все 21 сущность информационной модели CRUD-операциями, содержит 55 FR с критериями приёмки и 22 измеримых NFR с методами проверки. Неразрешённых блокирующих вопросов нет.

**Приоритет Sprint 1 (Must, минимальный viable flow):**
1. FR-001 (загрузка файла) + FR-011 (генерация outline) + FR-012 (генерация слайдов) + FR-018 (экспорт PPTX) — сквозной happy path.
2. FR-025 / FR-026 (аутентификация) + FR-029 (организация) — без этого нет мультитенантности.
3. NFR-006 (шифрование) + NFR-014 (RLS изоляция) — безопасность закладывается с первого спринта, не «потом».

**Уточнить до Sprint 2:** биллинговый шлюз для RU-региона (ASS-007), детальный UI/UX документ для верификации NFR-019.

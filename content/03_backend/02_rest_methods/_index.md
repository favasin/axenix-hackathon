---
title: "REST API"
description: "Справочная информация по HTTP-эндпоинтам сервиса."
weight: 2
draft: false
slug: ""
titleIcon: "fa-solid fa-route"
---

Раздел содержит спецификацию REST API: ресурсы, методы, параметры, форматы запросов и ответов, а также коды ошибок. Описания предназначены для интеграций, разработки клиентских приложений и тестирования.

Материалы задают единые правила взаимодействия с сервисом и служат источником истины для внешних и внутренних потребителей API.

{{< swagger >}}

---

## Детальная документация эндпоинтов

### Проекты

- [POST /projects](./createProject) — создание нового проекта в организации (sync, без LLM)

### Презентации

- [POST /presentations](./createPresentation) — создание презентации в статусе `draft` (sync, без LLM)

### Генерация

- [POST /presentations/{id}/generate/outline](./generateOutline) — генерация структуры через RAG + LLM (sync, p95 ≤ 10 с)
- [POST /presentations/{id}/generate/slides](./generateSlides) — генерация всех слайдов (async + WebSocket, p95 ≤ 60 с)
- [POST /presentations/{id}/generate/slide/{slide_id}](./regenerateSlide) — перегенерация одного слайда по инструкции (sync, p95 ≤ 5 с)
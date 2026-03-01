---
title: "Frontend"
description: "Документация по клиентскому приложению и его интеграции с backend."
weight: 3
draft: false
slug: ""
titleIcon: "fa-solid fa-display"
---

Раздел описывает архитектуру фронтенда, структуру приложения и базовые принципы реализации интерфейсов. Здесь фиксируются ключевые пользовательские сценарии и правила взаимодействия с backend API.

Материалы используются для обеспечения единообразия UI, корректной интеграции с сервисами и контроля влияния изменений на пользовательский опыт.

---

## Содержание раздела

### Экраны

- [Лендинг (`/`)](./screens/landing) — публичная главная страница: Navbar, HeroSection, AppPreview
- [Wizard — Шаг 1: Данные и контент](./screens/wizard_step1) — TopicTextarea, FileUploader; `POST /files`
- [Wizard — Шаг 2: Аудитория и цель](./screens/wizard_step2) — AudienceSelector, GoalTextarea; `POST /presentations` + `POST .../generate/outline`

### Компоненты и флоу

- [Реестр компонентов](./components) — сводная таблица всех компонентов, полные описания переиспользуемых (`WizardStepper`, `FileUploader`)
- [Пользовательские сценарии](./user_flows) — сквозные флоу: happy path, регистрация, граничные случаи, сводная таблица API-вызовов

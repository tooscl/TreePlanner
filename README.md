# PlannerApp

Personal local-first planner with nested tasks, inline metadata, smart views, a Kanban focus mode, and a lightweight mind map.

Built as a personal tool in an AI-assisted vibe-coding workflow with ChatGPT-style reasoning and iterative UI/UX polishing.

## What It Does

- create nested tasks and subtasks
- organize work by projects and tags
- write metadata inline: `#tag`, `18/06`, `P1`, `~1:30`
- sort tasks by deadline, priority, and time estimate
- move work through `To do / Active / Hold / Complete` in Kanban
- track actual time spent on the active task and compare it with the estimate
- switch between list planning and `Paths / Tree / Timeline` mind-map views
- use the built-in `Quick 15m` smart list for short tasks
- bulk-edit multiple tasks
- keep everything saved locally in a JSON file

## Stack

- frontend: vanilla HTML, CSS, JavaScript
- backend: small Node.js server
- storage: local JSON file, no database

## Run Locally

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Data

All data is stored locally in:

```text
data/store.json
```

## Project Status

Current working version: `@1.3`

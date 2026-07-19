[default]
help:
    @just --list

[working-directory: 'backend']
sync:
    uv sync

[working-directory: 'backend']
backend-dev:
    uv run uvicorn backend.main:app --reload --port 8000

[working-directory: 'backend']
backend-prod:
    uv run uvicorn backend.main:app --host 0.0.0.0 --port 8000

ui-dev:
    npm --prefix ui run dev

ui-build:
    npm --prefix ui run build

ui-preview:
    npm --prefix ui run preview

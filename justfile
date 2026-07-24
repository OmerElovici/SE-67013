[default]
help:
    @just --list

[working-directory: 'backend']
sync:
    uv sync

[working-directory: 'backend']
backend-dev:
    uv run uvicorn backend.main:app --reload --port 8000 --env-file .env

[working-directory: 'backend']
backend-prod:
    uv run uvicorn backend.main:app --host 0.0.0.0 --port 8000 --env-file .env

[working-directory: 'backend']
check:
    uv run ruff check src tests

[working-directory: 'backend']
format:
    uv run ruff check --fix src tests
    uv run ruff format src tests

[working-directory: 'backend']
test:
    uv run pytest

[working-directory: 'backend']
discord-smoke channel_id seconds="10":
    uv run --env-file .env python -m backend.smoke.discord_voice {{channel_id}} {{seconds}}

backend-status:
    curl --fail --silent http://127.0.0.1:8000/v1/discord/status

backend-channels:
    curl --fail --silent http://127.0.0.1:8000/v1/discord/channels

backend-connect guild_id channel_id:
    curl --fail --silent --request POST --header 'Content-Type: application/json' --data '{"guild_id":{{guild_id}},"channel_id":{{channel_id}}}' http://127.0.0.1:8000/v1/discord/connect

backend-disconnect:
    curl --fail --silent --request POST http://127.0.0.1:8000/v1/discord/disconnect

[working-directory: 'backend']
event-smoke:
    uv run python -m backend.smoke.event_stream

[working-directory: 'backend']
event-monitor seconds="30":
    uv run python -m backend.smoke.event_stream {{seconds}}

ui-dev:
    npm --prefix ui run dev

ui-build:
    npm --prefix ui run build

ui-preview:
    npm --prefix ui run preview

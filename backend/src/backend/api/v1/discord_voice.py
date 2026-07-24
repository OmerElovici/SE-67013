import asyncio
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from backend.services.discord_bot import DiscordBotService
from backend.services.events import EventBroker

router = APIRouter(prefix="/discord", tags=["discord"])


class ConnectRequest(BaseModel):
    guild_id: Annotated[int, Field(gt=0)]
    channel_id: Annotated[int, Field(gt=0)]


def get_discord_service(request: Request) -> DiscordBotService:
    return request.app.state.discord_service


@router.get("/status")
async def discord_status(request: Request):
    return get_discord_service(request).status()


@router.get("/channels")
async def discord_channels(request: Request):
    service = get_discord_service(request)
    try:
        return {"channels": await service.list_channels()}
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.post("/connect")
async def discord_connect(payload: ConnectRequest, request: Request):
    service = get_discord_service(request)
    try:
        return await service.connect(payload.guild_id, payload.channel_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.post("/disconnect")
async def discord_disconnect(request: Request):
    return await get_discord_service(request).disconnect()


@router.websocket("/events")
async def discord_events(websocket: WebSocket):
    await websocket.accept()
    broker: EventBroker = websocket.app.state.event_broker
    service: DiscordBotService = websocket.app.state.discord_service
    queue = broker.subscribe()

    try:
        await websocket.send_json({"type": "status", **service.status()})
        while True:
            event_task = asyncio.create_task(queue.get())
            receive_task = asyncio.create_task(websocket.receive())
            done, pending = await asyncio.wait(
                {event_task, receive_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

            if receive_task in done:
                message = receive_task.result()
                if message["type"] == "websocket.disconnect":
                    break

            if event_task in done:
                await websocket.send_json(event_task.result())
    except WebSocketDisconnect:
        pass
    finally:
        broker.unsubscribe(queue)

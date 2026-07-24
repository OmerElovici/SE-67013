import asyncio
import json
import sys

import websockets


async def run(seconds: float | None = None) -> None:
    async with websockets.connect("ws://127.0.0.1:8000/v1/discord/events") as websocket:
        event = json.loads(await websocket.recv())
        if event.get("type") != "status":
            raise RuntimeError("Expected an initial status event")
        print(f"Event stream opened with state={event.get('state')}")
        if seconds is None:
            return

        try:
            async with asyncio.timeout(seconds):
                while True:
                    print(await websocket.recv())
        except TimeoutError:
            print("Event monitoring complete")


if __name__ == "__main__":
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else None
    asyncio.run(run(duration))

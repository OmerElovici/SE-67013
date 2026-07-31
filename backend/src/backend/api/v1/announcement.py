from fastapi import APIRouter, HTTPException, Request

from backend.services.announcement import AnnouncementService

router = APIRouter(prefix="/discord/announcement", tags=["announcement"])


def get_announcement_service(request: Request) -> AnnouncementService:
    return request.app.state.announcement_service


@router.get("")
async def get_announcement_status(request: Request):
    service = get_announcement_service(request)
    return service.get_status()


@router.post("")
async def upload_announcement(request: Request):
    service = get_announcement_service(request)
    data = await request.body()
    try:
        return service.save_announcement(data)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Failed to save announcement: {error}") from error


@router.delete("")
async def remove_announcement(request: Request):
    service = get_announcement_service(request)
    return service.remove_announcement()

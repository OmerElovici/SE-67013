from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.services.report import ReportService

router = APIRouter(prefix="/reports", tags=["reports"])


class CreateReportRequest(BaseModel):
    session_ids: list[str] = Field(min_length=1)
    language: str = Field(default="en")


def get_report_service(request: Request) -> ReportService:
    return request.app.state.report_service


@router.post("")
async def create_report(payload: CreateReportRequest, request: Request):
    service = get_report_service(request)
    try:
        return await service.generate_report(
            session_ids=payload.session_ids,
            language=payload.language,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Unexpected report generation error: {error}") from error


@router.get("")
async def list_reports(request: Request):
    service = get_report_service(request)
    return {"reports": service.list_reports()}


@router.get("/{report_id}")
async def get_report(report_id: str, request: Request):
    service = get_report_service(request)
    report = service.get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    return report

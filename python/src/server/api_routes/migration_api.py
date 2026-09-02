"""
API routes for database migration tracking and management.
"""

from datetime import datetime

import logfire
from fastapi import APIRouter, Header, HTTPException, Response
from pydantic import BaseModel

from ..config.version import ARCHON_VERSION
from ..services.migration_service import migration_service
from ..utils.etag_utils import check_etag, generate_etag


# Response models
class MigrationRecord(BaseModel):
    """Represents an applied migration."""

    version: str
    migration_name: str
    applied_at: datetime
    checksum: str | None = None


class PendingMigration(BaseModel):
    """Represents a pending migration."""

    version: str
    name: str
    sql_content: str
    file_path: str
    checksum: str | None = None


class MigrationStatusResponse(BaseModel):
    """Complete migration status response."""

    pending_migrations: list[PendingMigration]
    applied_migrations: list[MigrationRecord]
    has_pending: bool
    bootstrap_required: bool
    current_version: str
    pending_count: int
    applied_count: int


class MigrationHistoryResponse(BaseModel):
    """Migration history response."""

    migrations: list[MigrationRecord]
    total_count: int
    current_version: str


class ApplyMigrationRequest(BaseModel):
    """Request to apply a specific migration."""

    version: str
    name: str


class ApplyMigrationResult(BaseModel):
    """Result of applying a single migration."""

    version: str
    name: str
    error: str | None = None


class ApplyMigrationsResponse(BaseModel):
    """Response from applying migrations."""

    success: bool
    message: str
    applied: list[ApplyMigrationResult]
    failed: list[ApplyMigrationResult]
    remaining: int | None = None


class ExecutionCapabilityResponse(BaseModel):
    """Response indicating if direct SQL execution is available."""

    can_execute: bool
    message: str


# Create router
router = APIRouter(prefix="/api/migrations", tags=["migrations"])


@router.get("/status", response_model=MigrationStatusResponse)
async def get_migration_status(
    response: Response, if_none_match: str | None = Header(None)
):
    """
    Get current migration status including pending and applied migrations.

    Returns comprehensive migration status with:
    - List of pending migrations with SQL content
    - List of applied migrations
    - Bootstrap flag if migrations table doesn't exist
    - Current version information
    """
    try:
        # Get migration status from service
        status = await migration_service.get_migration_status()

        # Generate ETag for response
        etag = generate_etag(status)

        # Check if client has current data
        if check_etag(if_none_match, etag):
            # Client has current data, return 304
            response.status_code = 304
            response.headers["ETag"] = f'"{etag}"'
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
            return Response(status_code=304)
        else:
            # Client needs new data
            response.headers["ETag"] = f'"{etag}"'
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
            return MigrationStatusResponse(**status)

    except Exception as e:
        logfire.error(f"Error getting migration status: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get migration status: {str(e)}") from e


@router.get("/history", response_model=MigrationHistoryResponse)
async def get_migration_history(response: Response, if_none_match: str | None = Header(None)):
    """
    Get history of applied migrations.

    Returns list of all applied migrations sorted by date.
    """
    try:
        # Get applied migrations from service
        applied = await migration_service.get_applied_migrations()

        # Format response
        history = {
            "migrations": [
                MigrationRecord(
                    version=m.version,
                    migration_name=m.migration_name,
                    applied_at=m.applied_at,
                    checksum=m.checksum,
                )
                for m in applied
            ],
            "total_count": len(applied),
            "current_version": ARCHON_VERSION,
        }

        # Generate ETag for response
        etag = generate_etag(history)

        # Check if client has current data
        if check_etag(if_none_match, etag):
            # Client has current data, return 304
            response.status_code = 304
            response.headers["ETag"] = f'"{etag}"'
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
            return Response(status_code=304)
        else:
            # Client needs new data
            response.headers["ETag"] = f'"{etag}"'
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
            return MigrationHistoryResponse(**history)

    except Exception as e:
        logfire.error(f"Error getting migration history: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get migration history: {str(e)}") from e


@router.get("/pending", response_model=list[PendingMigration])
async def get_pending_migrations():
    """
    Get list of pending migrations only.

    Returns simplified list of migrations that need to be applied.
    """
    try:
        # Get pending migrations from service
        pending = await migration_service.get_pending_migrations()

        # Format response
        return [
            PendingMigration(
                version=m.version,
                name=m.name,
                sql_content=m.sql_content,
                file_path=m.file_path,
                checksum=m.checksum,
            )
            for m in pending
        ]

    except Exception as e:
        logfire.error(f"Error getting pending migrations: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get pending migrations: {str(e)}") from e


@router.get("/can-execute", response_model=ExecutionCapabilityResponse)
async def check_execution_capability():
    """
    Check if direct SQL execution is available.

    Returns whether DATABASE_URL is configured and migrations can be applied remotely.
    """
    can_execute = migration_service.is_direct_execution_available()

    if can_execute:
        return ExecutionCapabilityResponse(
            can_execute=True,
            message="Direct SQL execution is available. Migrations can be applied remotely.",
        )
    else:
        return ExecutionCapabilityResponse(
            can_execute=False,
            message="DATABASE_URL is not configured. Migrations must be applied manually via Supabase SQL Editor.",
        )


@router.post("/apply", response_model=ApplyMigrationsResponse)
async def apply_all_migrations():
    """
    Apply all pending migrations in order.

    Executes migrations sequentially, stopping on first failure to maintain integrity.
    Requires DATABASE_URL to be configured for direct PostgreSQL access.
    """
    try:
        # Check if direct execution is available
        if not migration_service.is_direct_execution_available():
            raise HTTPException(
                status_code=400,
                detail="DATABASE_URL is not configured. Cannot apply migrations remotely. "
                       "Please set DATABASE_URL or apply migrations manually via Supabase SQL Editor.",
            )

        result = await migration_service.apply_all_pending()

        return ApplyMigrationsResponse(
            success=result["success"],
            message=result["message"],
            applied=[ApplyMigrationResult(**m) for m in result["applied"]],
            failed=[ApplyMigrationResult(**m) for m in result["failed"]],
            remaining=result.get("remaining"),
        )

    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Error applying migrations: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to apply migrations: {str(e)}") from e


@router.post("/apply/single", response_model=ApplyMigrationsResponse)
async def apply_single_migration(request: ApplyMigrationRequest):
    """
    Apply a specific migration by version and name.

    Args:
        request: Migration version and name to apply

    Requires DATABASE_URL to be configured for direct PostgreSQL access.
    """
    try:
        # Check if direct execution is available
        if not migration_service.is_direct_execution_available():
            raise HTTPException(
                status_code=400,
                detail="DATABASE_URL is not configured. Cannot apply migrations remotely.",
            )

        result = await migration_service.apply_single_migration(request.version, request.name)

        if result["success"]:
            return ApplyMigrationsResponse(
                success=True,
                message=result["message"],
                applied=[ApplyMigrationResult(version=request.version, name=request.name)],
                failed=[],
            )
        else:
            return ApplyMigrationsResponse(
                success=False,
                message=result.get("error", "Migration failed"),
                applied=[],
                failed=[ApplyMigrationResult(version=request.version, name=request.name, error=result.get("error"))],
            )

    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Error applying migration {request.version}/{request.name}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to apply migration: {str(e)}") from e

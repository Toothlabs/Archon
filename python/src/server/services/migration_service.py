"""
Database migration tracking and management service.
"""

import hashlib
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import logfire
from supabase import Client

from ..config.version import ARCHON_VERSION
from .client_manager import get_postgres_connection, get_supabase_client, is_direct_sql_enabled


class MigrationRecord:
    """Represents a migration record from the database."""

    def __init__(self, data: dict[str, Any]):
        self.id = data.get("id")
        self.version = data.get("version")
        self.migration_name = data.get("migration_name")
        self.applied_at = data.get("applied_at")
        self.checksum = data.get("checksum")


class PendingMigration:
    """Represents a pending migration from the filesystem."""

    def __init__(self, version: str, name: str, sql_content: str, file_path: str):
        self.version = version
        self.name = name
        self.sql_content = sql_content
        self.file_path = file_path
        self.checksum = self._calculate_checksum(sql_content)

    def _calculate_checksum(self, content: str) -> str:
        """Calculate MD5 checksum of migration content."""
        return hashlib.md5(content.encode()).hexdigest()


class MigrationService:
    """Service for managing database migrations."""

    def __init__(self):
        self._supabase: Client | None = None
        # Handle Docker, local from project root, and local from python/ subdirectory
        possible_paths = [
            Path("/app/migration"),  # Docker environment
            Path("migration"),  # Running from project root
            Path(__file__).parent.parent.parent.parent.parent / "migration",  # From python/src/server/services/
        ]
        self._migrations_dir = next(
            (p for p in possible_paths if p.exists() and p.is_dir()),
            Path("migration"),  # Fallback
        )

    def _get_supabase_client(self) -> Client:
        """Get or create Supabase client."""
        if not self._supabase:
            self._supabase = get_supabase_client()
        return self._supabase

    async def check_migrations_table_exists(self) -> bool:
        """
        Check if the archon_migrations table exists in the database.

        Returns:
            True if table exists, False otherwise
        """
        try:
            supabase = self._get_supabase_client()

            # Query to check if table exists
            result = supabase.rpc(
                "sql",
                {
                    "query": """
                        SELECT EXISTS (
                            SELECT 1
                            FROM information_schema.tables
                            WHERE table_schema = 'public'
                            AND table_name = 'archon_migrations'
                        ) as exists
                    """
                }
            ).execute()

            # Check if result indicates table exists
            if result.data and len(result.data) > 0:
                return result.data[0].get("exists", False)
            return False
        except Exception:
            # If the SQL function doesn't exist or query fails, try direct query
            try:
                supabase = self._get_supabase_client()
                # Try to select from the table with limit 0
                supabase.table("archon_migrations").select("id").limit(0).execute()
                return True
            except Exception as e:
                logfire.info(f"Migrations table does not exist: {e}")
                return False

    async def get_applied_migrations(self) -> list[MigrationRecord]:
        """
        Get list of applied migrations from the database.

        Returns:
            List of MigrationRecord objects
        """
        try:
            # Check if table exists first
            if not await self.check_migrations_table_exists():
                logfire.info("Migrations table does not exist, returning empty list")
                return []

            supabase = self._get_supabase_client()
            result = supabase.table("archon_migrations").select("*").order("applied_at", desc=True).execute()

            return [MigrationRecord(row) for row in result.data]
        except Exception as e:
            logfire.error(f"Error fetching applied migrations: {e}")
            # Return empty list if we can't fetch migrations
            return []

    async def scan_migration_directory(self) -> list[PendingMigration]:
        """
        Scan the migration directory for all SQL files.

        Returns:
            List of PendingMigration objects
        """
        migrations = []

        if not self._migrations_dir.exists():
            logfire.warning(f"Migration directory does not exist: {self._migrations_dir}")
            return migrations

        # Scan all version directories
        for version_dir in sorted(self._migrations_dir.iterdir()):
            if not version_dir.is_dir():
                continue

            version = version_dir.name

            # Scan all SQL files in version directory
            for sql_file in sorted(version_dir.glob("*.sql")):
                try:
                    # Read SQL content
                    with open(sql_file, encoding="utf-8") as f:
                        sql_content = f.read()

                    # Extract migration name (filename without extension)
                    migration_name = sql_file.stem

                    # Create pending migration object
                    # Use path relative to project root (migrations dir parent) for portability
                    try:
                        relative_path = sql_file.relative_to(self._migrations_dir.parent)
                    except ValueError:
                        # Fallback to absolute path if relative fails
                        relative_path = sql_file

                    migration = PendingMigration(
                        version=version,
                        name=migration_name,
                        sql_content=sql_content,
                        file_path=str(relative_path),
                    )
                    migrations.append(migration)
                except Exception as e:
                    logfire.error(f"Error reading migration file {sql_file}: {e}")

        return migrations

    async def get_pending_migrations(self) -> list[PendingMigration]:
        """
        Get list of pending migrations by comparing filesystem with database.

        Returns:
            List of PendingMigration objects that haven't been applied
        """
        # Get all migrations from filesystem
        all_migrations = await self.scan_migration_directory()

        # Check if migrations table exists
        if not await self.check_migrations_table_exists():
            # Bootstrap case - all migrations are pending
            logfire.info("Migrations table doesn't exist, all migrations are pending")
            return all_migrations

        # Get applied migrations from database
        applied_migrations = await self.get_applied_migrations()

        # Create set of applied migration identifiers
        applied_set = {(m.version, m.migration_name) for m in applied_migrations}

        # Filter out applied migrations
        pending = [m for m in all_migrations if (m.version, m.name) not in applied_set]

        return pending

    async def get_migration_status(self) -> dict[str, Any]:
        """
        Get comprehensive migration status.

        Returns:
            Dictionary with pending and applied migrations info
        """
        pending = await self.get_pending_migrations()
        applied = await self.get_applied_migrations()

        # Check if bootstrap is required
        bootstrap_required = not await self.check_migrations_table_exists()

        return {
            "pending_migrations": [
                {
                    "version": m.version,
                    "name": m.name,
                    "sql_content": m.sql_content,
                    "file_path": m.file_path,
                    "checksum": m.checksum,
                }
                for m in pending
            ],
            "applied_migrations": [
                {
                    "version": m.version,
                    "migration_name": m.migration_name,
                    "applied_at": m.applied_at,
                    "checksum": m.checksum,
                }
                for m in applied
            ],
            "has_pending": len(pending) > 0,
            "bootstrap_required": bootstrap_required,
            "current_version": ARCHON_VERSION,
            "pending_count": len(pending),
            "applied_count": len(applied),
        }

    def is_direct_execution_available(self) -> bool:
        """
        Check if direct SQL execution is available.

        Returns:
            True if DATABASE_URL is configured and direct execution is possible
        """
        return is_direct_sql_enabled()

    async def apply_migration(self, migration: PendingMigration) -> dict[str, Any]:
        """
        Apply a single migration to the database.

        Args:
            migration: The PendingMigration to apply

        Returns:
            Dict with success status and details

        Raises:
            ValueError: If direct SQL execution is not available
            Exception: If migration execution fails
        """
        if not self.is_direct_execution_available():
            raise ValueError(
                "Direct SQL execution is not available. "
                "Set DATABASE_URL in your environment to enable remote migrations."
            )

        try:
            async with get_postgres_connection() as conn:
                logfire.info(f"Applying migration: {migration.version}/{migration.name}")

                # Execute the migration SQL within a transaction
                async with conn.transaction():
                    await conn.execute(migration.sql_content)

                    # Check if archon_migrations table exists before recording
                    # Bootstrap case: migrations 001-007 run before 008 creates the table
                    # Migration 008 retroactively records all prior migrations
                    table_exists = await conn.fetchval(
                        """
                        SELECT EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public'
                            AND table_name = 'archon_migrations'
                        )
                        """
                    )

                    if table_exists:
                        # Record the migration in archon_migrations table
                        await conn.execute(
                            """
                            INSERT INTO archon_migrations (version, migration_name, checksum, applied_at)
                            VALUES ($1, $2, $3, $4)
                            ON CONFLICT (version, migration_name) DO NOTHING
                            """,
                            migration.version,
                            migration.name,
                            migration.checksum,
                            datetime.now(UTC),
                        )
                    else:
                        logfire.info(
                            f"Skipping migration tracking for {migration.version}/{migration.name} "
                            "(archon_migrations table not yet created)"
                        )

                logfire.info(f"Successfully applied migration: {migration.version}/{migration.name}")

                return {
                    "success": True,
                    "version": migration.version,
                    "name": migration.name,
                    "message": f"Migration {migration.version}/{migration.name} applied successfully",
                }

        except Exception as e:
            logfire.error(f"Failed to apply migration {migration.version}/{migration.name}: {e}")
            return {
                "success": False,
                "version": migration.version,
                "name": migration.name,
                "error": str(e),
            }

    async def apply_all_pending(self) -> dict[str, Any]:
        """
        Apply all pending migrations in order.

        Returns:
            Dict with overall status and individual migration results
        """
        if not self.is_direct_execution_available():
            return {
                "success": False,
                "error": "Direct SQL execution is not available. Set DATABASE_URL in your environment.",
                "applied": [],
                "failed": [],
            }

        pending = await self.get_pending_migrations()

        if not pending:
            return {
                "success": True,
                "message": "No pending migrations to apply",
                "applied": [],
                "failed": [],
            }

        applied = []
        failed = []

        for migration in pending:
            result = await self.apply_migration(migration)
            if result["success"]:
                applied.append({
                    "version": migration.version,
                    "name": migration.name,
                })
            else:
                failed.append({
                    "version": migration.version,
                    "name": migration.name,
                    "error": result.get("error", "Unknown error"),
                })
                # Stop on first failure to maintain migration order integrity
                break

        return {
            "success": len(failed) == 0,
            "message": f"Applied {len(applied)} migrations" + (f", {len(failed)} failed" if failed else ""),
            "applied": applied,
            "failed": failed,
            "remaining": len(pending) - len(applied) - len(failed),
        }

    async def apply_single_migration(self, version: str, name: str) -> dict[str, Any]:
        """
        Apply a specific migration by version and name.

        Args:
            version: Migration version directory name
            name: Migration file name (without .sql extension)

        Returns:
            Dict with success status and details
        """
        pending = await self.get_pending_migrations()

        # Find the specific migration
        migration = None
        for m in pending:
            if m.version == version and m.name == name:
                migration = m
                break

        if not migration:
            return {
                "success": False,
                "error": f"Migration {version}/{name} not found in pending migrations. "
                         "It may have already been applied or does not exist.",
            }

        return await self.apply_migration(migration)


# Export singleton instance
migration_service = MigrationService()

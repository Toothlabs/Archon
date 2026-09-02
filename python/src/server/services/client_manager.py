"""
Client Manager Service

Manages database and API client connections.
"""

import os
import re
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import asyncpg
from supabase import Client, create_client

from ..config.logfire_config import search_logger


def get_supabase_client() -> Client:
    """
    Get a Supabase client instance.

    Returns:
        Supabase client instance
    """
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_KEY")

    if not url or not key:
        raise ValueError(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in environment variables"
        )

    try:
        # Let Supabase handle connection pooling internally
        client = create_client(url, key)

        # Extract project ID from URL for logging purposes only
        match = re.match(r"https://([^.]+)\.supabase\.co", url)
        if match:
            project_id = match.group(1)
            search_logger.debug(f"Supabase client initialized - project_id={project_id}")

        return client
    except Exception as e:
        search_logger.error(f"Failed to create Supabase client: {e}")
        raise


def get_database_url() -> str | None:
    """
    Get the direct PostgreSQL connection URL if configured.

    Returns:
        Database URL string or None if not configured
    """
    return os.getenv("DATABASE_URL")


def is_direct_sql_enabled() -> bool:
    """
    Check if direct SQL execution is enabled via DATABASE_URL.

    Returns:
        True if DATABASE_URL is configured, False otherwise
    """
    url = get_database_url()
    return bool(url and url.strip())


@asynccontextmanager
async def get_postgres_connection() -> AsyncGenerator[asyncpg.Connection, None]:
    """
    Get a direct PostgreSQL connection using asyncpg.

    This bypasses PostgREST and allows raw SQL execution including DDL statements.
    Required for database migrations that need CREATE/ALTER/DROP operations.

    Yields:
        asyncpg.Connection instance

    Raises:
        ValueError: If DATABASE_URL is not configured
        asyncpg.PostgresError: If connection fails
    """
    database_url = get_database_url()
    if not database_url:
        raise ValueError(
            "DATABASE_URL is not configured. Direct SQL execution requires a PostgreSQL connection string. "
            "Set DATABASE_URL in your environment variables to enable migrations."
        )

    conn = None
    try:
        search_logger.debug("Connecting to PostgreSQL via asyncpg")
        conn = await asyncpg.connect(database_url)
        search_logger.debug("PostgreSQL connection established")
        yield conn
    except asyncpg.PostgresError as e:
        search_logger.error(f"PostgreSQL connection error: {e}")
        raise
    finally:
        if conn:
            await conn.close()
            search_logger.debug("PostgreSQL connection closed")

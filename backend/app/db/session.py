"""
SQLAlchemy 세션/엔진 설정.

DATABASE_URL 환경변수가 없으면 로컬 개발 기본값(postgresql+psycopg2://localhost/kyn_dev)을 쓴다.
테스트는 이 값을 오버라이드해 SQLite in-memory를 사용할 수 있다 (conftest.py 참고).
"""
from __future__ import annotations

import os
from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.models import Base

DEFAULT_DATABASE_URL = "postgresql+psycopg2://localhost/kyn_dev"


def make_engine(database_url: str | None = None):
    url = database_url or os.environ.get("DATABASE_URL", DEFAULT_DATABASE_URL)
    return create_engine(url, future=True)


engine = make_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def init_db(bind=None) -> None:
    Base.metadata.create_all(bind=bind or engine)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

"""
테스트는 SQLite in-memory를 사용해 외부 Postgres 없이도 빠르게 돌아가게 한다.
JSONVariant 타입이 SQLite/Postgres 양쪽에서 동작하도록 설계되어 있어 스키마 호환이 유지된다.
실제 Postgres 연동은 backend/scripts/seed_rule_tables.py로 수동 검증한다.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.models import Base


@pytest.fixture()
def db_session():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, future=True)
    session = Session()
    try:
        yield session
    finally:
        session.close()

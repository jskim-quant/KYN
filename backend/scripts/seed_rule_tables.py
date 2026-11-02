"""
rule_tables/*.yaml → DATABASE_URL(기본 postgresql+psycopg2://localhost/kyn_dev)에 시딩.

실행: python -m scripts.seed_rule_tables
"""
from app.db.repository import seed_rule_tables_from_yaml
from app.db.session import SessionLocal, init_db


def main():
    init_db()
    session = SessionLocal()
    try:
        count = seed_rule_tables_from_yaml(session)
        print(f"Seeded {count} legal rule versions into DB.")
    finally:
        session.close()


if __name__ == "__main__":
    main()

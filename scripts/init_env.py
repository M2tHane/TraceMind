"""Initialize local secrets without overwriting existing configuration."""
from pathlib import Path
import secrets

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    deploy = ROOT / "deploy/.env"
    backend = ROOT / "backend/.env"
    if deploy.exists() or backend.exists():
        raise SystemExit("Configuration already exists; edit it locally instead of overwriting.")
    password = secrets.token_urlsafe(32)
    deploy.write_text(f"POSTGRES_PASSWORD={password}\n", encoding="utf-8")
    deploy.chmod(0o600)
    template = (ROOT / "backend/.env.example").read_text(encoding="utf-8")
    backend.write_text(template.replace("CHANGE_ME", password), encoding="utf-8")
    backend.chmod(0o600)
    print("Created deploy/.env and backend/.env with permissions 600. Add model keys to backend/.env.")


if __name__ == "__main__":
    main()

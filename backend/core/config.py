from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List

# The value the application ships with. Treated as "unset" rather than as a
# secret, so a deployment that never configured one is caught instead of
# running on a key that is published in this repository.
INSECURE_SECRET_KEY = "change-this-secret"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # development | staging | production. Only "production" turns on the strict
    # checks, so local work and the test suite are unaffected.
    ENVIRONMENT: str = "development"

    AZURE_CLIENT_ID: str = ""
    AZURE_CLIENT_SECRET: str = ""
    AZURE_TENANT_ID: str = "common"
    APP_SECRET_KEY: str = INSECURE_SECRET_KEY
    CORS_ORIGINS: str = "http://localhost:5174,http://127.0.0.1:5174"
    DB_PATH: str = "./data/azure_cost.db"

    # --- API protection ---
    # A token bucket per account. Generous enough that no legitimate page load
    # notices it, low enough that a loop cannot amplify into Azure throttling
    # for the whole tenant.
    RATE_LIMIT_REQUESTS: int = 240
    RATE_LIMIT_WINDOW_SECONDS: int = 60
    RATE_LIMIT_ENABLED: bool = True

    # Serving the frontend from a different origin than the API means HSTS and
    # CSP belong on whichever host terminates TLS. Off by default so local HTTP
    # development is not broken by an upgrade-insecure-requests policy.
    SECURITY_HEADERS_HSTS: bool = False

    # Comma-separated emails that get platform-admin rights. Kept out of the
    # database on purpose: an admin cannot be created by anything the app
    # itself exposes, only by whoever controls the deployment environment.
    ADMIN_EMAILS: str = ""

    # --- BOQ chat assistant ---
    # Leave OPENAI_BASE_URL empty for api.openai.com, or point it at a gateway.
    OPENAI_API_KEY: str = ""
    OPENAI_BASE_URL: str = ""
    OPENAI_MODEL: str = "gpt-4o"
    OPENAI_MAX_TOKENS: int = 1500

    @property
    def cors_origins_list(self) -> List[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",")]

    @property
    def admin_emails_list(self) -> List[str]:
        return [e.strip().lower() for e in self.ADMIN_EMAILS.split(",") if e.strip()]

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.strip().lower() == "production"


def production_config_errors(config: "Settings") -> List[str]:
    """
    Configuration that is acceptable locally but must never reach production.

    Returned rather than raised so the caller decides what to do with it: the
    app refuses to start, while a test can assert on the list directly.
    """
    problems: List[str] = []

    if config.APP_SECRET_KEY.strip() in ("", INSECURE_SECRET_KEY):
        problems.append(
            "APP_SECRET_KEY is unset or still the shipped default. "
            "Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(48))\""
        )
    elif len(config.APP_SECRET_KEY.strip()) < 32:
        problems.append("APP_SECRET_KEY must be at least 32 characters.")

    if not config.AZURE_CLIENT_ID.strip():
        problems.append(
            "AZURE_CLIENT_ID is required in production. Without it the API "
            "cannot restrict which application's tokens it accepts."
        )

    insecure_origins = [
        o for o in config.cors_origins_list
        if o and not o.startswith("https://")
    ]
    if insecure_origins:
        problems.append(
            f"CORS_ORIGINS must use https in production. Got: {', '.join(insecure_origins)}"
        )

    return problems


settings = Settings()

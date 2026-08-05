from functools import lru_cache
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings. All secrets come from env / Azure Key Vault."""

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # --- App ---
    APP_NAME: str = "Azure Cloud Insight"
    API_V1_PREFIX: str = "/api/v1"
    ENVIRONMENT: str = "development"
    DEBUG: bool = False
    LOG_LEVEL: str = "INFO"

    # --- Entra ID (multi-tenant app registration) ---
    AZURE_CLIENT_ID: str = ""
    AZURE_CLIENT_SECRET: str = ""
    AZURE_AUTHORITY_HOST: str = "https://login.microsoftonline.com"
    # 'organizations' => any Entra tenant, no personal accounts.
    AZURE_TENANT_ID: str = "organizations"
    JWKS_CACHE_SECONDS: int = 3600
    API_AUDIENCE: str = Field(default="", description="api://<client-id>")
    ALLOWED_TENANT_IDS: str = ""  # empty = allow every consenting tenant
    # Local-development escape hatch. When the app registration does not expose
    # an API (no 'api://<client-id>' resource principal), Entra cannot issue an
    # access token for it, so the SPA can only obtain an ID token whose audience
    # is the bare client id. Accepting it keeps signature, issuer, expiry and
    # tenant checks intact, but an ID token is not an API authorization grant.
    # Never enable this outside development.
    ACCEPT_ID_TOKEN_AUDIENCE: bool = False

    # --- Session ---
    SESSION_SECRET: str = "change-me"
    SESSION_TTL_SECONDS: int = 3600

    # --- Data stores ---
    DATABASE_URL: str = (
        "postgresql+asyncpg://postgres:postgres@localhost:5432/cloudinsight"
    )
    DB_POOL_SIZE: int = 10
    DB_MAX_OVERFLOW: int = 20
    REDIS_URL: str = "redis://localhost:6379/0"
    CELERY_BROKER_URL: str = "redis://localhost:6379/1"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6379/2"

    # --- Azure Key Vault (stores per-tenant connection secrets) ---
    KEY_VAULT_URI: str = ""

    # --- Reporting currency ---
    # JSON object of units-per-USD, merged over app.services.fx.DEFAULT_RATES,
    # e.g. {"INR": 83.4, "EUR": 0.93}. Lets operators pin their own FX rates.
    FX_RATES_JSON: str = ""

    # --- Azure OpenAI ---
    AZURE_OPENAI_ENDPOINT: str = ""
    AZURE_OPENAI_API_KEY: str = ""
    AZURE_OPENAI_DEPLOYMENT: str = "gpt-4o"
    AZURE_OPENAI_API_VERSION: str = "2024-10-21"
    ASSISTANT_MAX_TOKENS: int = 1500
    ASSISTANT_RATE_LIMIT_PER_HOUR: int = 60

    # --- Reports / storage ---
    REPORTS_STORAGE_ACCOUNT_URL: str = ""
    REPORTS_CONTAINER: str = "reports"
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = "noreply@cloudinsight.local"

    # --- Web ---
    CORS_ORIGINS: str = "http://localhost:3000"

    # --- Sync tuning ---
    SYNC_INVENTORY_MINUTES: int = 60
    SYNC_COST_HOURS: int = 24
    SYNC_METRICS_MINUTES: int = 15
    SYNC_SECURITY_HOURS: int = 24
    AZURE_MAX_RETRIES: int = 5
    AZURE_PAGE_SIZE: int = 1000

    @property
    def cors_origins(self) -> List[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def allowed_tenants(self) -> List[str]:
        return [t.strip() for t in self.ALLOWED_TENANT_IDS.split(",") if t.strip()]

    @property
    def audience(self) -> str:
        return self.API_AUDIENCE or f"api://{self.AZURE_CLIENT_ID}"

    @property
    def accepted_audiences(self) -> List[str]:
        values = [self.audience]
        if self.ACCEPT_ID_TOKEN_AUDIENCE and self.ENVIRONMENT != "production":
            values.append(self.AZURE_CLIENT_ID)
        return [v for v in values if v]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

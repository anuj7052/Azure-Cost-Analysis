from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    AZURE_CLIENT_ID: str = ""
    AZURE_CLIENT_SECRET: str = ""
    AZURE_TENANT_ID: str = "common"
    APP_SECRET_KEY: str = "change-this-secret"
    CORS_ORIGINS: str = "http://localhost:5174,http://127.0.0.1:5174"
    DB_PATH: str = "./data/azure_cost.db"

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


settings = Settings()

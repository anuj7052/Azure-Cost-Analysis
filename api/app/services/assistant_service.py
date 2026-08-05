from __future__ import annotations

import json
import logging
from typing import Any, Awaitable, Callable

from openai import AsyncAzureOpenAI
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import AppError
from app.repositories import AlertRepo, RecommendationRepo, ResourceRepo
from app.schemas import AssistantAnswer
from app.services.cost_service import CostService
from app.services.periods import last_n_days, month_to_date

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are the Azure Cloud Insight assistant.

Rules you must follow:
- Answer ONLY from data returned by the provided tools. Never invent resource
  names, costs, or metrics.
- If the tools return no data, say the data is not available and suggest which
  sync needs to run. Do not guess.
- Always include concrete figures and resource names from the tool output.
- Keep answers concise and in plain language; explain Azure jargon briefly.
- Never reveal credentials, tokens, subscription secrets, or internal ids that
  the tools did not return.
"""


class AssistantService:
    """Azure OpenAI assistant with a fixed, tenant-scoped, read-only tool surface.

    The model can never issue SQL or call Azure directly. Every tool closes over
    the caller's `tenant_id`, so a prompt injection cannot cross tenants.
    """

    def __init__(self, session: AsyncSession, tenant_id: str) -> None:
        self.session = session
        self.tenant_id = tenant_id
        self.costs = CostService(session, tenant_id)
        self.resources = ResourceRepo(session, tenant_id)
        self.recommendations = RecommendationRepo(session, tenant_id)
        self.alerts = AlertRepo(session, tenant_id)
        self._client: AsyncAzureOpenAI | None = None

    @property
    def client(self) -> AsyncAzureOpenAI:
        if not settings.AZURE_OPENAI_ENDPOINT or not settings.AZURE_OPENAI_API_KEY:
            raise AppError("Azure OpenAI is not configured for this deployment.")
        if self._client is None:
            self._client = AsyncAzureOpenAI(
                azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
                api_key=settings.AZURE_OPENAI_API_KEY,
                api_version=settings.AZURE_OPENAI_API_VERSION,
            )
        return self._client

    # --- tool implementations (all tenant-scoped) ---------------------
    async def _get_cost_summary(self, **_: Any) -> dict:
        mtd = await self.costs.month_to_date()
        forecast, source = await self.costs.forecast()
        previous = await self.costs.previous_month_total()
        return {
            "month_to_date": mtd.model_dump(),
            "forecast": forecast.model_dump(),
            "forecast_source": source,
            "previous_month": previous.model_dump(),
            "by_service": [
                s.model_dump()
                for s in await self.costs.breakdown("service", month_to_date(), limit=10)
            ],
        }

    async def _get_top_resources_by_cost(self, limit: int = 10, **_: Any) -> dict:
        rows = await self.costs.breakdown("resource", last_n_days(30), limit=limit)
        return {"period_days": 30, "resources": [r.model_dump() for r in rows]}

    async def _explain_cost_change(self, **_: Any) -> dict:
        return {
            "anomalies": await self.costs.anomalies(last_n_days(30)),
            "by_service_this_month": [
                s.model_dump()
                for s in await self.costs.breakdown("service", month_to_date(), limit=10)
            ],
        }

    async def _get_optimization_findings(self, limit: int = 20, **_: Any) -> dict:
        items = await self.recommendations.open_items(limit=limit)
        return {
            "total_monthly_savings": await self.recommendations.total_savings(),
            "findings": [
                {
                    "resource": item.resource_name,
                    "resource_id": item.azure_resource_id,
                    "rule": item.rule,
                    "savings": float(item.estimated_monthly_savings),
                    "action": item.recommended_action,
                    "evidence": item.evidence,
                }
                for item in items
            ],
        }

    async def _get_alerts(self, limit: int = 20, **_: Any) -> dict:
        alerts = await self.alerts.active(limit=limit)
        return {
            "active": [
                {
                    "title": a.title,
                    "severity": a.severity,
                    "resource_id": a.azure_resource_id,
                    "triggered_at": a.triggered_at.isoformat(),
                    "description": a.description,
                }
                for a in alerts
            ]
        }

    async def _describe_resource(self, resource_id: str = "", **_: Any) -> dict:
        resource = await self.resources.by_arm_id(resource_id)
        if resource is None:
            return {"found": False}
        return {
            "found": True,
            "name": resource.name,
            "type": resource.resource_type,
            "location": resource.location,
            "resource_group": resource.resource_group,
            "sku": resource.sku,
            "power_state": resource.power_state,
            "health": resource.health_state,
            "tags": resource.tags,
            "monthly_cost": float(resource.monthly_cost or 0),
        }

    async def _get_meter_breakdown(self, limit: int = 25, **_: Any) -> dict:
        meters = await self.costs.meters(last_n_days(30), limit=limit)
        return {
            "period_days": 30,
            "meters": [m.model_dump() for m in meters],
        }

    async def _get_data_transfer(self, **_: Any) -> dict:
        report = await self.costs.bandwidth(last_n_days(30))
        return {
            "period": [report.period_start.isoformat(), report.period_end.isoformat()],
            "billed_egress_cost": report.total_billed_cost,
            "billed_transfer_gb": report.total_billed_quantity_gb,
            "measured_egress_bytes": report.total_egress_bytes,
            "measured_ingress_bytes": report.total_ingress_bytes,
            "note": "Azure does not bill inbound data, so ingress has no cost line.",
            "meters": [m.model_dump() for m in report.meters[:20]],
            "top_resources": [r.model_dump() for r in report.top_resources[:10]],
        }

    @property
    def _tools(self) -> dict[str, Callable[..., Awaitable[dict]]]:
        return {
            "get_cost_summary": self._get_cost_summary,
            "get_top_resources_by_cost": self._get_top_resources_by_cost,
            "explain_cost_change": self._explain_cost_change,
            "get_meter_breakdown": self._get_meter_breakdown,
            "get_data_transfer": self._get_data_transfer,
            "get_optimization_findings": self._get_optimization_findings,
            "get_alerts": self._get_alerts,
            "describe_resource": self._describe_resource,
        }

    @staticmethod
    def _tool_schema() -> list[dict]:
        return [
            {
                "type": "function",
                "function": {
                    "name": "get_cost_summary",
                    "description": "Month-to-date cost, forecast, previous month and top services.",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "get_top_resources_by_cost",
                    "description": "Highest-cost resources over the last 30 days.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "limit": {"type": "integer", "minimum": 1, "maximum": 50}
                        },
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "explain_cost_change",
                    "description": "Cost anomalies and per-service spend, to explain a bill increase.",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "get_meter_breakdown",
                    "description": (
                        "Cost and billed quantity per billing meter over the last 30 "
                        "days, including unit of measure and effective price. Use this "
                        "for questions about specific charges rather than services."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "limit": {"type": "integer", "minimum": 1, "maximum": 100}
                        },
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "get_data_transfer",
                    "description": (
                        "Bandwidth report: billed egress cost and GB, measured ingress "
                        "and egress bytes, transfer meters and top talking resources."
                    ),
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "get_optimization_findings",
                    "description": "Unused/idle/oversized resources with estimated monthly savings.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "limit": {"type": "integer", "minimum": 1, "maximum": 50}
                        },
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "get_alerts",
                    "description": "Currently active alerts.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "limit": {"type": "integer", "minimum": 1, "maximum": 50}
                        },
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "describe_resource",
                    "description": "Configuration and cost of a single resource by its ARM id.",
                    "parameters": {
                        "type": "object",
                        "properties": {"resource_id": {"type": "string"}},
                        "required": ["resource_id"],
                    },
                },
            },
        ]

    async def ask(self, question: str, resource_id: str | None = None) -> AssistantAnswer:
        user_content = question
        if resource_id:
            user_content += f"\n\n(Context resource id: {resource_id})"

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ]
        used: list[str] = []
        citations: list[dict[str, Any]] = []

        for _ in range(4):  # bounded tool-calling loop
            response = await self.client.chat.completions.create(
                model=settings.AZURE_OPENAI_DEPLOYMENT,
                messages=messages,
                tools=self._tool_schema(),
                tool_choice="auto",
                max_tokens=settings.ASSISTANT_MAX_TOKENS,
                temperature=0.1,
            )
            choice = response.choices[0].message
            if not choice.tool_calls:
                return AssistantAnswer(
                    answer=choice.content or "I could not find data to answer that.",
                    used_tools=used,
                    citations=citations,
                )

            messages.append(choice.model_dump(exclude_none=True))
            for call in choice.tool_calls:
                handler = self._tools.get(call.function.name)
                if handler is None:
                    result: dict[str, Any] = {"error": "unknown tool"}
                else:
                    try:
                        args = json.loads(call.function.arguments or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    result = await handler(**args)
                    used.append(call.function.name)
                    citations.append({"tool": call.function.name, "data": result})

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": json.dumps(result, default=str)[:12000],
                    }
                )

        return AssistantAnswer(
            answer="I could not complete the analysis within the allowed steps.",
            used_tools=used,
            citations=citations,
        )

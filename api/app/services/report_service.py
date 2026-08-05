from __future__ import annotations

import csv
import io
import logging
from datetime import date
from typing import Any

from openpyxl import Workbook
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories import AlertRepo, RecommendationRepo, ResourceRepo
from app.services.cost_service import CostService
from app.services.periods import Period, last_n_days
from app.services.security_service import SecurityService

log = logging.getLogger(__name__)


class ReportService:
    """Builds report payloads and renders them to PDF / Excel / CSV bytes.

    Rendering runs inside a Celery worker; the API only enqueues and hands back
    a short-lived download link.
    """

    def __init__(self, session: AsyncSession, tenant_id: str) -> None:
        self.tenant_id = tenant_id
        self.costs = CostService(session, tenant_id)
        self.resources = ResourceRepo(session, tenant_id)
        self.recommendations = RecommendationRepo(session, tenant_id)
        self.alerts = AlertRepo(session, tenant_id)
        self.security = SecurityService(session, tenant_id)

    async def build_payload(
        self, report_type: str, period: Period | None = None
    ) -> dict[str, Any]:
        period = period or last_n_days(30)
        if report_type == "cost_summary":
            return {
                "title": "Cost Summary",
                "period": f"{period.start} to {period.end}",
                "columns": ["Service", "Cost", "Currency"],
                "rows": [
                    [r.key, round(r.cost, 2), r.currency]
                    for r in await self.costs.breakdown("service", period, limit=50)
                ],
            }
        if report_type == "inventory":
            items, _ = await self.resources.list(limit=500), 0
            return {
                "title": "Resource Inventory",
                "period": str(date.today()),
                "columns": ["Name", "Type", "Resource Group", "Location", "Monthly Cost"],
                "rows": [
                    [
                        r.name,
                        r.resource_type,
                        r.resource_group,
                        r.location,
                        float(r.monthly_cost or 0),
                    ]
                    for r in items
                ],
            }
        if report_type == "optimization":
            findings = await self.recommendations.open_items(limit=500)
            return {
                "title": "Cost Optimization",
                "period": str(date.today()),
                "columns": ["Resource", "Finding", "Action", "Monthly Savings"],
                "rows": [
                    [
                        f.resource_name,
                        f.title,
                        f.recommended_action,
                        float(f.estimated_monthly_savings),
                    ]
                    for f in findings
                ],
            }
        if report_type == "security":
            summary = await self.security.summary()
            return {
                "title": "Security Posture",
                "period": str(date.today()),
                "columns": ["Metric", "Value"],
                "rows": [
                    ["Secure score %", summary.secure_score_pct],
                    ["Expiring secrets", summary.expiring_secrets],
                    ["Risky identities", summary.risky_identities],
                    ["Users without MFA", summary.users_without_mfa],
                    ["Open network exposures", summary.open_exposures],
                    *[
                        [f"Findings ({sev})", count]
                        for sev, count in summary.findings_by_severity.items()
                    ],
                ],
            }
        if report_type == "alerts":
            alerts = await self.alerts.active(limit=500)
            return {
                "title": "Active Alerts",
                "period": str(date.today()),
                "columns": ["Severity", "Title", "Resource", "Triggered"],
                "rows": [
                    [a.severity, a.title, a.azure_resource_id, a.triggered_at.isoformat()]
                    for a in alerts
                ],
            }
        if report_type == "cost_detail":
            page = await self.costs.usage_lines(period, limit=500)
            return {
                "title": "Detailed Cost (meter grain)",
                "period": f"{period.start} to {period.end}",
                "columns": [
                    "Date",
                    "Resource",
                    "Resource Group",
                    "Service",
                    "Meter Category",
                    "Meter Subcategory",
                    "Meter",
                    "Region",
                    "Quantity",
                    "Unit",
                    "Effective Price",
                    "Charge Type",
                    "Pricing Model",
                    "Cost",
                    "Currency",
                ],
                "rows": [
                    [
                        line.usage_date.isoformat(),
                        line.resource_name,
                        line.resource_group,
                        line.service_name,
                        line.meter_category,
                        line.meter_subcategory,
                        line.meter,
                        line.meter_region,
                        round(line.quantity, 6),
                        line.unit_of_measure,
                        round(line.effective_price, 6),
                        line.charge_type,
                        line.pricing_model,
                        round(line.cost, 4),
                        line.currency,
                    ]
                    for line in page.items
                ],
            }
        if report_type == "bandwidth":
            report = await self.costs.bandwidth(period)
            return {
                "title": "Data Transfer (ingress / egress)",
                "period": f"{report.period_start} to {report.period_end}",
                "columns": [
                    "Date",
                    "Ingress Bytes (free)",
                    "Egress Bytes",
                    "Billed GB",
                    "Billed Cost",
                ],
                "rows": [
                    [
                        point.date.isoformat(),
                        point.ingress_bytes,
                        point.egress_bytes,
                        round(point.billed_quantity_gb, 4),
                        round(point.billed_cost, 4),
                    ]
                    for point in report.daily
                ],
            }
        raise ValueError(f"Unsupported report type: {report_type}")

    # --- renderers ----------------------------------------------------
    @staticmethod
    def to_csv(payload: dict[str, Any]) -> bytes:
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(payload["columns"])
        writer.writerows(payload["rows"])
        return buffer.getvalue().encode("utf-8")

    @staticmethod
    def to_excel(payload: dict[str, Any]) -> bytes:
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = payload["title"][:31]
        sheet.append(payload["columns"])
        for row in payload["rows"]:
            sheet.append(row)
        for column_cells in sheet.columns:
            width = max((len(str(c.value or "")) for c in column_cells), default=10)
            sheet.column_dimensions[column_cells[0].column_letter].width = min(width + 2, 60)
        buffer = io.BytesIO()
        workbook.save(buffer)
        return buffer.getvalue()

    @staticmethod
    def to_pdf(payload: dict[str, Any]) -> bytes:
        buffer = io.BytesIO()
        doc = SimpleDocTemplate(buffer, pagesize=A4, title=payload["title"])
        styles = getSampleStyleSheet()
        table_data = [payload["columns"]] + [
            [str(cell)[:60] for cell in row] for row in payload["rows"][:500]
        ]
        table = Table(table_data, repeatRows=1)
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("FONTSIZE", (0, 0), (-1, -1), 8),
                    ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
                ]
            )
        )
        doc.build(
            [
                Paragraph(payload["title"], styles["Title"]),
                Paragraph(f"Period: {payload['period']}", styles["Normal"]),
                Spacer(1, 12),
                table,
            ]
        )
        return buffer.getvalue()

    def render(self, payload: dict[str, Any], export_format: str) -> bytes:
        renderers = {"csv": self.to_csv, "excel": self.to_excel, "pdf": self.to_pdf}
        if export_format not in renderers:
            raise ValueError(f"Unsupported export format: {export_format}")
        return renderers[export_format](payload)

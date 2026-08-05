"""Meter-level cost detail and network transfer volumes.

Adds the columns that Cost Management's default views roll up (meter identity,
billed quantity, unit of measure, pricing, charge type, reservation attribution)
plus a table for measured ingress/egress bytes, which are never billed for
inbound traffic and therefore absent from any cost dataset.

Revision ID: 0002_cost_detail
Revises: 0001_initial
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID

revision = "0002_cost_detail"
down_revision = "0001_initial"
branch_labels = None
depends_on = None

_STRING_COLUMNS = [
    ("resource_name", 255),
    ("resource_location", 64),
    ("meter_id", 128),
    ("meter_category", 128),
    ("meter_subcategory", 128),
    ("meter_region", 64),
    ("service_family", 128),
    ("product", 512),
    ("part_number", 64),
    ("unit_of_measure", 64),
    ("charge_type", 32),
    ("frequency", 32),
    ("pricing_model", 32),
    ("publisher_type", 32),
    ("benefit_name", 255),
    ("reservation_id", 255),
]

_NUMERIC_COLUMNS = [
    ("quantity", sa.Numeric(24, 8)),
    ("unit_price", sa.Numeric(18, 8)),
    ("effective_price", sa.Numeric(18, 8)),
]


def upgrade() -> None:
    # 0001 builds the schema from the live ORM metadata, so on a fresh database
    # everything below already exists. Only pre-existing databases need it.
    inspector = sa.inspect(op.get_bind())
    existing = {c["name"] for c in inspector.get_columns("cost_records")}
    if "meter_id" in existing:
        return

    for name, length in _STRING_COLUMNS:
        default = "Usage" if name == "charge_type" else ""
        op.add_column(
            "cost_records",
            sa.Column(
                name,
                sa.String(length=length),
                nullable=False,
                server_default=default,
            ),
        )
    for name, type_ in _NUMERIC_COLUMNS:
        op.add_column(
            "cost_records",
            sa.Column(name, type_, nullable=False, server_default="0"),
        )
    op.add_column(
        "cost_records",
        sa.Column(
            "additional_info", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
    )

    # Re-grain: a resource can carry many meters and charge types per day.
    op.drop_constraint("uq_cost_grain", "cost_records", type_="unique")
    op.create_unique_constraint(
        "uq_cost_grain",
        "cost_records",
        [
            "tenant_id",
            "subscription_id",
            "usage_date",
            "azure_resource_id",
            "meter_id",
            "meter",
            "charge_type",
        ],
    )
    op.create_index(
        "ix_cost_tenant_meter_cat",
        "cost_records",
        ["tenant_id", "meter_category", "usage_date"],
    )
    op.create_index(
        "ix_cost_tenant_resource",
        "cost_records",
        ["tenant_id", "azure_resource_id", "usage_date"],
    )

    op.create_table(
        "network_usage_records",
        sa.Column("id", PGUUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("azure_resource_id", sa.String(length=1024), nullable=False),
        sa.Column("subscription_id", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("resource_name", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("resource_type", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("resource_group", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("location", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("usage_date", sa.Date(), nullable=False),
        sa.Column("ingress_bytes", sa.Numeric(24, 2), nullable=False, server_default="0"),
        sa.Column("egress_bytes", sa.Numeric(24, 2), nullable=False, server_default="0"),
        sa.Column("source_metric", sa.String(length=64), nullable=False, server_default=""),
        sa.UniqueConstraint(
            "tenant_id", "azure_resource_id", "usage_date", name="uq_network_usage_grain"
        ),
    )
    op.create_index(
        "ix_netusage_tenant_date", "network_usage_records", ["tenant_id", "usage_date"]
    )
    op.create_index(
        "ix_network_usage_records_tenant_id", "network_usage_records", ["tenant_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_network_usage_records_tenant_id", table_name="network_usage_records")
    op.drop_index("ix_netusage_tenant_date", table_name="network_usage_records")
    op.drop_table("network_usage_records")

    op.drop_index("ix_cost_tenant_resource", table_name="cost_records")
    op.drop_index("ix_cost_tenant_meter_cat", table_name="cost_records")
    op.drop_constraint("uq_cost_grain", "cost_records", type_="unique")
    op.create_unique_constraint(
        "uq_cost_grain",
        "cost_records",
        ["tenant_id", "subscription_id", "usage_date", "azure_resource_id", "meter"],
    )

    op.drop_column("cost_records", "additional_info")
    for name, _ in _NUMERIC_COLUMNS:
        op.drop_column("cost_records", name)
    for name, _ in _STRING_COLUMNS:
        op.drop_column("cost_records", name)

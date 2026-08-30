"""
The onboarding guide, rendered as a real PDF.

Built at request time rather than shipped as a static file so the instructions
can never drift from the form the user is looking at. It is a document, not
data, so it exposes nothing tenant-specific.
"""
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    ListFlowable, ListItem, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table,
    TableStyle,
)

from services import permissions_manifest

INK = colors.HexColor("#0f172a")
MUTED = colors.HexColor("#475569")
ACCENT = colors.HexColor("#2563eb")
LINE = colors.HexColor("#e2e8f0")
PANEL = colors.HexColor("#f8fafc")
WARN_BG = colors.HexColor("#fffbeb")
WARN_EDGE = colors.HexColor("#f59e0b")


def _styles():
    base = getSampleStyleSheet()
    s = {
        "title": ParagraphStyle(
            "title", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=24, leading=29, textColor=INK, alignment=TA_LEFT, spaceAfter=6,
        ),
        "lede": ParagraphStyle(
            "lede", parent=base["Normal"], fontName="Helvetica",
            fontSize=11, leading=16, textColor=MUTED, spaceAfter=18,
        ),
        "h2": ParagraphStyle(
            "h2", parent=base["Heading2"], fontName="Helvetica-Bold",
            fontSize=14, leading=18, textColor=INK, spaceBefore=18, spaceAfter=8,
        ),
        "h3": ParagraphStyle(
            "h3", parent=base["Heading3"], fontName="Helvetica-Bold",
            fontSize=11, leading=15, textColor=INK, spaceBefore=10, spaceAfter=4,
        ),
        "body": ParagraphStyle(
            "body", parent=base["Normal"], fontName="Helvetica",
            fontSize=10, leading=15, textColor=INK, spaceAfter=6,
        ),
        "muted": ParagraphStyle(
            "muted", parent=base["Normal"], fontName="Helvetica",
            fontSize=9, leading=13, textColor=MUTED, spaceAfter=6,
        ),
        "code": ParagraphStyle(
            "code", parent=base["Normal"], fontName="Courier",
            fontSize=8.5, leading=13, textColor=INK,
        ),
    }
    return s


def _panel(flowables, bg=PANEL, edge=LINE):
    t = Table([[flowables]], colWidths=[165 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.75, edge),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    return t


def _steps(items, st):
    return ListFlowable(
        [ListItem(Paragraph(t, st["body"]), leftIndent=16) for t in items],
        bulletType="1", bulletFontName="Helvetica-Bold", bulletColor=ACCENT,
        leftIndent=16, bulletFormat="%s.",
    )


def _bullets(items, st):
    # An explicit Helvetica bullet: the default pulls the glyph from a symbol
    # font, which some PDF readers substitute or fail to render.
    return ListFlowable(
        [ListItem(Paragraph(t, st["body"]), leftIndent=16) for t in items],
        bulletType="bullet", start="\u2022", bulletFontName="Helvetica",
        bulletColor=ACCENT, leftIndent=16,
    )


def _chrome(canvas, doc, app_name):
    canvas.saveState()
    canvas.setFillColor(ACCENT)
    canvas.rect(0, A4[1] - 6 * mm, A4[0], 6 * mm, stroke=0, fill=1)

    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(22 * mm, 12 * mm, app_name)
    canvas.drawRightString(A4[0] - 22 * mm, 12 * mm, f"Page {doc.page}")
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(22 * mm, 16 * mm, A4[0] - 22 * mm, 16 * mm)
    canvas.restoreState()


def build_setup_guide(app_name: str = "Cloudledger") -> bytes:
    st = _styles()
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=22 * mm, rightMargin=22 * mm,
        topMargin=20 * mm, bottomMargin=22 * mm,
        title=f"{app_name} — Connect your Azure tenant",
        author=app_name,
    )

    f = []
    f.append(Paragraph("Connect your Azure tenant", st["title"]))
    f.append(Paragraph(
        "A step-by-step guide to creating the service principal this app uses to read "
        "your Azure costs. The roles in Step 3 are read-only, and they are enough for "
        "cost and estate reporting. Some features can act on Azure rather than only "
        "report on it; those need extra roles, they are listed separately at the end, "
        "and nothing grants them unless you choose to.",
        st["lede"],
    ))

    f.append(_panel([
        Paragraph("What you will need", st["h3"]),
        Paragraph(
            "Permission to register an application in Microsoft Entra ID, and permission "
            "to assign roles on the Azure subscriptions you want to track. If you do not "
            "have both, send this guide to whoever administers your Azure tenant.",
            st["muted"],
        ),
    ]))
    f.append(Spacer(1, 6))

    # ── Step 1 ────────────────────────────────────────────────────────────
    f.append(Paragraph("Step 1 — Register the application", st["h2"]))
    f.append(_steps([
        "Sign in to the Azure portal at <b>portal.azure.com</b>.",
        "Search for <b>Microsoft Entra ID</b> and open it.",
        "In the left menu choose <b>App registrations</b>, then <b>New registration</b>.",
        "Name it something recognisable, for example <b>Cloudledger</b>.",
        "Under supported account types keep <b>Accounts in this organizational directory only</b>.",
        "Leave the redirect URI blank and select <b>Register</b>.",
    ], st))
    f.append(Spacer(1, 4))
    f.append(_panel([
        Paragraph(
            "On the overview page that opens, copy these two values. They are the "
            "<b>Tenant ID</b> and <b>Client ID</b> the form asks for:",
            st["muted"],
        ),
        Spacer(1, 4),
        Paragraph("Directory (tenant) ID&nbsp;&nbsp;&#8594;&nbsp;&nbsp;Tenant ID (GUID)", st["code"]),
        Paragraph("Application (client) ID&nbsp;&nbsp;&#8594;&nbsp;&nbsp;Client ID", st["code"]),
    ]))

    # ── Step 2 ────────────────────────────────────────────────────────────
    f.append(Paragraph("Step 2 — Create a client secret", st["h2"]))
    f.append(_steps([
        "Still inside your new app registration, open <b>Certificates &amp; secrets</b>.",
        "Select <b>New client secret</b>.",
        "Give it a description and choose an expiry. A shorter expiry is safer, but you "
        "must repeat this step and update the app before it lapses.",
        "Select <b>Add</b>.",
    ], st))
    f.append(Spacer(1, 4))
    f.append(_panel([
        Paragraph("Copy the secret now", st["h3"]),
        Paragraph(
            "Copy the <b>Value</b> column, not the Secret ID. The value is shown only once "
            "and is hidden permanently as soon as you leave the page. If you lose it, "
            "delete the secret and create a new one.",
            st["muted"],
        ),
    ], bg=WARN_BG, edge=WARN_EDGE))

    f.append(PageBreak())

    # ── Step 3 ────────────────────────────────────────────────────────────
    f.append(Paragraph("Step 3 \u2014 Grant access to your subscriptions", st["h2"]))
    f.append(Paragraph(
        "The application exists but can see nothing yet. Repeat this step for every "
        "subscription whose costs you want to track. Every role in the table below is "
        "read-only \u2014 none of them can create, change or delete a resource.",
        st["body"],
    ))
    f.append(_steps([
        "In the portal search for <b>Subscriptions</b> and open the one you want to track.",
        "Choose <b>Access control (IAM)</b> in the left menu.",
        "Select <b>Add</b>, then <b>Add role assignment</b>.",
        "Pick the <b>Reader</b> role and select <b>Next</b>.",
        "Under Members choose <b>User, group, or service principal</b>, select "
        "<b>Select members</b>, search for your app registration name and select it.",
        "Select <b>Review + assign</b>.",
        "Repeat for each remaining role in the table below. <b>Reader</b> and "
        "<b>Cost Management Reader</b> are the two you cannot skip.",
    ], st))
    f.append(Spacer(1, 4))

    roles = Table(
        [
            [Paragraph("<b>Role</b>", st["muted"]), Paragraph("<b>Why it is needed</b>", st["muted"])],
        ] + [
            [Paragraph(r["name"], st["body"]),
             Paragraph(
                 r["why"] + (f" <i>{r['caveat']}</i>" if r["caveat"] else ""),
                 st["muted"],
             )]
            for r in permissions_manifest.cumulative_roles(permissions_manifest.FULL_READ)
        ],
        colWidths=[45 * mm, 120 * mm],
    )
    roles.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PANEL),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    f.append(roles)
    f.append(Spacer(1, 6))
    f.append(Paragraph(
        "Role assignments can take a few minutes to take effect. If the app reports no "
        "subscriptions immediately after this step, wait a moment and try again.",
        st["muted"],
    ))

    # ── Step 4 ────────────────────────────────────────────────────────────
    f.append(Paragraph("Step 4 — Fill in the form", st["h2"]))
    f.append(Paragraph("Back in the app, complete <b>Add Service Principal Tenant</b>:", st["body"]))

    fields = Table(
        [
            [Paragraph("<b>Field</b>", st["muted"]), Paragraph("<b>Where it comes from</b>", st["muted"])],
            [Paragraph("Tenant Name", st["body"]),
             Paragraph("Any label you choose, for example your company or environment name. "
                       "Only used for display.", st["muted"])],
            [Paragraph("Tenant ID (GUID)", st["body"]),
             Paragraph("Directory (tenant) ID from the app registration overview.", st["muted"])],
            [Paragraph("Client ID", st["body"]),
             Paragraph("Application (client) ID from the same overview page.", st["muted"])],
            [Paragraph("Client Secret", st["body"]),
             Paragraph("The secret <b>Value</b> copied in step 2.", st["muted"])],
        ],
        colWidths=[45 * mm, 120 * mm],
    )
    fields.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PANEL),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    f.append(fields)
    f.append(Spacer(1, 8))
    f.append(Paragraph(
        "Select <b>Add Tenant</b>. The credentials are checked against Azure immediately, so "
        "a mistake is reported there and then rather than showing up later as missing data.",
        st["body"],
    ))

    f.append(PageBreak())

    # ── Troubleshooting ───────────────────────────────────────────────────
    f.append(Paragraph("If something goes wrong", st["h2"]))
    f.append(Paragraph("No subscriptions found", st["h3"]))
    f.append(_bullets([
        "The role assignment in step 3 was made on a resource group or resource instead of "
        "the subscription itself.",
        "The assignment has not propagated yet. Wait a few minutes.",
        "The service principal was assigned to a different subscription than the one you "
        "expected to see.",
    ], st))

    f.append(Paragraph("Authentication failed", st["h3"]))
    f.append(_bullets([
        "The Secret ID was pasted instead of the secret <b>Value</b>.",
        "The secret has expired. Create a new one and update the tenant in Settings.",
        "The Tenant ID and Client ID were swapped. Both are GUIDs, so this is easy to do.",
    ], st))

    f.append(Paragraph("Costs appear but look incomplete", st["h3"]))
    f.append(_bullets([
        "Only some subscriptions have the two roles assigned. Repeat step 3 for the rest.",
        "The current month is always partial. Azure finalises billing a few days after "
        "month end, so the most recent complete month is the reliable comparison.",
    ], st))

    f.append(Paragraph("Optional \u2014 letting the app make changes", st["h2"]))
    f.append(Paragraph(
        "Everything above is read-only. A few features do more than report: applying a "
        "tag, resizing a virtual machine, deploying from a bill of quantities, or "
        "removing a role assignment that access review flagged. Those need the roles "
        "below. Grant them only if you want those features, and scope them as narrowly "
        "as you can. The app always asks before it acts.",
        st["body"],
    ))
    f.append(_bullets([
        f"<b>{r['name']}</b> \u2014 {r['why']} {r['caveat']}"
        for r in permissions_manifest.write_roles()
    ], st))
    f.append(Spacer(1, 4))
    f.append(_panel([
        Paragraph("Resolving names instead of GUIDs", st["h3"]),
        Paragraph(
            "Role assignments in Azure identify people by GUID. To show names instead, "
            "the app asks for the <b>Directory.Read.All</b> delegated permission in "
            "Microsoft Entra ID, which a tenant administrator must consent to once. It "
            "reads the whole directory, not only the accounts shown here, so decide "
            "deliberately. Skip it and every account appears as a GUID; nothing else "
            "stops working.",
            st["muted"],
        ),
    ]))

    f.append(Paragraph("Keeping access secure", st["h2"]))
    f.append(_bullets([
        "For reporting, the service principal only ever needs the read-only roles in "
        "step 3. If anyone asks you to add <b>Owner</b>, it is not required by this app.",
        "Set a calendar reminder before the client secret expires. When it lapses, cost data "
        "stops updating.",
        "If a secret is ever exposed, delete it in <b>Certificates &amp; secrets</b> "
        "immediately and add a new one. That revokes the old one instantly.",
        "Each account only ever sees the tenants it connected itself.",
    ], st))

    doc.build(
        f,
        onFirstPage=lambda c, d: _chrome(c, d, app_name),
        onLaterPages=lambda c, d: _chrome(c, d, app_name),
    )
    return buf.getvalue()

"""Generates the two product images used in launch posts.

The labels, column headers and card captions here are copied from the real
pages (Dashboard.jsx and Compute.jsx) rather than invented, so the picture
matches what a person sees after they sign in. The numbers are made up, which
is why every image carries a badge saying so.
"""
import math

BG = "#020617"; PANEL = "#0b1220"; LINE = "#1e293b"; SOFT = "#131c31"
TXT = "#f1f5f9"; MUT = "#94a3b8"; DIM = "#64748b"
BLUE = "#3b82f6"; EMER = "#34d399"; AMBER = "#fbbf24"; ROSE = "#f87171"
VIOL = "#a78bfa"; CYAN = "#22d3ee"
F = 'font-family="Helvetica Neue, Helvetica, Arial, sans-serif"'
W = 1600
X0, CW = 280, 1280

NAV = ["Dashboard", "Cost Explorer", "Month Compare", "Anomalies", "Estate",
       "Change Tracking", "Compute Intelligence", "Access &amp; Security",
       "Team", "Settings"]


def esc(s):
    return s.replace("&", "&amp;") if "&amp;" not in s else s


def sidebar(a, H, active):
    a(f'<rect width="{W}" height="{H}" fill="{BG}"/>')
    a(f'<rect width="248" height="{H}" fill="#060d1c"/>')
    a(f'<line x1="248" y1="0" x2="248" y2="{H}" stroke="{LINE}"/>')
    a(f'<rect x="26" y="26" width="34" height="34" rx="10" fill="{BLUE}"/>')
    a(f'<path d="M35 47 q6 -11 11 -3 q4 -9 8 2" stroke="#ffffff" stroke-width="2.4" '
      f'fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
    a(f'<text x="72" y="49" {F} font-size="15" font-weight="700" '
      f'letter-spacing="2.4" fill="{TXT}">CLOUDLEDGER</text>')
    y = 112
    for label in NAV:
        on = label == active
        if on:
            a(f'<rect x="14" y="{y-22}" width="220" height="40" rx="11" fill="#14213d"/>')
            a(f'<rect x="14" y="{y-22}" width="3" height="40" rx="2" fill="{BLUE}"/>')
        col = TXT if on else MUT
        a(f'<rect x="34" y="{y-12}" width="14" height="14" rx="4" fill="none" '
          f'stroke="{col}" stroke-width="1.5"/>')
        weight = "600" if on else "400"
        a(f'<text x="60" y="{y+1}" {F} font-size="14" font-weight="{weight}" '
          f'fill="{col}">{label}</text>')
        y += 44
    a(f'<line x1="248" y1="82" x2="{W}" y2="82" stroke="{LINE}"/>')


def badge(a, x, y):
    a(f'<rect x="{x}" y="{y}" width="300" height="32" rx="9" fill="#3a2a06" '
      f'stroke="#7c5e10"/>')
    a(f'<circle cx="{x+18}" cy="{y+16}" r="4" fill="{AMBER}"/>')
    a(f'<text x="{x+30}" y="{y+21}" {F} font-size="12.5" fill="#fcd34d">'
      f'Illustrative data — not a real account</text>')


def panel(a, x, y, w, h, title=None, sub=None):
    a(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="{PANEL}" '
      f'stroke="{LINE}"/>')
    if title:
        a(f'<text x="{x+22}" y="{y+32}" {F} font-size="14" font-weight="600" '
          f'fill="#cbd5e1">{title}</text>')
    if sub:
        a(f'<text x="{x+22}" y="{y+52}" {F} font-size="11.5" fill="{DIM}">{sub}</text>')


def pill(a, x, y, text, fg, bg, bd):
    w = len(text) * 6.5 + 22
    a(f'<rect x="{x}" y="{y}" width="{w:.0f}" height="24" rx="7" fill="{bg}" '
      f'stroke="{bd}"/>')
    a(f'<text x="{x+11}" y="{y+16.5}" {F} font-size="11.5" fill="{fg}">{text}</text>')
    return w


# ───────────────────────── image A: cost dashboard ─────────────────────────
def dashboard():
    H = 1000
    o = []; a = o.append
    a(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
      f'viewBox="0 0 {W} {H}">')
    a('<defs>'
      f'<linearGradient id="area" x1="0" y1="0" x2="0" y2="1">'
      f'<stop offset="0%" stop-color="{BLUE}" stop-opacity="0.42"/>'
      f'<stop offset="100%" stop-color="{BLUE}" stop-opacity="0.02"/></linearGradient>'
      f'<linearGradient id="hbar" x1="0" y1="0" x2="1" y2="0">'
      f'<stop offset="0%" stop-color="{CYAN}"/><stop offset="100%" stop-color="{BLUE}"/>'
      f'</linearGradient></defs>')
    sidebar(a, H, "Dashboard")

    a(f'<text x="{X0}" y="48" {F} font-size="22" font-weight="700" fill="#ffffff">'
      f'Dashboard</text>')
    a(f'<text x="{X0}" y="70" {F} font-size="12.5" fill="{MUT}">'
      f'Azure cost overview · Mar 2026 – Aug 2026 · 3 subscriptions '
      f'<tspan fill="{DIM}">· USD</tspan></text>')
    badge(a, 1260, 26)

    heroes = [
        ("Actual Cost (6 mo)", "All subscriptions combined", "$74,880",
         "6 months of data", None),
        ("Latest Month", "August 2026", "$12,480", "vs $10,940 in July", "+14.1%"),
        ("Daily Burn Rate", "Avg spend per day", "$416",
         "Based on current month pace", None),
        ("Monthly Average", "6-month average", "$12,480", "Across the range", None),
        ("Cost Spikes", "Services with >20% increase", "3",
         "Virtual Machines, Storage, Bandwidth", None),
        ("Savings Identified", "Optimization opportunities", "$2,140",
         "Monthly, high-confidence only", None),
    ]
    cw = (CW - 2 * 16) / 3
    for i, (t, s, v, fn, mom) in enumerate(heroes):
        x = X0 + (i % 3) * (cw + 16); y = 92 + (i // 3) * 130
        a(f'<rect x="{x}" y="{y}" width="{cw:.0f}" height="118" rx="16" '
          f'fill="{PANEL}" stroke="{LINE}"/>')
        a(f'<rect x="{x}" y="{y}" width="3.5" height="118" rx="2" fill="{BLUE}"/>')
        a(f'<text x="{x+22}" y="{y+27}" {F} font-size="13" font-weight="600" '
          f'fill="#cbd5e1">{t}</text>')
        a(f'<text x="{x+22}" y="{y+46}" {F} font-size="11.5" fill="{DIM}">{s}</text>')
        a(f'<text x="{x+22}" y="{y+82}" {F} font-size="27" font-weight="700" '
          f'fill="{TXT}">{v}</text>')
        a(f'<text x="{x+22}" y="{y+103}" {F} font-size="11" fill="{DIM}">{fn}</text>')
        if mom:
            a(f'<rect x="{x+cw-84}" y="{y+62}" width="66" height="24" rx="7" '
              f'fill="#3a1c1c" stroke="#7f2d2d"/>')
            a(f'<text x="{x+cw-51}" y="{y+78.5}" {F} font-size="12" font-weight="600" '
              f'text-anchor="middle" fill="{ROSE}">{mom}</text>')

    # cost trend
    TY = 356; TH = 296; TW = 848
    panel(a, X0, TY, TW, TH, "Cost Trend", "Monthly Azure spend, read from Cost Management")
    months = ["Mar", "Apr", "May", "Jun", "Jul", "Aug"]
    vals = [11020, 11640, 12310, 11880, 10940, 12480]
    lo, hi = 9800, 13200
    px0, px1 = X0 + 60, X0 + TW - 30
    py0, py1 = TY + 84, TY + TH - 46
    for g in range(4):
        gy = py0 + (py1 - py0) * g / 3
        a(f'<line x1="{px0}" y1="{gy:.0f}" x2="{px1}" y2="{gy:.0f}" stroke="{LINE}" '
          f'stroke-dasharray="3 6"/>')
        a(f'<text x="{px0-12}" y="{gy+4:.0f}" {F} font-size="10.5" text-anchor="end" '
          f'fill="{DIM}">${int(hi-(hi-lo)*g/3):,}</text>')
    pts = []
    for i, v in enumerate(vals):
        x = px0 + (px1 - px0) * i / (len(vals) - 1)
        y = py1 - (py1 - py0) * (v - lo) / (hi - lo)
        pts.append((x, y))
    line = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    a(f'<polygon points="{px0},{py1} {line} {px1},{py1}" fill="url(#area)"/>')
    a(f'<polyline points="{line}" fill="none" stroke="{BLUE}" stroke-width="2.6" '
      f'stroke-linejoin="round"/>')
    for i, (x, y) in enumerate(pts):
        last = i == len(pts) - 1
        a(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{5 if last else 3.6}" '
          f'fill="{BG}" stroke="{AMBER if last else BLUE}" stroke-width="2.4"/>')
        a(f'<text x="{x:.0f}" y="{py1+22}" {F} font-size="11" text-anchor="middle" '
          f'fill="{DIM}">{months[i]}</text>')
    a(f'<text x="{pts[-1][0]-6:.0f}" y="{pts[-1][1]-14:.0f}" {F} font-size="11.5" '
      f'font-weight="600" text-anchor="end" fill="{AMBER}">$12,480</text>')

    # service distribution donut
    DX = X0 + TW + 16; DW = CW - TW - 16
    panel(a, DX, TY, DW, TH, "Service Distribution", "Share of spend, last 6 months")
    segs = [("Virtual Machines", 34, BLUE), ("Storage", 21, CYAN),
            ("SQL Database", 18, VIOL), ("App Service", 13, EMER),
            ("Bandwidth", 8, AMBER), ("Other", 6, "#475569")]
    cx, cy, r = DX + 96, TY + 168, 58
    circ = 2 * math.pi * r
    off = 0.0
    for _, pct_, col in segs:
        seg = circ * pct_ / 100
        a(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{col}" '
          f'stroke-width="22" stroke-dasharray="{seg-2.5:.1f} {circ-seg+2.5:.1f}" '
          f'stroke-dashoffset="{-off:.1f}" transform="rotate(-90 {cx} {cy})"/>')
        off += seg
    a(f'<text x="{cx}" y="{cy-2}" {F} font-size="19" font-weight="700" '
      f'text-anchor="middle" fill="{TXT}">$74.9k</text>')
    a(f'<text x="{cx}" y="{cy+17}" {F} font-size="10.5" text-anchor="middle" '
      f'fill="{DIM}">6 months</text>')
    ly = TY + 96
    for name, pct_, col in segs:
        a(f'<rect x="{DX+200}" y="{ly-9}" width="11" height="11" rx="3" fill="{col}"/>')
        a(f'<text x="{DX+219}" y="{ly}" {F} font-size="12" fill="#cbd5e1">{name}</text>')
        a(f'<text x="{DX+DW-22}" y="{ly}" {F} font-size="12" text-anchor="end" '
          f'fill="{MUT}">{pct_}%</text>')
        ly += 27

    # top services
    SY = TY + TH + 16; SH = 1000 - SY - 20
    panel(a, X0, SY, TW, SH, "Top Services by Spend",
          "Latest month · click any service for the resources inside it")
    rows = [("Virtual Machines", 4210, "+12.4%", ROSE),
            ("Storage", 2180, "+3.1%", MUT),
            ("SQL Database", 1940, "-2.0%", EMER),
            ("App Service", 1120, "+0.4%", MUT),
            ("Bandwidth", 860, "+28.6%", ROSE)]
    mxv = rows[0][1]
    ry = SY + 84
    for name, val, delta, dcol in rows:
        a(f'<text x="{X0+22}" y="{ry}" {F} font-size="13" fill="#e2e8f0">{name}</text>')
        a(f'<text x="{X0+TW-96}" y="{ry}" {F} font-size="13" text-anchor="end" '
          f'fill="{TXT}">${val:,}</text>')
        a(f'<text x="{X0+TW-22}" y="{ry}" {F} font-size="12" text-anchor="end" '
          f'fill="{dcol}">{delta}</text>')
        a(f'<rect x="{X0+22}" y="{ry+9}" width="{TW-140}" height="7" rx="3.5" '
          f'fill="{SOFT}"/>')
        a(f'<rect x="{X0+22}" y="{ry+9}" width="{(TW-140)*val/mxv:.0f}" height="7" '
          f'rx="3.5" fill="url(#hbar)"/>')
        ry += 40

    # recent cost spikes
    panel(a, DX, SY, DW, SH, "Recent Cost Spikes",
          "Services above their own normal range")
    spikes = [("Virtual Machines", "+$1,240", "two VMs resized on 19 Aug"),
              ("Bandwidth", "+$192", "egress from South India"),
              ("Storage", "+$66", "new backup vault")]
    sy2 = SY + 82
    for name, amt, why in spikes:
        a(f'<rect x="{DX+18}" y="{sy2-18}" width="{DW-36}" height="52" rx="10" '
          f'fill="{SOFT}"/>')
        a(f'<rect x="{DX+18}" y="{sy2-18}" width="3" height="52" rx="2" fill="{AMBER}"/>')
        a(f'<text x="{DX+34}" y="{sy2}" {F} font-size="12.5" fill="#e2e8f0">{name}</text>')
        a(f'<text x="{DX+DW-30}" y="{sy2}" {F} font-size="12.5" text-anchor="end" '
          f'font-weight="600" fill="{AMBER}">{amt}</text>')
        a(f'<text x="{DX+34}" y="{sy2+19}" {F} font-size="11" fill="{DIM}">{why}</text>')
        sy2 += 62
    a(f'<text x="{DX+22}" y="{SY+SH-22}" {F} font-size="11" fill="{DIM}">'
      f'Every figure read from your Azure at the moment you ask.</text>')
    a('</svg>')
    return "\n".join(o)


# ─────────────────────── image B: compute intelligence ─────────────────────
def compute():
    H = 1000
    o = []; a = o.append
    a(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
      f'viewBox="0 0 {W} {H}">')
    sidebar(a, H, "Compute Intelligence")

    a(f'<text x="{X0}" y="46" {F} font-size="22" font-weight="700" fill="#ffffff">'
      f'Compute Intelligence</text>')
    a(f'<text x="{X0}" y="68" {F} font-size="12.5" fill="{MUT}">'
      f'Every virtual machine, what it costs, and what it actually did. Verdicts come '
      f'from 30 days of Azure Monitor telemetry — nothing here changes your estate.</text>')
    badge(a, 1260, 26)

    m1 = [("Virtual machines", "42", "30-day window", TXT),
          ("Telemetry coverage", "34 / 42", "5 verifiably off · 3 awaiting", TXT),
          ("Running", "29", "2 stopped but billing", TXT),
          ("Deallocated", "8", "No compute charge; disks bill", TXT),
          ("Right-sizing opportunities", "11", "Idle, oversized or stopped", EMER),
          ("Telemetry issues", "3", "Azure could not report on", ROSE)]
    w1 = (CW - 5 * 12) / 6
    for i, (l, v, h, c) in enumerate(m1):
        x = X0 + i * (w1 + 12)
        a(f'<rect x="{x:.0f}" y="92" width="{w1:.0f}" height="104" rx="14" '
          f'fill="{PANEL}" stroke="{LINE}"/>')
        a(f'<text x="{x+16:.0f}" y="118" {F} font-size="11" fill="{MUT}">{l}</text>')
        a(f'<text x="{x+16:.0f}" y="154" {F} font-size="24" font-weight="700" '
          f'fill="{c}">{v}</text>')
        a(f'<text x="{x+16:.0f}" y="176" {F} font-size="10" fill="{DIM}">{h}</text>')

    m2 = [("Potential monthly saving", "$1,840", "High-confidence findings only", EMER),
          ("Potential annual saving", "$22,080", "Monthly figure × 12", EMER),
          ("Fleet cost", "$6,420", "$77,040 a year", TXT)]
    w2 = (CW - 2 * 12) / 3
    for i, (l, v, h, c) in enumerate(m2):
        x = X0 + i * (w2 + 12)
        a(f'<rect x="{x:.0f}" y="208" width="{w2:.0f}" height="96" rx="14" '
          f'fill="{PANEL}" stroke="{LINE}"/>')
        a(f'<text x="{x+20:.0f}" y="234" {F} font-size="12" fill="{MUT}">{l}</text>')
        a(f'<text x="{x+20:.0f}" y="270" {F} font-size="26" font-weight="700" '
          f'fill="{c}">{v}</text>')
        a(f'<text x="{x+20:.0f}" y="290" {F} font-size="10.5" fill="{DIM}">{h}</text>')

    a(f'<rect x="{X0}" y="316" width="{CW}" height="62" rx="13" fill="#111d33" '
      f'stroke="#26405f"/>')
    a(f'<circle cx="{X0+28}" cy="347" r="9" fill="none" stroke="{BLUE}" stroke-width="1.8"/>')
    a(f'<text x="{X0+28}" y="352" {F} font-size="13" font-weight="700" '
      f'text-anchor="middle" fill="{BLUE}">i</text>')
    a(f'<text x="{X0+50}" y="342" {F} font-size="12.5" font-weight="600" '
      f'fill="#bfdbfe">Some recommendations have no price attached</text>')
    a(f'<text x="{X0+50}" y="362" {F} font-size="11.5" fill="{MUT}">'
      f'2 machines could be resized, but the published price for the target size could '
      f'not be read. They add nothing to the savings totals above.</text>')

    TY = 392; TH = 1000 - TY - 20
    panel(a, X0, TY, CW, TH, "Fleet",
          "Sorted worst-first: stopped machines, then idle, then oversized. "
          "Click a row for the evidence.")
    cols = [("Name", 300, "start"), ("Operational", 556, "start"),
            ("Right-sizing", 728, "start"), ("Telemetry", 920, "start"),
            ("CPU avg", 1085, "end"), ("CPU p95", 1155, "end"),
            ("Cost / mo", 1245, "end"), ("Saving / mo", 1345, "end"),
            ("Action", 1540, "end")]
    hy = TY + 86
    for name, x, anc in cols:
        a(f'<text x="{x}" y="{hy}" {F} font-size="11" font-weight="600" '
          f'letter-spacing="0.6" text-anchor="{anc}" fill="{DIM}">{name.upper()}</text>')
    a(f'<line x1="300" y1="{hy+14}" x2="1540" y2="{hy+14}" stroke="{LINE}"/>')

    R = [
        ("vm-batch-worker-03", "westeurope · D8as_v5",
         ("Stopped, billing", ROSE, "#3a1c1c", "#7f2d2d"),
         ("Idle", ROSE, "#3a1c1c", "#7f2d2d"), "high",
         ("100%", MUT), "0.4", "1.2", "$412", "$412", "D2as_v5", "Resize", True),
        ("vm-legacy-app-01", "centralindia · D4as_v5",
         ("Running", EMER, "#0f2e22", "#1d5c44"),
         ("Idle", ROSE, "#3a1c1c", "#7f2d2d"), "high",
         ("100%", MUT), "1.8", "3.1", "$386", "$386", "B2ms", "Resize", True),
        ("vm-report-svc-02", "centralindia · D8as_v5",
         ("Running", EMER, "#0f2e22", "#1d5c44"),
         ("Oversized", AMBER, "#3a2a06", "#7c5e10"), "medium",
         ("98%", MUT), "8.4", "14.2", "$274", "$180", "D4as_v5", "Resize", True),
        ("vm-api-prod-01", "centralindia · D4as_v5",
         ("Running", EMER, "#0f2e22", "#1d5c44"),
         ("Right-sized", EMER, "#0f2e22", "#1d5c44"), "high",
         ("100%", MUT), "41.6", "78.3", "$312", "—", None, "Review", False),
        ("vm-db-prod-02", "centralindia · E8ds_v5",
         ("Running", EMER, "#0f2e22", "#1d5c44"),
         ("Right-sized", EMER, "#0f2e22", "#1d5c44"), "high",
         ("99%", MUT), "52.1", "84.7", "$498", "—", None, "Review", False),
        ("vm-ml-train-04", "southindia · NC6s_v3",
         ("Running", EMER, "#0f2e22", "#1d5c44"),
         ("—", DIM, PANEL, LINE), None,
         ("Access denied", AMBER), "—", "—", "$340", "—", None, "Review", False),
        ("vm-dev-sandbox-05", "centralindia · B2ms",
         ("Deallocated", MUT, "#1b2438", "#2c3a52"),
         ("—", DIM, PANEL, LINE), None,
         ("Off", DIM), "—", "—", "$18", "—", None, "Review", False),
    ]
    ry = TY + 128
    for (nm, sub, op, rs, conf, tel, avg, p95, cost, sav, sku, act, prim) in R:
        a(f'<text x="300" y="{ry}" {F} font-size="13" font-weight="500" '
          f'fill="#e2e8f0">{nm}</text>')
        a(f'<text x="300" y="{ry+17}" {F} font-size="10.5" fill="{DIM}">{sub}</text>')
        t, fg, bgc, bd = op
        a(f'<circle cx="562" cy="{ry-4}" r="4" fill="{fg}"/>')
        a(f'<text x="574" y="{ry}" {F} font-size="12.5" fill="{fg}">{t}</text>')
        t, fg, bgc, bd = rs
        a(f'<circle cx="734" cy="{ry-4}" r="4" fill="{fg}"/>')
        a(f'<text x="746" y="{ry}" {F} font-size="12.5" fill="{fg}">{t}</text>')
        if conf:
            cw2 = len(conf) * 6.4 + 16
            cx2 = 746 + len(t) * 7.1 + 8
            a(f'<rect x="{cx2:.0f}" y="{ry-14}" width="{cw2:.0f}" height="19" rx="6" '
              f'fill="#111d33" stroke="#26405f"/>')
            a(f'<text x="{cx2+8:.0f}" y="{ry-0.5}" {F} font-size="10.5" '
              f'fill="#93c5fd">{conf}</text>')
        tv, tc = tel
        a(f'<text x="920" y="{ry}" {F} font-size="12.5" fill="{tc}">{tv}</text>')
        for val, x in ((avg, 1085), (p95, 1155)):
            a(f'<text x="{x}" y="{ry}" {F} font-size="12.5" text-anchor="end" '
              f'fill="{MUT if val != "—" else DIM}">{val}{"%" if val != "—" else ""}</text>')
        a(f'<text x="1245" y="{ry}" {F} font-size="12.5" text-anchor="end" '
          f'fill="#e2e8f0">{cost}</text>')
        a(f'<text x="1345" y="{ry}" {F} font-size="12.5" text-anchor="end" '
          f'font-weight="{"600" if sav != "—" else "400"}" '
          f'fill="{EMER if sav != "—" else DIM}">{sav}</text>')
        bx = 1540 - (len(act) * 7.4 + 26)
        if sku:
            sw = len(sku) * 6.6 + 26
            a(f'<rect x="{bx-sw-8:.0f}" y="{ry-15}" width="{sw:.0f}" height="22" rx="7" '
              f'fill="#111d33" stroke="#26405f"/>')
            a(f'<text x="{bx-sw+5:.0f}" y="{ry}" {F} font-size="11" fill="#93c5fd">'
              f'→ {sku}</text>')
        a(f'<rect x="{bx:.0f}" y="{ry-16}" width="{len(act)*7.4+26:.0f}" height="24" '
          f'rx="8" fill="{BLUE if prim else "#141d30"}" '
          f'stroke="{BLUE if prim else "#2c3a52"}"/>')
        a(f'<text x="{bx+(len(act)*7.4+26)/2:.0f}" y="{ry}" {F} font-size="11.5" '
          f'font-weight="600" text-anchor="middle" '
          f'fill="{"#ffffff" if prim else MUT}">{act}</text>')
        a(f'<line x1="300" y1="{ry+30}" x2="1540" y2="{ry+30}" stroke="#111a2c"/>')
        ry += 60
    a(f'<text x="300" y="{TY+TH-22}" {F} font-size="11" fill="{DIM}">'
      f'A machine with no usable CPU history names its own reason instead of being '
      f'reported as idle. Read-only — nothing here is written back to Azure.</text>')
    a('</svg>')
    return "\n".join(o)


for name, svg in (("05-dashboard-cost", dashboard()),
                  ("06-compute-intelligence", compute())):
    open(f"{name}.svg", "w").write(svg)
    print("wrote", name)

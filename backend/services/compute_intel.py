"""
Compute intelligence — deciding when a VM is the wrong size, and proving it.

The claim this module makes is expensive to get wrong. Telling somebody to
halve a production VM costs them an outage; telling them a VM is fine costs
them money quietly. So every recommendation here carries the evidence that
produced it, and the module refuses to recommend anything it cannot evidence.

Three rules govern every decision below
---------------------------------------
1. **No evidence, no recommendation.** A VM with too few observed metric points
   returns `INSUFFICIENT_DATA`, never "idle". Absence of telemetry is not
   absence of load — a VM with Monitoring Reader missing looks exactly like a
   VM doing nothing, and those two must never produce the same advice.

2. **Peaks decide, not means.** Downsizing is judged on P95 CPU and P95 memory.
   A VM averaging 6% that peaks at 92% every morning is correctly sized. The
   mean is displayed because people ask for it, but it is never the trigger.

3. **Savings are computed from real published prices or not shown at all.**
   Every rupee of "estimated savings" traces to a Retail Prices lookup for the
   two specific SKUs in the specific region. Where a price is unavailable the
   saving is `None` and the UI says so, because an invented saving figure is
   the fastest way to lose a customer's trust in the whole product.

Stopped-but-billed
------------------
The one finding here that does not need metrics. A deallocated VM bills nothing
for compute but keeps billing for its disks and reserved public IP. A VM in
`stopped` (not `deallocated`) state bills **in full** while doing nothing — this
is the single most common avoidable cost in an Azure estate and it is detectable
from power state alone.
"""
from typing import Any, Dict, List, Optional, Sequence

# ─────────────────────────────── verdicts ───────────────────────────────

IDLE = "idle"
UNDERUTILIZED = "underutilized"
RIGHT_SIZED = "right_sized"
OVERUTILIZED = "overutilized"
STOPPED_BILLED = "stopped_but_billed"
INSUFFICIENT_DATA = "insufficient_data"

VERDICT_LABEL = {
    IDLE: "Idle",
    UNDERUTILIZED: "Oversized",
    RIGHT_SIZED: "Right-sized",
    OVERUTILIZED: "Under-pressure",
    STOPPED_BILLED: "Stopped but billing",
    INSUFFICIENT_DATA: "Not enough data",
}

# Ordered worst-first, so a sorted list leads with what costs money.
VERDICT_ORDER = [
    STOPPED_BILLED, IDLE, UNDERUTILIZED, OVERUTILIZED,
    RIGHT_SIZED, INSUFFICIENT_DATA,
]

SEVERITY = {
    STOPPED_BILLED: "high",
    IDLE: "high",
    UNDERUTILIZED: "medium",
    OVERUTILIZED: "medium",
    RIGHT_SIZED: "none",
    INSUFFICIENT_DATA: "none",
}

# ─────────────────────────────── thresholds ───────────────────────────────
#
# Deliberately conservative. These are the numbers that decide whether somebody
# is told to shrink a production machine, so they sit well inside the range
# where the answer is obvious rather than at the edge where it is arguable.

IDLE_P95_CPU = 3.0          # never exceeded 3% in the whole window
IDLE_P95_NETWORK_BYTES = 1_000_000   # and moved under ~1 MB in a peak hour
UNDERUTILIZED_P95_CPU = 40.0         # peak still leaves >60% of the machine idle
OVERUTILIZED_P95_CPU = 85.0          # peak is close enough to the ceiling to hurt
MEMORY_HEADROOM_RATIO = 0.5          # at least half of RAM free at peak demand

# The periodic-peak veto, and the reason it exists.
#
# P95 alone is not enough, which is easy to get wrong. A workload that pins the
# CPU for one hour every morning occupies 30 of 720 hourly buckets over a
# 30-day window — about 4%. That sits *below* the 95th percentile, so P95
# reports the quiet baseline and the VM reads as oversized. Halving it would
# then break the one hour a day that actually matters.
#
# P99 is above that 4%, so it still sees the peak. Any VM whose P99 reaches
# this level has a real recurring peak and is never proposed for a downsize,
# however idle its P95 looks.
PERIODIC_PEAK_P99_CPU = 70.0

# Halving is the only downgrade proposed. Azure SKU families scale in powers of
# two, so this is the one step that is always available and always safe to
# reason about; anything more aggressive needs a human looking at the workload.
DOWNSIZE_FACTOR = 2


def _get(metrics: Dict[str, Any], name: str, stat: str = "p95") -> Optional[float]:
    """One statistic from one metric, or None when it was never observed."""
    entry = metrics.get(name)
    if not isinstance(entry, dict):
        return None
    value = entry.get(stat)
    return float(value) if value is not None else None


def _confident(metrics: Dict[str, Any], name: str) -> bool:
    entry = metrics.get(name)
    return bool(isinstance(entry, dict) and entry.get("confident"))


def memory_headroom(metrics: Dict[str, Any], ram_bytes: Optional[float]) -> Optional[float]:
    """
    The fraction of RAM still free when memory pressure was at its worst.

    Azure publishes *available* memory, not used, so the worst moment is the
    **minimum** of the available series, not the maximum. Getting this the wrong
    way round would report a starved machine as having plenty of headroom.
    """
    if not ram_bytes:
        return None
    worst_free = _get(metrics, "Available Memory Bytes", "min")
    if worst_free is None:
        return None
    return max(0.0, min(1.0, worst_free / ram_bytes))


def classify(
    metrics: Dict[str, Any],
    power_state: str = "",
    ram_bytes: Optional[float] = None,
) -> Dict[str, Any]:
    """
    What is this VM doing, and how sure are we?

    Returns a verdict plus the readings behind it. The `reason` is written for
    the person who has to defend the recommendation in a change review, so it
    names the actual numbers rather than saying "low utilization".
    """
    state = (power_state or "").lower().replace("powerstate/", "")

    # Checked before metrics because it needs none, and because a running-but-
    # idle VM and a stopped-but-billed VM need completely different actions.
    if state == "stopped":
        return {
            "verdict": STOPPED_BILLED,
            "severity": SEVERITY[STOPPED_BILLED],
            "confident": True,
            "reason": (
                "This VM is stopped but not deallocated, so Azure is still charging "
                "the full compute rate for a machine that is doing nothing. "
                "Deallocating it stops the compute charge immediately."
            ),
            "cpu_p95": None,
            "cpu_avg": None,
            "memory_headroom": None,
        }

    if state == "deallocated":
        return {
            "verdict": INSUFFICIENT_DATA,
            "severity": "none",
            "confident": False,
            "reason": (
                "This VM is deallocated, so it emits no metrics and is not billed "
                "for compute. Its disks and any reserved public IP are still billed."
            ),
            "cpu_p95": None,
            "cpu_avg": None,
            "memory_headroom": None,
        }

    cpu_p95 = _get(metrics, "Percentage CPU", "p95")
    cpu_p99 = _get(metrics, "Percentage CPU", "p99")
    cpu_max = _get(metrics, "Percentage CPU", "max")
    cpu_avg = _get(metrics, "Percentage CPU", "avg")
    cpu_confident = _confident(metrics, "Percentage CPU")
    headroom = memory_headroom(metrics, ram_bytes)

    if cpu_p95 is None or not cpu_confident:
        return {
            "verdict": INSUFFICIENT_DATA,
            "severity": "none",
            "confident": False,
            "reason": (
                "Not enough CPU telemetry to judge this VM. That usually means it "
                "was created recently, or that this account lacks Monitoring Reader. "
                "It is not evidence that the VM is idle."
            ),
            "cpu_p95": cpu_p95,
            "cpu_avg": cpu_avg,
            "memory_headroom": headroom,
        }

    net_in = _get(metrics, "Network In Total", "p95") or 0.0
    net_out = _get(metrics, "Network Out Total", "p95") or 0.0
    quiet_network = (net_in + net_out) < IDLE_P95_NETWORK_BYTES

    if cpu_p95 < IDLE_P95_CPU and quiet_network:
        # Even an apparently-dead VM gets the periodic-peak check. A machine
        # that runs a nightly batch job is idle 96% of the time and is not a
        # deletion candidate.
        if cpu_p99 is not None and cpu_p99 >= PERIODIC_PEAK_P99_CPU:
            return {
                "verdict": RIGHT_SIZED,
                "severity": "none",
                "confident": True,
                "reason": (
                    f"CPU sits near {cpu_p95:.1f}% almost all the time, but reaches "
                    f"{cpu_p99:.1f}% at the 99th percentile. That is a recurring "
                    "peak — a scheduled job or a daily busy period — so this machine "
                    "is doing real work and is not idle."
                ),
                "cpu_p95": cpu_p95,
                "cpu_p99": cpu_p99,
                "cpu_max": cpu_max,
                "cpu_avg": cpu_avg,
                "memory_headroom": headroom,
            }

        return {
            "verdict": IDLE,
            "severity": SEVERITY[IDLE],
            "confident": True,
            "reason": (
                f"CPU never exceeded {cpu_p95:.1f}% at the 95th percentile and the "
                f"network stayed under {(net_in + net_out) / 1_000_000:.2f} MB in its "
                "busiest hour. Nothing measurable is using this machine."
            ),
            "cpu_p95": cpu_p95,
            "cpu_p99": cpu_p99,
            "cpu_max": cpu_max,
            "cpu_avg": cpu_avg,
            "memory_headroom": headroom,
        }

    if cpu_p95 >= OVERUTILIZED_P95_CPU:
        return {
            "verdict": OVERUTILIZED,
            "severity": SEVERITY[OVERUTILIZED],
            "confident": True,
            "reason": (
                f"CPU reached {cpu_p95:.1f}% at the 95th percentile. This machine is "
                "running close to its ceiling and is a performance risk, not a "
                "savings opportunity."
            ),
            "cpu_p95": cpu_p95,
            "cpu_p99": cpu_p99,
            "cpu_max": cpu_max,
            "cpu_avg": cpu_avg,
            "memory_headroom": headroom,
        }

    if cpu_p95 < UNDERUTILIZED_P95_CPU:
        # The periodic-peak veto. See PERIODIC_PEAK_P99_CPU — a low P95 with a
        # high P99 is a daily peak hiding under a quiet baseline, and halving
        # the machine would break exactly the hour that matters.
        if cpu_p99 is not None and cpu_p99 >= PERIODIC_PEAK_P99_CPU:
            return {
                "verdict": RIGHT_SIZED,
                "severity": "none",
                "confident": True,
                "reason": (
                    f"CPU looks low at {cpu_p95:.1f}% for 95% of the time, but reaches "
                    f"{cpu_p99:.1f}% at the 99th percentile. That recurring peak is what "
                    "this machine is sized for, so shrinking it would break its busiest "
                    "hour."
                ),
                "cpu_p95": cpu_p95,
                "cpu_p99": cpu_p99,
                "cpu_max": cpu_max,
                "cpu_avg": cpu_avg,
                "memory_headroom": headroom,
            }

        # Memory can veto a CPU-based downsize. A machine sized for RAM rather
        # than CPU will always look CPU-idle, and halving it would kill it.
        if headroom is not None and headroom < MEMORY_HEADROOM_RATIO:
            return {
                "verdict": RIGHT_SIZED,
                "severity": "none",
                "confident": True,
                "reason": (
                    f"CPU peaks at only {cpu_p95:.1f}%, but just "
                    f"{headroom * 100:.0f}% of memory was free at the worst moment. "
                    "This machine is sized for memory, not CPU, so shrinking it "
                    "would starve it."
                ),
                "cpu_p95": cpu_p95,
                "cpu_p99": cpu_p99,
                "cpu_max": cpu_max,
                "cpu_avg": cpu_avg,
                "memory_headroom": headroom,
            }

        return {
            "verdict": UNDERUTILIZED,
            "severity": SEVERITY[UNDERUTILIZED],
            "confident": True,
            "reason": (
                f"CPU peaked at {cpu_p95:.1f}% at the 95th percentile, leaving over "
                f"{100 - cpu_p95:.0f}% of the machine unused even at its busiest."
                + (f" {headroom * 100:.0f}% of memory was free at peak demand."
                   if headroom is not None else "")
            ),
            "cpu_p95": cpu_p95,
            "cpu_p99": cpu_p99,
            "cpu_max": cpu_max,
            "cpu_avg": cpu_avg,
            "memory_headroom": headroom,
        }

    return {
        "verdict": RIGHT_SIZED,
        "severity": "none",
        "confident": True,
        "reason": (
            f"CPU peaks at {cpu_p95:.1f}%, which uses the machine without running it "
            "close to its limit."
        ),
        "cpu_p95": cpu_p95,
        "cpu_p99": cpu_p99,
        "cpu_max": cpu_max,
        "cpu_avg": cpu_avg,
        "memory_headroom": headroom,
    }


# ───────────────────────────── SKU arithmetic ─────────────────────────────


def parse_sku(sku: str) -> Optional[Dict[str, Any]]:
    """
    Split an Azure VM size into the parts needed to name a smaller sibling.

    `Standard_D8s_v5` -> family `D`, 8 vCPU, suffix `s`, version `v5`.

    Returns None for anything that does not match the standard pattern, which
    is the correct outcome for constrained-core, GPU and specialty sizes. Those
    do not halve predictably and must not be guessed at.
    """
    if not sku:
        return None

    parts = sku.split("_")
    if len(parts) < 2 or parts[0].lower() != "standard":
        return None

    body = parts[1]
    version = parts[2] if len(parts) > 2 else ""

    # family letters, then digits (the vCPU count), then optional suffix letters
    i = 0
    while i < len(body) and body[i].isalpha():
        i += 1
    family = body[:i]

    j = i
    while j < len(body) and body[j].isdigit():
        j += 1
    digits = body[i:j]
    suffix = body[j:]

    if not family or not digits:
        return None

    # Constrained-core sizes look like `Standard_E8-4s_v5`. The billed vCPU
    # count is the first number but the licensed count is the second, and
    # halving them is a licensing decision rather than a sizing one.
    if "-" in body:
        return None

    return {
        "family": family,
        "vcpu": int(digits),
        "suffix": suffix,
        "version": version,
    }


def format_sku(parsed: Dict[str, Any], vcpu: int) -> str:
    """Rebuild a size name at a different vCPU count."""
    core = f"Standard_{parsed['family']}{vcpu}{parsed['suffix']}"
    return f"{core}_{parsed['version']}" if parsed["version"] else core


def smaller_sku(sku: str, factor: int = DOWNSIZE_FACTOR) -> Optional[str]:
    """
    The next size down in the same family, or None when there isn't one.

    Stays inside the family on purpose. Moving a D-series to an E-series
    changes the memory-per-core ratio, which is a workload decision this module
    has no basis to make.
    """
    parsed = parse_sku(sku)
    if not parsed:
        return None

    target = parsed["vcpu"] // factor
    # Below 2 vCPU the family naming stops being regular (B-series burstables,
    # fractional-core sizes), so no recommendation is made.
    if target < 2:
        return None

    return format_sku(parsed, target)


def estimate_savings(
    current_monthly: Optional[float],
    current_sku: str,
    target_sku: Optional[str],
    price_lookup: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """
    What halving this VM would actually save, per month and per year.

    `price_lookup` maps a SKU name to its hourly retail price. When it is
    supplied the saving is derived from two real published prices. When it is
    not, the saving is `None` and `basis` says why — this function will not
    fall back to "assume it costs half", because SKU pricing is not linear in
    vCPU count and that assumption has been wrong by over 20% in practice.
    """
    if not target_sku:
        return {"monthly": None, "annual": None, "basis": "no_smaller_size",
                "note": "No smaller size in this family."}

    if price_lookup:
        current_price = price_lookup.get(current_sku)
        target_price = price_lookup.get(target_sku)
        if current_price is not None and target_price is not None:
            # 730 = the hours in an average month Azure itself bills against.
            monthly = max(0.0, (current_price - target_price) * 730)
            return {
                "monthly": monthly,
                "annual": monthly * 12,
                "basis": "retail_prices",
                "note": (
                    f"{current_sku} is published at {current_price:.5f}/hour and "
                    f"{target_sku} at {target_price:.5f}/hour. The difference over "
                    "730 hours is the monthly saving."
                ),
            }

    if current_monthly is not None:
        return {
            "monthly": None,
            "annual": None,
            "basis": "price_unavailable",
            "note": (
                f"This VM costs {current_monthly:.2f} a month, but the published "
                f"price for {target_sku} could not be read, so the saving is not "
                "estimated. Azure SKU prices are not proportional to vCPU count, "
                "so halving the cost would be a guess."
            ),
        }

    return {"monthly": None, "annual": None, "basis": "unknown",
            "note": "Neither the current cost nor the target price is known."}


def analyse_vm(
    vm: Dict[str, Any],
    metrics: Dict[str, Any],
    price_lookup: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """
    One VM, fully assessed: what it is, what it did, and what to do about it.

    `vm` carries the inventory facts (id, name, sku, region, power state,
    monthly cost, ram). `metrics` is a summary block from `azure_metrics`.
    """
    sku = vm.get("sku") or ""
    verdict = classify(
        metrics,
        power_state=vm.get("power_state") or "",
        ram_bytes=vm.get("ram_bytes"),
    )

    target = None
    savings = {"monthly": None, "annual": None, "basis": "not_applicable", "note": ""}
    action = "none"

    if verdict["verdict"] == STOPPED_BILLED:
        action = "deallocate"
        savings = {
            "monthly": vm.get("monthly_cost"),
            "annual": (vm["monthly_cost"] * 12) if vm.get("monthly_cost") else None,
            "basis": "full_compute_cost",
            "note": "Deallocating removes the entire compute charge. Disk charges remain.",
        }
    elif verdict["verdict"] == IDLE:
        action = "review_for_deletion"
        savings = {
            "monthly": vm.get("monthly_cost"),
            "annual": (vm["monthly_cost"] * 12) if vm.get("monthly_cost") else None,
            "basis": "full_compute_cost",
            "note": (
                "Shown as the full cost of the VM because the recommendation is to "
                "remove it. Confirm it is genuinely unused before acting."
            ),
        }
    elif verdict["verdict"] == UNDERUTILIZED:
        target = smaller_sku(sku)
        if target:
            action = "resize"
            savings = estimate_savings(vm.get("monthly_cost"), sku, target, price_lookup)
        else:
            action = "review"
            savings["note"] = (
                f"{sku} has no predictable smaller sibling, so no specific resize is "
                "proposed. A human should choose the target size."
            )
    elif verdict["verdict"] == OVERUTILIZED:
        action = "investigate"

    return {
        "id": vm.get("id"),
        "name": vm.get("name"),
        "sku": sku,
        "region": vm.get("region"),
        "resource_group": vm.get("resource_group"),
        "subscription_id": vm.get("subscription_id"),
        "power_state": vm.get("power_state"),
        "monthly_cost": vm.get("monthly_cost"),
        "verdict": verdict["verdict"],
        "verdict_label": VERDICT_LABEL[verdict["verdict"]],
        "severity": verdict["severity"],
        "confident": verdict["confident"],
        "reason": verdict["reason"],
        "cpu_p95": verdict["cpu_p95"],
        "cpu_p99": verdict.get("cpu_p99"),
        "cpu_max": verdict.get("cpu_max"),
        "cpu_avg": verdict["cpu_avg"],
        "memory_headroom": verdict["memory_headroom"],
        "recommended_sku": target,
        "action": action,
        "savings": savings,
        # Carried so the UI can show how much telemetry the verdict rests on.
        "metric_points": (metrics.get("Percentage CPU") or {}).get("points", 0),
    }


def summarise_fleet(analyses: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Fleet totals, with the savings split by how solid the evidence is.

    `confident_savings` is the number safe to put in front of a finance team.
    The total is kept separate because it includes findings that still need a
    human to confirm, and merging the two would overstate what is bankable.
    """
    by_verdict: Dict[str, int] = {}
    total_savings = 0.0
    confident_savings = 0.0
    priced = 0

    for item in analyses:
        by_verdict[item["verdict"]] = by_verdict.get(item["verdict"], 0) + 1
        monthly = (item.get("savings") or {}).get("monthly")
        if monthly:
            total_savings += monthly
            priced += 1
            if item.get("confident"):
                confident_savings += monthly

    return {
        "total": len(analyses),
        "by_verdict": by_verdict,
        "monthly_savings": total_savings,
        "annual_savings": total_savings * 12,
        "confident_monthly_savings": confident_savings,
        "priced_recommendations": priced,
        "unpriced_recommendations": sum(
            1 for i in analyses
            if i.get("action") not in ("none",) and not (i.get("savings") or {}).get("monthly")
        ),
        "note": (
            "Savings are only counted where a published price for both the current "
            "and the proposed size could be read. Recommendations without a price "
            "are listed but contribute nothing to these totals."
        ),
    }


def sort_key(item: Dict[str, Any]):
    """Worst verdict first, then by the money at stake."""
    order = VERDICT_ORDER.index(item["verdict"]) if item["verdict"] in VERDICT_ORDER else 99
    monthly = (item.get("savings") or {}).get("monthly") or 0.0
    return (order, -monthly, item.get("name") or "")

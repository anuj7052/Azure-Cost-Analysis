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

# The evidence bar for a percentile, owned by the module that measures it.
# Imported rather than duplicated so the number quoted in the explanation can
# never drift from the number actually enforced.
from services import azure_metrics as am
from services.azure_metrics import (
    MIN_COVERAGE_FOR_CONFIDENCE,
    MIN_POINTS_FOR_CONFIDENCE,
)

# ─────────────────────────────── verdicts ───────────────────────────────

IDLE = "idle"
UNDERUTILIZED = "underutilized"
RIGHT_SIZED = "right_sized"
OVERUTILIZED = "overutilized"
STOPPED_BILLED = "stopped_but_billed"
DEALLOCATED = "deallocated"
INSUFFICIENT_DATA = "insufficient_data"

VERDICT_LABEL = {
    IDLE: "Idle",
    UNDERUTILIZED: "Oversized",
    RIGHT_SIZED: "Right-sized",
    OVERUTILIZED: "Under-pressure",
    STOPPED_BILLED: "Stopped but billing",
    DEALLOCATED: "Deallocated",
    INSUFFICIENT_DATA: "Not enough data",
}

# Ordered worst-first, so a sorted list leads with what costs money.
# Deallocated sits above "not enough data" because it is a definite finding
# with a definite explanation, not an absence of one.
VERDICT_ORDER = [
    STOPPED_BILLED, IDLE, UNDERUTILIZED, OVERUTILIZED,
    DEALLOCATED, RIGHT_SIZED, INSUFFICIENT_DATA,
]

SEVERITY = {
    STOPPED_BILLED: "high",
    IDLE: "high",
    UNDERUTILIZED: "medium",
    OVERUTILIZED: "medium",
    DEALLOCATED: "none",
    RIGHT_SIZED: "none",
    INSUFFICIENT_DATA: "none",
}

# ─────────────────────────── telemetry states ───────────────────────────
#
# Why these are separate from the verdict.
#
# "We have no CPU data" has at least seven distinct causes, and they need
# different actions from the reader: grant a permission, install the guest
# agent, wait for the VM to warm up, retry later, or nothing at all because the
# VM is switched off. Collapsing them all into "Not enough data" — which is
# what this page used to do — tells the user their data is broken and gives
# them no way to find out why. The verdict answers "what should I do about this
# VM"; this answers "why is that column empty".
#
# The values come from `azure_metrics` so that the string the fetcher produces
# and the string the UI switches on can never drift apart.

TELEMETRY_OK = am.VALID
TELEMETRY_PARTIAL = am.PARTIAL_DATA
TELEMETRY_INSUFFICIENT = am.INSUFFICIENT_DATA
TELEMETRY_NONE = am.NO_DATA
TELEMETRY_PERMISSION = am.NO_ACCESS
TELEMETRY_THROTTLED = am.THROTTLED
TELEMETRY_UNSUPPORTED = am.NO_METRIC
TELEMETRY_ERROR = am.API_ERROR
TELEMETRY_NOT_APPLICABLE = am.NOT_RUNNING

TELEMETRY_LABEL = dict(am.STATUS_LABEL)

# ─────────────────────────── the four questions ───────────────────────────
#
# A single verdict per VM was the wrong shape. "Not enough data" was being made
# to answer four unrelated questions at once — is it on, what does it cost, do
# we know what it did, and can it be shrunk — and so it answered none of them.
# A VM whose CPU metric is unavailable is still definitely running and still
# definitely costs money; only the last question is unanswerable.

# Operational: is this machine on?
OP_RUNNING = "RUNNING"
OP_DEALLOCATED = "DEALLOCATED"
OP_STOPPED = "STOPPED"
OP_UNKNOWN = "UNKNOWN"

OPERATIONAL_LABEL = {
    OP_RUNNING: "Running",
    OP_DEALLOCATED: "Deallocated",
    OP_STOPPED: "Stopped (still billing)",
    OP_UNKNOWN: "Unknown",
}

# Utilization: do we know what it did?
UTIL_MEASURED = "MEASURED"
UTIL_PARTIAL = "PARTIAL"
UTIL_UNAVAILABLE = "UNAVAILABLE"
UTIL_NOT_APPLICABLE = "NOT_APPLICABLE"

UTILIZATION_LABEL = {
    UTIL_MEASURED: "Measured",
    UTIL_PARTIAL: "Partial telemetry",
    UTIL_UNAVAILABLE: "Unavailable",
    UTIL_NOT_APPLICABLE: "Not running",
}

# Right-sizing: can it be safely shrunk?
RS_OVERSIZED = "OVERSIZED"
RS_UNDERSIZED = "UNDERSIZED"
RS_RIGHT_SIZED = "RIGHT_SIZED"
RS_IDLE = "IDLE"
RS_DEALLOCATE = "DEALLOCATE"
RS_CANNOT_DETERMINE = "CANNOT_DETERMINE"
RS_NOT_APPLICABLE = "NOT_APPLICABLE"

RIGHTSIZING_LABEL = {
    RS_OVERSIZED: "Oversized",
    RS_UNDERSIZED: "Under pressure",
    RS_RIGHT_SIZED: "Right-sized",
    RS_IDLE: "Idle",
    RS_DEALLOCATE: "Deallocate",
    RS_CANNOT_DETERMINE: "Cannot determine",
    RS_NOT_APPLICABLE: "Not applicable",
}

# Confidence in a recommendation. Only HIGH is allowed to move the fleet
# savings total — see `summarise_fleet`. A number a finance team is shown must
# be one an engineer would defend without a caveat.
CONF_HIGH = "HIGH"
CONF_MEDIUM = "MEDIUM"
CONF_LOW = "LOW"
CONF_NONE = "NONE"

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


def power_label(raw: Optional[str]) -> str:
    """
    Normalise Resource Graph's power state into one of four words.

    Azure reports this as `PowerState/running`, and occasionally as an empty
    string when the instance view was not expanded. Passing the raw value to
    the UI produced "PowerState/deallocated" in a table column; passing an
    empty string produced a blank cell that read as a missing field rather
    than an unknown state.
    """
    state = (raw or "").lower().replace("powerstate/", "").strip()
    if state in ("running", "deallocated", "stopped"):
        return state
    if state in ("starting", "stopping", "deallocating"):
        return state
    return "unknown"


# ─────────────────────────── multi-signal model ───────────────────────────


def _signal(metrics: Dict[str, Any], names: Sequence[str]) -> Dict[str, Any]:
    """
    One telemetry signal, summarised across whichever of its metrics exist.

    A signal is available when *any* of its constituent metrics returned
    observations. Network, for instance, is two counters; a VM reporting only
    inbound traffic is still measurable on network.
    """
    present = [
        (name, metrics[name]) for name in names
        if isinstance(metrics.get(name), dict) and (metrics[name].get("points") or 0) > 0
    ]
    if not present:
        return {"available": False, "metrics": [], "points": 0, "coverage": None}

    points = sum((entry.get("points") or 0) for _, entry in present)
    coverages = [entry.get("coverage") for _, entry in present
                 if entry.get("coverage") is not None]
    return {
        "available": True,
        "metrics": [name for name, _ in present],
        "points": points,
        "coverage": (sum(coverages) / len(coverages)) if coverages else None,
    }


NETWORK_METRICS = ["Network In Total", "Network Out Total"]
DISK_METRICS_VM = [
    "Disk Read Bytes", "Disk Write Bytes",
    "Disk Read Operations/Sec", "Disk Write Operations/Sec",
    "OS Disk IOPS Consumed Percentage", "Data Disk IOPS Consumed Percentage",
]
MEMORY_METRICS = ["Available Memory Bytes"]


def signals(metrics: Dict[str, Any]) -> Dict[str, Any]:
    """
    Every telemetry signal this VM offered, whether or not CPU was among them.

    Compute Intelligence must not be all-or-nothing on `Percentage CPU`. A VM
    with no CPU metric but live network and disk counters is still observably
    doing work, and saying so is far more useful than "not enough data" — even
    though it remains unsizeable, which `right_sizing` reports separately.
    """
    return {
        "cpu": _signal(metrics, ["Percentage CPU"]),
        "network": _signal(metrics, NETWORK_METRICS),
        "disk": _signal(metrics, DISK_METRICS_VM),
        "memory": _signal(metrics, MEMORY_METRICS),
    }


# Whether a metric exists and whether it returned anything are two different
# facts, and the drawer used to answer them from two different places: the
# capability list said "CPU: Published" while the telemetry line said "CPU
# metric unavailable" about the very same metric. Both were reading real data;
# neither was reading all of it. Deriving one status per signal here means the
# UI has a single fact to render and cannot reassemble the contradiction.
SIG_NOT_PUBLISHED = "NOT_PUBLISHED"
SIG_PUBLISHED_NO_DATA = "PUBLISHED_NO_DATA"
SIG_PUBLISHED_WITH_DATA = "PUBLISHED_WITH_DATA"
SIG_NOT_RUNNING = "NOT_RUNNING"
SIG_UNKNOWN = "UNKNOWN"

SIGNAL_LABEL = {
    SIG_NOT_PUBLISHED: "Not published",
    SIG_PUBLISHED_NO_DATA: "Published · No data",
    SIG_PUBLISHED_WITH_DATA: "Published",
    SIG_NOT_RUNNING: "Not running",
    SIG_UNKNOWN: "Unknown",
    # A query-level failure tells us nothing about the signal itself, so those
    # states are passed through under their own names rather than guessed at.
    TELEMETRY_PERMISSION: "Access denied",
    TELEMETRY_THROTTLED: "Throttled",
    TELEMETRY_ERROR: "Query error",
}

# Which capability flag backs each signal.
_SIGNAL_CAPABILITY = {
    "cpu": "percentage_cpu",
    "network": "network",
    "disk": "disk",
    "memory": "memory",
}


def signal_status(
    name: str,
    signal: Dict[str, Any],
    capabilities: Dict[str, Any],
    telemetry_state: str,
) -> str:
    """
    One signal's status, reconciling the catalogue with the query result.

    Order matters. A powered-off machine explains every absence at once. A
    failed or refused query explains the rest, and must not be reported as
    "not published" — the request never got far enough to establish that.
    Only then does the catalogue decide, and only then can "published but
    silent" be distinguished from "not published at all".
    """
    if telemetry_state == TELEMETRY_NOT_APPLICABLE:
        return SIG_NOT_RUNNING
    if telemetry_state in (TELEMETRY_PERMISSION, TELEMETRY_THROTTLED, TELEMETRY_ERROR):
        return telemetry_state
    if signal.get("available"):
        return SIG_PUBLISHED_WITH_DATA
    if not capabilities:
        # No catalogue was read, so "not published" is not a claim we are in a
        # position to make.
        return SIG_UNKNOWN
    published = capabilities.get(_SIGNAL_CAPABILITY.get(name, name))
    if published is None:
        return SIG_UNKNOWN
    return SIG_PUBLISHED_NO_DATA if published else SIG_NOT_PUBLISHED


def annotate_signals(
    signal_map: Dict[str, Any],
    capabilities: Optional[Dict[str, Any]],
    telemetry_state: str,
) -> Dict[str, Any]:
    """Attach a status and its label to every signal, in place."""
    caps = capabilities or {}
    for name, signal in signal_map.items():
        status = signal_status(name, signal, caps, telemetry_state)
        signal["status"] = status
        signal["label"] = SIGNAL_LABEL.get(status, status)
    return signal_map


def operational_status(power_state: str) -> str:
    """Is this machine on? Answerable from inventory alone, always."""
    state = power_label(power_state)
    if state == "running":
        return OP_RUNNING
    if state == "deallocated":
        return OP_DEALLOCATED
    if state == "stopped":
        return OP_STOPPED
    return OP_UNKNOWN


def utilization_status(telemetry_state: str, signal_map: Dict[str, Any]) -> str:
    """
    Do we know what this machine did?

    Deliberately not the same question as "can it be resized". A VM with
    network and disk telemetry but no CPU is partially measured, and reporting
    that as `UNAVAILABLE` throws away real evidence that the machine is in use.
    """
    if telemetry_state == TELEMETRY_NOT_APPLICABLE:
        return UTIL_NOT_APPLICABLE
    if telemetry_state == TELEMETRY_OK:
        return UTIL_MEASURED
    if any(s.get("available") for s in signal_map.values()):
        return UTIL_PARTIAL
    return UTIL_UNAVAILABLE


def _rightsizing_from(verdict: str, telemetry_state: str) -> str:
    """The sizing question alone, with no opinion about cost or power."""
    if telemetry_state == TELEMETRY_NOT_APPLICABLE:
        return RS_DEALLOCATE if verdict == STOPPED_BILLED else RS_NOT_APPLICABLE
    return {
        UNDERUTILIZED: RS_OVERSIZED,
        OVERUTILIZED: RS_UNDERSIZED,
        RIGHT_SIZED: RS_RIGHT_SIZED,
        IDLE: RS_IDLE,
        STOPPED_BILLED: RS_DEALLOCATE,
        DEALLOCATED: RS_NOT_APPLICABLE,
    }.get(verdict, RS_CANNOT_DETERMINE)


def confidence_for(
    rightsizing: str,
    telemetry_state: str,
    coverage: Optional[float],
    priced: bool,
) -> str:
    """
    How much weight this recommendation can carry.

    Only HIGH reaches the fleet savings headline. That requires all three of:
    sound telemetry, coverage over most of the window, and a saving derived
    from two real published prices. Anything softer is still shown on the row —
    it is a genuine finding — but it is not added to a number a finance team
    will treat as committed.
    """
    if rightsizing in (RS_CANNOT_DETERMINE, RS_NOT_APPLICABLE, RS_RIGHT_SIZED):
        return CONF_NONE
    if rightsizing == RS_DEALLOCATE:
        # Needs no telemetry at all: a stopped-but-billed VM is proven by its
        # power state, and the saving is its own full compute cost.
        return CONF_HIGH if priced else CONF_MEDIUM
    if telemetry_state != TELEMETRY_OK:
        return CONF_LOW
    if coverage is not None and coverage < MIN_COVERAGE_FOR_CONFIDENCE:
        return CONF_MEDIUM
    return CONF_HIGH if priced else CONF_MEDIUM


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
    telemetry_error: str = "",
) -> Dict[str, Any]:
    """
    What is this VM doing, and how sure are we?

    Returns a verdict plus the readings behind it. The `reason` is written for
    the person who has to defend the recommendation in a change review, so it
    names the actual numbers rather than saying "low utilization".

    `telemetry_error` is the `kind` from `azure_metrics` when the fetch did not
    succeed. It never changes the verdict, only the explanation: a VM whose
    metrics call was throttled and a VM that genuinely reported nothing both
    end up unjudgeable, but only one of them is worth retrying.
    """
    state = (power_state or "").lower().replace("powerstate/", "")
    cpu = metrics.get("Percentage CPU") or {}

    def readings(extra: Dict[str, Any]) -> Dict[str, Any]:
        """Every branch reports the same fields, so the UI never meets a gap."""
        base = {
            "cpu_p95": cpu.get("p95"),
            "cpu_p99": cpu.get("p99"),
            "cpu_max": cpu.get("max"),
            "cpu_avg": cpu.get("avg"),
            "cpu_min": cpu.get("min"),
            "points": cpu.get("points") or 0,
            "expected_points": cpu.get("expected"),
            "coverage": cpu.get("coverage"),
            "first_observed": cpu.get("first"),
            "last_observed": cpu.get("last"),
            "memory_headroom": memory_headroom(metrics, ram_bytes),
        }
        base.update(extra)
        return base

    # Checked before metrics because it needs none, and because a running-but-
    # idle VM and a stopped-but-billed VM need completely different actions.
    if state == "stopped":
        return readings({
            "verdict": STOPPED_BILLED,
            "severity": SEVERITY[STOPPED_BILLED],
            "confident": True,
            "telemetry": TELEMETRY_NOT_APPLICABLE,
            "reason": (
                "This VM is stopped but not deallocated, so Azure is still charging "
                "the full compute rate for a machine that is doing nothing. "
                "Deallocating it stops the compute charge immediately."
            ),
        })

    if state == "deallocated":
        # Deliberately its own verdict. Reporting this as "not enough data"
        # was accurate about the telemetry and useless to the reader: there is
        # nothing missing here and nothing to investigate. The VM is off.
        return readings({
            "verdict": DEALLOCATED,
            "severity": SEVERITY[DEALLOCATED],
            "confident": True,
            "telemetry": TELEMETRY_NOT_APPLICABLE,
            "reason": (
                "This VM is deallocated, so it emits no CPU metrics and is not "
                "billed for compute. Attached disks and any reserved public IP "
                "are still billed. Missing CPU data here is expected, not a fault."
            ),
        })

    cpu_p95 = _get(metrics, "Percentage CPU", "p95")
    cpu_p99 = _get(metrics, "Percentage CPU", "p99")
    cpu_max = _get(metrics, "Percentage CPU", "max")
    cpu_avg = _get(metrics, "Percentage CPU", "avg")
    cpu_confident = _confident(metrics, "Percentage CPU")
    headroom = memory_headroom(metrics, ram_bytes)

    if cpu_p95 is None or not cpu_confident:
        # Name the actual cause. "Not enough data" on its own reads as a bug in
        # this app, and the reader has no way to tell whether to grant a role,
        # retry in a minute, or simply wait for a new VM to accumulate history.
        observed = cpu.get("points") or 0
        if telemetry_error == TELEMETRY_PERMISSION:
            telemetry = TELEMETRY_PERMISSION
            reason = (
                "Azure Monitor refused this query: the account is missing "
                "Monitoring Reader (Microsoft.Insights/metrics/read) on this VM. "
                "This is a permission gap, not evidence that the VM is idle."
            )
        elif telemetry_error == TELEMETRY_THROTTLED:
            telemetry = TELEMETRY_THROTTLED
            reason = (
                "Azure Monitor throttled this query, so the CPU history came back "
                "incomplete. Refreshing shortly will usually return the full window."
            )
        elif telemetry_error == TELEMETRY_UNSUPPORTED:
            telemetry = TELEMETRY_UNSUPPORTED
            reason = (
                "Percentage CPU is not published for this resource, so it cannot be "
                "sized on CPU. This is a fact about what Azure Monitor exposes for "
                "this machine, not a measurement of how busy it is."
            )
        elif telemetry_error == TELEMETRY_ERROR:
            telemetry = TELEMETRY_ERROR
            reason = (
                "The Azure Monitor query failed, so no CPU history could be read. "
                "This is a failed request, not a measurement of low usage."
            )
        elif observed == 0:
            telemetry = TELEMETRY_NONE
            reason = (
                "Azure Monitor lists Percentage CPU for this VM but returned no "
                "datapoints for the selected period. The metric exists; the window "
                "is empty. A VM created recently, or deallocated for the whole "
                "period, reports nothing. It is not evidence of idleness."
            )
        elif telemetry_error == TELEMETRY_PARTIAL:
            # The fetch layer already established that the window came back
            # incomplete. Without this branch that finding was relabelled as
            # INSUFFICIENT_DATA, which reads as "too new to judge" and hides
            # the fact that a gap in the history is the actual problem.
            telemetry = TELEMETRY_PARTIAL
            reason = (
                f"Azure Monitor returned {observed} CPU datapoints, but only for part "
                "of the window, so the percentiles would describe a fraction of the "
                "period rather than the whole of it."
            )
        elif observed < MIN_POINTS_FOR_CONFIDENCE:
            telemetry = TELEMETRY_INSUFFICIENT
            reason = (
                f"Only {observed} CPU datapoints were returned, below the "
                f"{MIN_POINTS_FOR_CONFIDENCE} needed for a dependable percentile. "
                "A resize decision on this little evidence would be a guess."
            )
        else:
            # Enough datapoints arrived, but they did not yield a usable p95.
            # Claiming they were "below the minimum" would be a false statement
            # about data the reader can see the count of.
            telemetry = TELEMETRY_INSUFFICIENT
            reason = (
                f"{observed} CPU datapoints were returned, but they did not produce a "
                "dependable 95th percentile, so there is no sound basis for a resize."
            )

        return readings({
            "verdict": INSUFFICIENT_DATA,
            "severity": "none",
            "confident": False,
            "telemetry": telemetry,
            "reason": reason,
        })

    net_in = _get(metrics, "Network In Total", "p95") or 0.0
    net_out = _get(metrics, "Network Out Total", "p95") or 0.0
    quiet_network = (net_in + net_out) < IDLE_P95_NETWORK_BYTES

    if cpu_p95 < IDLE_P95_CPU and quiet_network:
        # Even an apparently-dead VM gets the periodic-peak check. A machine
        # that runs a nightly batch job is idle 96% of the time and is not a
        # deletion candidate.
        if cpu_p99 is not None and cpu_p99 >= PERIODIC_PEAK_P99_CPU:
            return readings({
                "verdict": RIGHT_SIZED,
                "severity": "none",
                "confident": True,
                "reason": (
                    f"CPU sits near {cpu_p95:.1f}% almost all the time, but reaches "
                    f"{cpu_p99:.1f}% at the 99th percentile. That is a recurring "
                    "peak — a scheduled job or a daily busy period — so this machine "
                    "is doing real work and is not idle."
                ),
            })

        return readings({
            "verdict": IDLE,
            "severity": SEVERITY[IDLE],
            "confident": True,
            "reason": (
                f"CPU never exceeded {cpu_p95:.1f}% at the 95th percentile and the "
                f"network stayed under {(net_in + net_out) / 1_000_000:.2f} MB in its "
                "busiest hour. Nothing measurable is using this machine."
            ),
        })

    if cpu_p95 >= OVERUTILIZED_P95_CPU:
        return readings({
            "verdict": OVERUTILIZED,
            "severity": SEVERITY[OVERUTILIZED],
            "confident": True,
            "reason": (
                f"CPU reached {cpu_p95:.1f}% at the 95th percentile. This machine is "
                "running close to its ceiling and is a performance risk, not a "
                "savings opportunity."
            ),
        })

    if cpu_p95 < UNDERUTILIZED_P95_CPU:
        # The periodic-peak veto. See PERIODIC_PEAK_P99_CPU — a low P95 with a
        # high P99 is a daily peak hiding under a quiet baseline, and halving
        # the machine would break exactly the hour that matters.
        if cpu_p99 is not None and cpu_p99 >= PERIODIC_PEAK_P99_CPU:
            return readings({
                "verdict": RIGHT_SIZED,
                "severity": "none",
                "confident": True,
                "reason": (
                    f"CPU looks low at {cpu_p95:.1f}% for 95% of the time, but reaches "
                    f"{cpu_p99:.1f}% at the 99th percentile. That recurring peak is what "
                    "this machine is sized for, so shrinking it would break its busiest "
                    "hour."
                ),
            })

        # Memory can veto a CPU-based downsize. A machine sized for RAM rather
        # than CPU will always look CPU-idle, and halving it would kill it.
        if headroom is not None and headroom < MEMORY_HEADROOM_RATIO:
            return readings({
                "verdict": RIGHT_SIZED,
                "severity": "none",
                "confident": True,
                "reason": (
                    f"CPU peaks at only {cpu_p95:.1f}%, but just "
                    f"{headroom * 100:.0f}% of memory was free at the worst moment. "
                    "This machine is sized for memory, not CPU, so shrinking it "
                    "would starve it."
                ),
            })

        return readings({
            "verdict": UNDERUTILIZED,
            "severity": SEVERITY[UNDERUTILIZED],
            "confident": True,
            "reason": (
                f"CPU peaked at {cpu_p95:.1f}% at the 95th percentile, leaving over "
                f"{100 - cpu_p95:.0f}% of the machine unused even at its busiest."
                + (f" {headroom * 100:.0f}% of memory was free at peak demand."
                   if headroom is not None else "")
            ),
        })

    return readings({
        "verdict": RIGHT_SIZED,
        "severity": "none",
        "confident": True,
        "reason": (
            f"CPU peaks at {cpu_p95:.1f}%, which uses the machine without running it "
            "close to its limit."
        ),
    })


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

    The lookup is matched case-insensitively. Resource Graph, Cost Management
    and the pricing catalogue each capitalise `Standard_D4as_v5` differently,
    and an exact-match lookup drops the row without saying so — which reads to
    a user as "Azure publishes no price for this size".
    """
    if not target_sku:
        return {"monthly": None, "annual": None, "basis": "no_smaller_size",
                "note": "No smaller size in this family."}

    if price_lookup:
        folded = {k.lower(): v for k, v in price_lookup.items()}
        current_price = folded.get((current_sku or "").lower())
        target_price = folded.get(target_sku.lower())
        if current_price is not None and target_price is not None and current_price > 0:
            # The *ratio* between two published prices is the reliable part of
            # retail pricing. The absolute difference is not, because almost
            # nobody pays list: reservations, Hybrid Benefit, CSP discounts and
            # partial-month running all mean the real bill is lower.
            #
            # Taking the difference at list price and presenting it against a
            # real Cost Management figure produced savings larger than the
            # machine's entire bill — observed live at ₹20,598/month "saved" on
            # a VM costing ₹2,650/month. That is not a rounding error, it is a
            # number that tells the reader the tool cannot be trusted.
            #
            # So: apply the retail ratio to what the VM actually costs. The
            # answer is then bounded by real spend by construction.
            reduction = max(0.0, 1.0 - (target_price / current_price))
            if current_monthly is not None:
                monthly = current_monthly * reduction
                return {
                    "monthly": monthly,
                    "annual": monthly * 12,
                    "basis": "actual_cost_and_retail_ratio",
                    "note": (
                        f"{current_sku} is published at {current_price:.5f}/hour and "
                        f"{target_sku} at {target_price:.5f}/hour — {reduction * 100:.0f}% "
                        f"less. Applied to this VM's actual cost of "
                        f"{current_monthly:.2f} a month rather than to the list "
                        "price, because reservations, Hybrid Benefit and part-month "
                        "running all mean the billed amount is lower than list."
                    ),
                }
            # No actual cost to scale, so the list-price difference is the only
            # available answer. Labelled distinctly so the UI can say so.
            monthly = max(0.0, (current_price - target_price) * 730)
            return {
                "monthly": monthly,
                "annual": monthly * 12,
                "basis": "retail_prices",
                "note": (
                    f"{current_sku} is published at {current_price:.5f}/hour and "
                    f"{target_sku} at {target_price:.5f}/hour. The difference over "
                    "730 hours is the monthly saving. This is a list-price "
                    "estimate — no billed cost was matched to this VM."
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


ACTION_SENTENCE = {
    "deallocate": "Deallocate this VM to stop the compute charge.",
    "review_for_deletion": "Confirm the VM is genuinely unused, then delete it.",
    "resize": "Resize to the recommended size during a maintenance window.",
    "investigate": "Investigate the load before it becomes an incident.",
    "review": "Choose a target size by hand — this family does not halve predictably.",
    "none": "",
}


def analyse_vm(
    vm: Dict[str, Any],
    metrics: Dict[str, Any],
    price_lookup: Optional[Dict[str, float]] = None,
    telemetry_error: str = "",
    capabilities: Optional[Dict[str, Any]] = None,
    diagnostics: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    One VM, fully assessed: what it is, what it did, and what to do about it.

    `vm` carries the inventory facts (id, name, sku, region, power state,
    monthly cost, ram). `metrics` is a summary block from `azure_metrics`.

    The result answers four separate questions — operational, cost, utilization
    and right-sizing — because they have independent answers. A VM whose CPU
    metric Azure does not publish is still definitely running and still
    definitely billed; only its sizing is unknowable, and collapsing all four
    into one "not enough data" verdict threw away three answers we had.
    """
    sku = vm.get("sku") or ""
    # Cost must be a number or None. It arrives from a Cost Management index
    # whose entries are dicts, and passing one of those straight through is
    # what produced "₹NaN" on this page: the frontend formatted an object.
    monthly_cost = vm.get("monthly_cost")
    if isinstance(monthly_cost, dict):
        monthly_cost = monthly_cost.get("cost")
    try:
        monthly_cost = float(monthly_cost) if monthly_cost is not None else None
    except (TypeError, ValueError):
        monthly_cost = None
    annual_cost = monthly_cost * 12 if monthly_cost is not None else None

    verdict = classify(
        metrics,
        power_state=vm.get("power_state") or "",
        ram_bytes=vm.get("ram_bytes"),
        telemetry_error=telemetry_error,
    )

    target = None
    savings = {"monthly": None, "annual": None, "basis": "not_applicable", "note": ""}
    action = "none"

    if verdict["verdict"] == STOPPED_BILLED:
        action = "deallocate"
        savings = {
            "monthly": monthly_cost,
            "annual": annual_cost,
            "basis": "full_compute_cost" if monthly_cost is not None else "cost_unavailable",
            "note": (
                "Deallocating removes the entire compute charge. Disk charges remain."
                if monthly_cost is not None else
                "Deallocating removes the compute charge, but this VM's cost could "
                "not be read, so the saving is not estimated."
            ),
        }
    elif verdict["verdict"] == IDLE:
        action = "review_for_deletion"
        savings = {
            "monthly": monthly_cost,
            "annual": annual_cost,
            "basis": "full_compute_cost" if monthly_cost is not None else "cost_unavailable",
            "note": (
                "Shown as the full cost of the VM because the recommendation is to "
                "remove it. Confirm it is genuinely unused before acting."
                if monthly_cost is not None else
                "This VM looks idle, but its cost could not be read, so no saving "
                "is claimed."
            ),
        }
    elif verdict["verdict"] == UNDERUTILIZED:
        target = smaller_sku(sku)
        if target:
            action = "resize"
            savings = estimate_savings(monthly_cost, sku, target, price_lookup)
        else:
            action = "review"
            savings["note"] = (
                f"{sku} has no predictable smaller sibling, so no specific resize is "
                "proposed. A human should choose the target size."
            )
    elif verdict["verdict"] == OVERUTILIZED:
        action = "investigate"

    cpu = metrics.get("Percentage CPU") or {}
    telemetry_state = verdict.get("telemetry", TELEMETRY_OK)
    signal_map = signals(metrics)
    caps = capabilities or am.capabilities_from([])
    # Note `capabilities`, not `caps`: an absent catalogue must stay absent
    # here. `capabilities_from([])` is all-False, which would let a VM whose
    # definitions were never read report every metric as "Not published".
    annotate_signals(signal_map, capabilities, telemetry_state)

    operational = operational_status(vm.get("power_state") or "")
    utilization = utilization_status(telemetry_state, signal_map)
    rightsizing = _rightsizing_from(verdict["verdict"], telemetry_state)
    confidence = confidence_for(
        rightsizing,
        telemetry_state,
        verdict.get("coverage"),
        priced=(savings.get("monthly") is not None),
    )

    # Why right-sizing could not be answered, written for someone who now has
    # to go and fix it rather than for someone reading a dashboard.
    if rightsizing == RS_CANNOT_DETERMINE:
        if telemetry_state == TELEMETRY_UNSUPPORTED:
            rs_reason = "Percentage CPU telemetry is unavailable for this resource."
            rs_action = (
                "Verify Azure Monitor metric availability for this VM. Platform CPU "
                "metrics normally require no agent, so an absent one usually means "
                "the VM was recently created or its diagnostic settings were changed."
            )
        elif telemetry_state == TELEMETRY_PERMISSION:
            rs_reason = "Azure Monitor access was denied for this resource."
            rs_action = "Grant Monitoring Reader on this VM or its resource group."
        elif telemetry_state == TELEMETRY_THROTTLED:
            rs_reason = "Azure Monitor throttled the request, so the window is incomplete."
            rs_action = "Refresh the fleet in a few minutes."
        elif telemetry_state == TELEMETRY_INSUFFICIENT:
            rs_reason = "Too little CPU history to judge a resize safely."
            rs_action = "Wait until the VM has accumulated a fuller 30-day history."
        else:
            rs_reason = "Required CPU telemetry is unavailable."
            rs_action = "Check Azure Monitor metric availability and permissions."
    else:
        rs_reason = verdict["reason"]
        rs_action = ACTION_SENTENCE.get(action, "")

    return {
        "id": vm.get("id"),
        "resource_id": vm.get("id"),
        "name": vm.get("name"),
        "sku": sku,
        "region": vm.get("region"),
        "resource_group": vm.get("resource_group"),
        "subscription_id": vm.get("subscription_id"),
        "power_state": power_label(vm.get("power_state")),
        "os_type": vm.get("os_type") or None,

        # Kept flat as well as nested: the table sorts on these directly.
        "monthly_cost": monthly_cost,
        "annual_cost": annual_cost,
        "cost": {
            "monthly": monthly_cost,
            "annualized": annual_cost,
            "currency": vm.get("currency"),
            "share_of_fleet": None,          # filled by `summarise_fleet`
            "share_of_subscription": None,
        },

        "verdict": verdict["verdict"],
        "verdict_label": VERDICT_LABEL[verdict["verdict"]],
        "severity": verdict["severity"],
        "confident": verdict["confident"],
        "reason": verdict["reason"],

        # The four independent answers. A machine can be definitely running and
        # definitely expensive while being genuinely unsizeable, and one field
        # cannot say that.
        "operational": {
            "status": operational,
            "label": OPERATIONAL_LABEL[operational],
        },
        "utilization": {
            "status": utilization,
            "label": UTILIZATION_LABEL[utilization],
            "signals": signal_map,
            "cpu": {
                "average": verdict["cpu_avg"],
                "p95": verdict["cpu_p95"],
                "p99": verdict.get("cpu_p99"),
                "peak": verdict.get("cpu_max"),
                "min": verdict.get("cpu_min"),
            },
        },
        "right_sizing": {
            "status": rightsizing,
            "label": RIGHTSIZING_LABEL[rightsizing],
            "confidence": confidence,
            "recommendation": target,
            "reason": rs_reason,
            "recommended_action": rs_action,
        },

        "cpu_p95": verdict["cpu_p95"],
        "cpu_p99": verdict.get("cpu_p99"),
        "cpu_max": verdict.get("cpu_max"),
        "cpu_avg": verdict["cpu_avg"],
        "cpu_min": verdict.get("cpu_min"),
        "memory_headroom": verdict["memory_headroom"],
        "recommended_sku": target,
        "action": action,
        "savings": savings,

        # Why a CPU column is empty, in a form the UI can turn into a sentence
        # rather than guessing from a null.
        "telemetry": {
            "metric": "Percentage CPU",
            "status": telemetry_state,
            "state": telemetry_state,       # retained: the table switches on it
            "label": TELEMETRY_LABEL.get(telemetry_state, ""),
            "reason": verdict["reason"],
            "observed_points": verdict.get("points") or 0,
            "expected_points": verdict.get("expected_points"),
            "coverage": verdict.get("coverage"),
            "first_observed": verdict.get("first_observed"),
            "last_observed": verdict.get("last_observed"),
            "unit": cpu.get("unit") or "Percent",
            "capabilities": caps,
            "available_metrics": caps.get("available_metrics") or [],
        },
        "diagnostics": diagnostics or {},
        # Kept at the top level too: several callers and tests read it here.
        "metric_points": verdict.get("points") or 0,
    }


def summarise_fleet(analyses: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Fleet totals, and — as a side effect — each VM's share of the fleet cost.

    Two rules govern the savings figures.

    Only `HIGH` confidence contributes to `confident_monthly_savings`, which is
    the number the headline shows. A finding that rests on partial telemetry or
    an unpriced SKU is still listed on its row, because it is a real finding,
    but it is not added to a total somebody will treat as committed.

    A savings total of zero is returned as `None`, not `0`. "₹0" asserts that
    the fleet was examined and found perfect; `None` says no high-confidence
    opportunity was identified, which on a fleet of mostly deallocated or
    unmeasurable machines is the truthful answer.
    """
    by_verdict: Dict[str, int] = {}
    by_operational: Dict[str, int] = {}
    by_rightsizing: Dict[str, int] = {}
    by_telemetry: Dict[str, int] = {}

    total_savings = 0.0
    confident_savings = 0.0
    priced = 0

    fleet_cost = sum(
        (i.get("monthly_cost") or 0.0) for i in analyses
        if isinstance(i.get("monthly_cost"), (int, float))
    )

    for item in analyses:
        by_verdict[item["verdict"]] = by_verdict.get(item["verdict"], 0) + 1

        op = (item.get("operational") or {}).get("status") or OP_UNKNOWN
        by_operational[op] = by_operational.get(op, 0) + 1

        rs = (item.get("right_sizing") or {}).get("status") or RS_CANNOT_DETERMINE
        by_rightsizing[rs] = by_rightsizing.get(rs, 0) + 1

        tel = (item.get("telemetry") or {}).get("status") or TELEMETRY_OK
        by_telemetry[tel] = by_telemetry.get(tel, 0) + 1

        # Each VM's share of what the fleet costs. Needs no telemetry, so it
        # works for exactly the machines that have none.
        cost_block = item.get("cost")
        if isinstance(cost_block, dict) and fleet_cost > 0:
            monthly_cost = item.get("monthly_cost")
            if isinstance(monthly_cost, (int, float)):
                cost_block["share_of_fleet"] = monthly_cost / fleet_cost * 100.0

        monthly = (item.get("savings") or {}).get("monthly")
        if monthly:
            total_savings += monthly
            priced += 1
            if (item.get("right_sizing") or {}).get("confidence") == CONF_HIGH:
                confident_savings += monthly

    # Telemetry that failed for a reason somebody could act on. A deallocated
    # VM is excluded: nothing is wrong with it and nothing needs doing.
    telemetry_issues = sum(
        count for state, count in by_telemetry.items()
        if state not in (TELEMETRY_OK, TELEMETRY_NOT_APPLICABLE)
    )
    assessed = sum(
        count for state, count in by_telemetry.items()
        if state in (TELEMETRY_OK, TELEMETRY_NOT_APPLICABLE)
    )

    # `assessed` above answers "how many machines did we reach a conclusion
    # about", which is useful but conflates two very different reasons for
    # being conclusive. A deallocated VM is settled because it is provably
    # off; a running VM is settled because we measured it. Reporting them as
    # one number invites the reader to believe eight machines were examined
    # for CPU when in fact eight were merely confirmed switched off. These
    # three counts partition the fleet so the distinction survives.
    verifiably_off = by_telemetry.get(TELEMETRY_NOT_APPLICABLE, 0)
    telemetry_measured = (
        by_telemetry.get(TELEMETRY_OK, 0) + by_telemetry.get(TELEMETRY_PARTIAL, 0)
    )
    telemetry_unavailable = len(analyses) - verifiably_off - telemetry_measured

    opportunities = sum(
        count for status, count in by_rightsizing.items()
        if status in (RS_OVERSIZED, RS_IDLE, RS_DEALLOCATE)
    )

    return {
        "total": len(analyses),
        "assessed": assessed,
        "verifiably_off": verifiably_off,
        "telemetry_measured": telemetry_measured,
        "telemetry_unavailable": telemetry_unavailable,
        "by_verdict": by_verdict,
        "by_operational": by_operational,
        "by_rightsizing": by_rightsizing,
        "by_telemetry": by_telemetry,
        "running": by_operational.get(OP_RUNNING, 0),
        "deallocated": by_operational.get(OP_DEALLOCATED, 0),
        "stopped": by_operational.get(OP_STOPPED, 0),
        "telemetry_issues": telemetry_issues,
        "rightsizing_opportunities": opportunities,
        "fleet_monthly_cost": fleet_cost or None,
        "fleet_annual_cost": (fleet_cost * 12) if fleet_cost else None,
        # None rather than 0.0 — see the docstring.
        "monthly_savings": total_savings or None,
        "annual_savings": (total_savings * 12) if total_savings else None,
        "confident_monthly_savings": confident_savings or None,
        "confident_annual_savings": (confident_savings * 12) if confident_savings else None,
        "priced_recommendations": priced,
        "unpriced_recommendations": sum(
            1 for i in analyses
            if i.get("action") not in ("none",) and not (i.get("savings") or {}).get("monthly")
        ),
        "no_opportunity_note": (
            None if confident_savings else
            "No high-confidence optimization opportunity identified."
        ),
        "note": (
            "Savings are only counted where a published price for both the current "
            "and the proposed size could be read, and only where the evidence is "
            "high confidence. Everything else is listed but contributes nothing to "
            "these totals."
        ),
    }


def sort_key(item: Dict[str, Any]):
    """
    Worst verdict first, then by the money at stake.

    Within a verdict the tie-break is the saving on offer, falling back to what
    the VM costs. A fleet where nothing is priced would otherwise sort
    alphabetically, burying the expensive machines among the trivial ones.
    """
    order = VERDICT_ORDER.index(item["verdict"]) if item["verdict"] in VERDICT_ORDER else 99
    monthly = (item.get("savings") or {}).get("monthly") or 0.0
    cost = item.get("monthly_cost") or 0.0
    return (order, -monthly, -cost, item.get("name") or "")

import aiosqlite
import os
from core.config import settings

DB_PATH = settings.DB_PATH

_SCHEMAS = {
    "users": """
        CREATE TABLE IF NOT EXISTS users (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            azure_oid       TEXT    NOT NULL UNIQUE,
            email           TEXT    NOT NULL DEFAULT '',
            name            TEXT    NOT NULL DEFAULT '',
            azure_tenant_id TEXT    NOT NULL DEFAULT '',
            role            TEXT    NOT NULL DEFAULT 'user',
            status          TEXT    NOT NULL DEFAULT 'active',            -- The workspace this person reads. NULL means they are their own
            -- owner. A team member carries their owner's id, which is what
            -- makes them see the owner's connected tenants instead of an
            -- empty account.
            owner_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
            -- Contact number for the account. Entra sign-in tokens do not
            -- carry one, so this is only ever what the person typed in.
            phone           TEXT    NOT NULL DEFAULT '',
            -- Likewise the employer. Entra has a company name field, but we
            -- do not hold the directory consent to read it, and inferring it
            -- from the email domain would be a guess printed as a fact.
            company         TEXT    NOT NULL DEFAULT '',
            -- When this person agreed to us keeping the details above and a
            -- record of their sessions. NULL means they have not, and nothing
            -- optional may be stored until they do.
            profile_consent_at TEXT,
            login_count     INTEGER NOT NULL DEFAULT 0,
            -- What this person may do inside the workspace they were added to.
            -- Deliberately separate from `role` above: that one is the
            -- platform-wide flag that opens the Admin Centre over every
            -- account on the server. Conflating the two would mean granting
            -- someone "admin of my workspace" and accidentally handing them
            -- everybody else's.
            workspace_role  TEXT    NOT NULL DEFAULT 'user',
            created_at      TEXT    DEFAULT (CURRENT_TIMESTAMP),
            last_login_at   TEXT
        )
    """,
    # When each person was signed in, and when they stopped.
    #
    # This is the record behind "who was using the app, and when". It is
    # deliberately thin. There is no page-by-page trail, because the stated
    # purpose is account security and support -- "was that sign-in me?" -- and
    # anything beyond what that question needs would be collected without a
    # purpose, which is the thing data-protection law actually prohibits.
    #
    # The address is stored as a keyed hash, never in the clear. It is still
    # personal data, so this is not anonymisation; it is pseudonymisation, and
    # it means a leak of this table does not hand anyone a list of the places
    # our customers work from, while still letting somebody recognise "this is
    # the same network as last time".
    #
    # `ended_at` NULL means the session is open. A session that is never
    # closed -- browser shut, laptop lid down -- stays open, so `last_seen_at`
    # is what any honest "still active" answer has to be based on.
    "user_sessions": """
        CREATE TABLE IF NOT EXISTS user_sessions (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            started_at    TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            last_seen_at  TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            ended_at      TEXT,
            -- Truncated: enough to say "Chrome on Windows", not enough to be
            -- a fingerprint.
            user_agent    TEXT    NOT NULL DEFAULT '',
            ip_hash       TEXT    NOT NULL DEFAULT ''
        )
    """,

    # People an owner has invited into their workspace. The row is created
    # before the invitee has ever signed in, so it is keyed by email rather
    # than by user id, and holds the Entra tenant the invite was issued from.
    # Acceptance re-checks that tenant against the token, so an invitation
    # cannot be redeemed by someone outside the owner's directory even if the
    # email address is guessed or forwarded.
    "team_invitations": """
        CREATE TABLE IF NOT EXISTS team_invitations (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            email            TEXT    NOT NULL,
            azure_tenant_id  TEXT    NOT NULL DEFAULT '',
            -- The role the person is being given, chosen when they are added
            -- and carried onto their account when they first sign in.
            role             TEXT    NOT NULL DEFAULT 'user',
            status           TEXT    NOT NULL DEFAULT 'pending',
            created_at       TEXT    DEFAULT (CURRENT_TIMESTAMP),
            accepted_at      TEXT,
            accepted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            UNIQUE (owner_id, email)
        )
    """,
    "service_principals": """
        CREATE TABLE IF NOT EXISTS service_principals (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
            tenant_id     TEXT    NOT NULL,
            tenant_name   TEXT    NOT NULL,
            client_id     TEXT    NOT NULL,
            client_secret TEXT    NOT NULL,
            created_at    TEXT    DEFAULT (CURRENT_TIMESTAMP),
            UNIQUE (user_id, tenant_id)
        )
    """,
    "session_tokens": """
        CREATE TABLE IF NOT EXISTS session_tokens (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
            tenant_id    TEXT    NOT NULL,
            tenant_name  TEXT    NOT NULL,
            access_token TEXT    NOT NULL,
            expires_at   TEXT,
            account      TEXT,
            created_at   TEXT    DEFAULT (CURRENT_TIMESTAMP),
            UNIQUE (user_id, tenant_id)
        )
    """,
    # Endpoints and models a customer brings themselves: their own OpenAI or
    # Azure OpenAI deployment, a gateway, or a webhook. Scoped to the owner so
    # one customer's key is never reachable by another.
    "user_integrations": """
        CREATE TABLE IF NOT EXISTS user_integrations (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            label      TEXT    NOT NULL,
            kind       TEXT    NOT NULL DEFAULT 'openai',
            base_url   TEXT    NOT NULL DEFAULT '',
            model      TEXT    NOT NULL DEFAULT '',
            api_key    TEXT    NOT NULL DEFAULT '',
            enabled    INTEGER NOT NULL DEFAULT 1,
            -- The ceiling the customer sets when they register the endpoint,
            -- in requests per day. It exists because the key is theirs and so
            -- is the bill: a runaway loop against an unmetered endpoint is a
            -- charge they only discover afterwards. 0 means "not set yet",
            -- which the API refuses to create.
            rate_limit_per_day INTEGER NOT NULL DEFAULT 0,
            created_at TEXT    DEFAULT (CURRENT_TIMESTAMP),
            UNIQUE (user_id, label)
        )
    """,
    # One row per endpoint per day, incremented before the call goes out.
    # Counting before rather than after means a request that fails upstream
    # still costs a unit of the allowance, which is the safe direction: the
    # provider may well have billed for it.
    "integration_usage": """
        CREATE TABLE IF NOT EXISTS integration_usage (
            integration_id INTEGER NOT NULL REFERENCES user_integrations(id) ON DELETE CASCADE,
            day            TEXT    NOT NULL,
            calls          INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (integration_id, day)
        )
    """,
    # What the assistant was asked to build, and what Azure did about it.
    # Kept because a deployment is a spend: the person who authorised it, what
    # they authorised and how it ended have to survive a browser refresh.
    "provision_deployments": """
        CREATE TABLE IF NOT EXISTS provision_deployments (
            id              TEXT    PRIMARY KEY,
            account_id      INTEGER NOT NULL,
            actor_id        INTEGER,
            tenant_id       TEXT    NOT NULL DEFAULT '',
            subscription_id TEXT    NOT NULL DEFAULT '',
            resource_group  TEXT    NOT NULL DEFAULT '',
            location        TEXT    NOT NULL DEFAULT '',
            deployment_name TEXT    NOT NULL DEFAULT '',
            spec_json       TEXT    NOT NULL DEFAULT '[]',
            state           TEXT    NOT NULL DEFAULT 'VALIDATING',
            message         TEXT    NOT NULL DEFAULT '',
            resources_json  TEXT    NOT NULL DEFAULT '[]',
            estimated_monthly REAL,
            currency        TEXT    NOT NULL DEFAULT '',
            created_at      TEXT    DEFAULT (CURRENT_TIMESTAMP),
            finished_at     TEXT
        )
    """,
    # A point-in-time capture of one tenant's estate. Every visibility feature
    # that answers "what did this look like then" or "what changed" reads from
    # here rather than from Azure, because Azure only ever reports *now*.
    "scans": """
        CREATE TABLE IF NOT EXISTS scans (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            tenant_id      TEXT    NOT NULL,
            status         TEXT    NOT NULL DEFAULT 'running',
            started_at     TEXT    DEFAULT (CURRENT_TIMESTAMP),
            finished_at    TEXT,
            resource_count INTEGER NOT NULL DEFAULT 0,
            error          TEXT
        )
    """,
    # Resources as they existed in one scan.
    #
    # Rows are never updated. A resource that changes produces a new row in the
    # next scan and the old one stays exactly as captured — that immutability is
    # what makes point-in-time browsing and change tracking possible at all.
    "scan_resources": """
        CREATE TABLE IF NOT EXISTS scan_resources (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_id         INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
            resource_id     TEXT    NOT NULL,
            name            TEXT    NOT NULL DEFAULT '',
            name_lower      TEXT    NOT NULL DEFAULT '',
            type            TEXT    NOT NULL DEFAULT '',
            resource_group  TEXT    NOT NULL DEFAULT '',
            subscription_id TEXT    NOT NULL DEFAULT '',
            location        TEXT    NOT NULL DEFAULT '',
            sku             TEXT    NOT NULL DEFAULT '',
            tags            TEXT    NOT NULL DEFAULT '{}',
            -- The provider's own configuration bag, verbatim, as JSON.
            --
            -- Empty when the resource has none, when Azure returned something
            -- unparseable, or when the bag was too large to be worth keeping
            -- (see scanner.MAX_PROPERTIES_CHARS). Empty therefore means "not
            -- captured", which is why a diff must never read it as "became
            -- empty" and report every property as deleted.
            properties      TEXT    NOT NULL DEFAULT ''
        )
    """,
    # A change the owner has decided is not worth seeing again.
    #
    # Change tracking is only useful if the list is short enough to read. A
    # deployment pipeline that rewrites the same tag every night will bury
    # everything else within a week, so there has to be a way to say "this one
    # is expected" without switching the whole feature off.
    #
    # Ignoring hides, it never deletes: the underlying snapshots are untouched
    # and the rule can be lifted, because an audit that cannot see what was
    # suppressed is not an audit.
    "change_ignores": """
        CREATE TABLE IF NOT EXISTS change_ignores (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            tenant_id   TEXT    NOT NULL,
            resource_id TEXT    NOT NULL,
            field       TEXT    NOT NULL DEFAULT '',
            note        TEXT    NOT NULL DEFAULT '',
            created_by  TEXT    NOT NULL DEFAULT '',
            created_at  TEXT    DEFAULT (CURRENT_TIMESTAMP),
            UNIQUE (user_id, tenant_id, resource_id, field)
        )
    """,
    # An access finding, or a whole principal, that the owner has reviewed and
    # accepted.
    #
    # An access review is only completed if it can be finished. A break-glass
    # account is meant to be unused; a quarterly billing job is meant to look
    # dormant for eighty-nine days. Without somewhere to record "we looked at
    # this and it is fine", the same false positives are re-read by a different
    # person every quarter and the real findings are the ones that get skipped.
    #
    # `finding_key` empty means the whole principal is accepted -- the "Hide
    # Principal" action -- and a specific key accepts one finding about it. The
    # note is kept because an acceptance without a reason is worthless to the
    # next reviewer, and hidden findings are always counted and can always be
    # shown again.
    "access_ignores": """
        CREATE TABLE IF NOT EXISTS access_ignores (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            tenant_id    TEXT    NOT NULL,
            principal_id TEXT    NOT NULL,
            finding_key  TEXT    NOT NULL DEFAULT '',
            note         TEXT    NOT NULL DEFAULT '',
            created_by   TEXT    NOT NULL DEFAULT '',
            created_at   TEXT    DEFAULT (CURRENT_TIMESTAMP),
            UNIQUE (user_id, tenant_id, principal_id, finding_key)
        )
    """,
    # Every published price this app has ever read from Microsoft, kept verbatim.
    #
    # The Retail Prices API only ever reports *today's* price. It has no history
    # endpoint, so the question "did Microsoft put this meter up?" is
    # unanswerable unless we wrote down what it said last time. Once the reading
    # is lost it cannot be recovered from Microsoft at any later date, which is
    # why the whole response body is retained rather than the fields we happen to
    # display today.
    #
    # Not scoped to a user: a list price is public and identical for everyone, so
    # partitioning it per account would multiply identical rows and, worse, leave
    # each account with a history that only starts when they first looked.
    "price_snapshots": """
        CREATE TABLE IF NOT EXISTS price_snapshots (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            meter_id        TEXT    NOT NULL DEFAULT '',
            sku_id          TEXT    NOT NULL DEFAULT '',
            product_id      TEXT    NOT NULL DEFAULT '',
            service_name    TEXT    NOT NULL DEFAULT '',
            product_name    TEXT    NOT NULL DEFAULT '',
            sku_name        TEXT    NOT NULL DEFAULT '',
            arm_sku_name    TEXT    NOT NULL DEFAULT '',
            meter_name      TEXT    NOT NULL DEFAULT '',
            arm_region      TEXT    NOT NULL DEFAULT '',
            currency        TEXT    NOT NULL DEFAULT 'USD',
            price_type      TEXT    NOT NULL DEFAULT '',
            unit_of_measure TEXT    NOT NULL DEFAULT '',
            retail_price    REAL,
            unit_price      REAL,
            effective_from  TEXT    NOT NULL DEFAULT '',
            observed_at     TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            raw             TEXT    NOT NULL DEFAULT '{}'
        )
    """,
    # A price that moved, and by how much.
    #
    # Derivable from price_snapshots, but only by scanning every reading of a
    # meter and diffing them. Changes are rare and reads are frequent, so the
    # rare event is materialised once at write time instead of recomputed on
    # every view.
    "price_changes": """
        CREATE TABLE IF NOT EXISTS price_changes (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            meter_id       TEXT    NOT NULL DEFAULT '',
            currency       TEXT    NOT NULL DEFAULT 'USD',
            price_type     TEXT    NOT NULL DEFAULT '',
            service_name   TEXT    NOT NULL DEFAULT '',
            meter_name     TEXT    NOT NULL DEFAULT '',
            arm_region     TEXT    NOT NULL DEFAULT '',
            old_price      REAL,
            new_price      REAL,
            direction      TEXT    NOT NULL DEFAULT 'flat',
            percent        REAL,
            previous_at    TEXT    NOT NULL DEFAULT '',
            changed_at     TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            effective_from TEXT    NOT NULL DEFAULT ''
        )
    """,
    # Daily exchange rates.
    #
    # Microsoft publishes every Azure price in USD and converts for display only.
    # So when a rupee unit rate moves and the dollar rate did not, the exchange
    # rate is the explanation — and proving that needs the rate on the specific
    # days either side, not a monthly average, because a bill is converted at
    # rates that move daily.
    "fx_rates": """
        CREATE TABLE IF NOT EXISTS fx_rates (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            base     TEXT NOT NULL DEFAULT 'USD',
            quote    TEXT NOT NULL,
            rate_day TEXT NOT NULL,
            rate     REAL NOT NULL,
            source   TEXT NOT NULL DEFAULT '',
            fetched_at TEXT DEFAULT (CURRENT_TIMESTAMP),
            UNIQUE (base, quote, rate_day)
        )
    """,
    # A point-in-time capture of one posture source: Advisor recommendations,
    # Defender findings, policy compliance, or role assignments.
    #
    # None of those APIs has a history endpoint. Ask Defender what changed last
    # month and there is no answer to give, because Azure does not keep one. The
    # only way to ever answer "are we improving" is to have written down what it
    # said the previous time, and a reading not taken cannot be recovered later.
    #
    # The findings are stored as one JSON document rather than a row per finding
    # because they are only ever read whole, to be diffed against another whole
    # snapshot. A normalised table would buy query flexibility nothing here uses
    # and cost a five-figure insert on every scan of a large estate.
    "posture_snapshots": """
        CREATE TABLE IF NOT EXISTS posture_snapshots (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            tenant_id     TEXT    NOT NULL,
            kind          TEXT    NOT NULL,
            captured_at   TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            subscriptions TEXT    NOT NULL DEFAULT '[]',
            finding_count INTEGER NOT NULL DEFAULT 0,
            high_count    INTEGER NOT NULL DEFAULT 0,
            summary       TEXT    NOT NULL DEFAULT '{}',
            findings      TEXT    NOT NULL DEFAULT '[]',
            errors        TEXT    NOT NULL DEFAULT '[]'
        )
    """,

    # The only table in this application that records something the user did to
    # Azure rather than something Azure told us. A resize stops and restarts a
    # real machine, so the row is opened before the first destructive call and
    # updated as each step completes: if the process dies mid-operation the
    # record still shows what was attempted and where it stopped.
    #
    # Prices are nullable on purpose. A resize performed while Azure Retail
    # Prices was unreachable is still a valid audit record; writing 0 would
    # turn a missing rate into a claim that the machine was free.
    "vm_resize_operations": """
        CREATE TABLE IF NOT EXISTS vm_resize_operations (
            id                       INTEGER PRIMARY KEY AUTOINCREMENT,
            operation_id             TEXT    NOT NULL UNIQUE,
            user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            tenant_id                TEXT    NOT NULL,
            subscription_id          TEXT    NOT NULL DEFAULT '',
            resource_id              TEXT    NOT NULL,
            vm_name                  TEXT    NOT NULL DEFAULT '',
            region                   TEXT    NOT NULL DEFAULT '',
            old_sku                  TEXT    NOT NULL DEFAULT '',
            new_sku                  TEXT    NOT NULL DEFAULT '',
            old_power_state          TEXT    NOT NULL DEFAULT '',
            final_power_state        TEXT    NOT NULL DEFAULT '',
            old_monthly_price        REAL,
            new_monthly_price        REAL,
            estimated_monthly_saving REAL,
            currency                 TEXT    NOT NULL DEFAULT 'USD',
            state                    TEXT    NOT NULL DEFAULT 'VALIDATING',
            steps                    TEXT    NOT NULL DEFAULT '[]',
            azure_operation_id       TEXT    NOT NULL DEFAULT '',
            failure_reason           TEXT    NOT NULL DEFAULT '',
            created_at               TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            updated_at               TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            completed_at             TEXT
        )
    """,

    # Everything this application has changed about who can reach Azure.
    #
    # The row is written whether the change succeeded or failed, and a failure
    # is the more interesting record of the two: a refused attempt to grant
    # somebody Owner is exactly what an investigation later needs to find. That
    # is why `result` exists rather than only successful rows being kept.
    #
    # `previous_state` and `new_state` are stored as text rather than as ids so
    # the record stays readable after the role, the principal or the whole
    # subscription has been deleted from Azure. An audit trail that can only be
    # interpreted by calling the system it audits is not an audit trail.
    #
    # user_id and tenant_id are both NOT NULL and always appear together in the
    # WHERE clause, matching posture_snapshots. A history query that forgot
    # either one would show one customer another customer's administration.
    "security_audit": """
        CREATE TABLE IF NOT EXISTS security_audit (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id        TEXT    NOT NULL UNIQUE,
            user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            tenant_id       TEXT    NOT NULL,
            actor_name      TEXT    NOT NULL DEFAULT '',
            actor_email     TEXT    NOT NULL DEFAULT '',
            action          TEXT    NOT NULL,
            subscription_id TEXT    NOT NULL DEFAULT '',
            scope           TEXT    NOT NULL DEFAULT '',
            target_id       TEXT    NOT NULL DEFAULT '',
            target_name     TEXT    NOT NULL DEFAULT '',
            target_kind     TEXT    NOT NULL DEFAULT '',
            previous_state  TEXT    NOT NULL DEFAULT '',
            new_state       TEXT    NOT NULL DEFAULT '',
            result          TEXT    NOT NULL DEFAULT 'pending',
            failure_reason  TEXT    NOT NULL DEFAULT '',
            azure_operation TEXT    NOT NULL DEFAULT '',
            detail          TEXT    NOT NULL DEFAULT '{}',
            created_at      TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            completed_at    TEXT
        )
    """,
    # Every change this application makes to Azure, in one table.
    #
    # The three write features that came before this one each grew their own
    # record: `vm_resize_operations`, `security_audit`, `provision_deployments`.
    # That was reasonable for the first of them and is not reasonable for the
    # fourth: it means a new action cannot be added without a schema change,
    # and it means the question "what has this workspace changed in Azure?"
    # has to be asked three times and merged. This table is the answer to that
    # question for every action added from here on.
    #
    # `state` is opened before the Azure call and closed after it, so a process
    # that dies mid-flight still leaves a row saying what was attempted. A
    # failure is kept, not deleted -- a refused attempt to delete a production
    # disk is exactly the record an investigation needs.
    #
    # `idempotency_key` is what makes a retried request safe. It is unique per
    # workspace rather than globally, because two customers picking the same
    # key is a coincidence, not a duplicate.
    #
    # `actor_id` is the person and `user_id` is the workspace that owns the
    # tenant. Both are kept: attributing a team member's deletion to the owner
    # would make the trail useless for exactly the case it exists for.
    #
    # Request and state columns hold JSON text rather than ids so the row stays
    # readable after the resource it describes has been deleted from Azure --
    # which, for a delete action, is always.
    "resource_actions": """
        CREATE TABLE IF NOT EXISTS resource_actions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            action_id       TEXT    NOT NULL UNIQUE,
            idempotency_key TEXT,
            user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            actor_id        INTEGER,
            actor_name      TEXT    NOT NULL DEFAULT '',
            actor_email     TEXT    NOT NULL DEFAULT '',
            tenant_id       TEXT    NOT NULL,
            action          TEXT    NOT NULL,
            subscription_id TEXT    NOT NULL DEFAULT '',
            resource_id     TEXT    NOT NULL DEFAULT '',
            resource_name   TEXT    NOT NULL DEFAULT '',
            resource_kind   TEXT    NOT NULL DEFAULT '',
            request         TEXT    NOT NULL DEFAULT '{}',
            previous_state  TEXT    NOT NULL DEFAULT '{}',
            new_state       TEXT    NOT NULL DEFAULT '{}',
            state           TEXT    NOT NULL DEFAULT 'PENDING',
            azure_operation TEXT    NOT NULL DEFAULT '',
            failure_reason  TEXT    NOT NULL DEFAULT '',
            created_at      TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            updated_at      TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            completed_at    TEXT
        )
    """,
    "anomaly_tracking": """
        CREATE TABLE IF NOT EXISTS anomaly_tracking (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            -- The fingerprint of a cost change, not a row id: anomalies are
            -- recomputed from billing data on every request and have no
            -- identity of their own. Derived from tenant, subscription,
            -- service, resource and period so the same change keeps the same
            -- status when the page is reloaded.
            anomaly_key     TEXT    NOT NULL,
            user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            tenant_id       TEXT    NOT NULL,
            subscription_id TEXT    NOT NULL DEFAULT '',
            service         TEXT    NOT NULL DEFAULT '',
            resource_name   TEXT    NOT NULL DEFAULT '',
            period          TEXT    NOT NULL DEFAULT '',
            status          TEXT    NOT NULL DEFAULT 'new',
            updated_at      TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            UNIQUE (tenant_id, user_id, anomaly_key)
        )
    """,
    "anomaly_events": """
        CREATE TABLE IF NOT EXISTS anomaly_events (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            anomaly_key     TEXT    NOT NULL,
            user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            tenant_id       TEXT    NOT NULL,
            actor_name      TEXT    NOT NULL DEFAULT '',
            actor_email     TEXT    NOT NULL DEFAULT '',
            previous_status TEXT    NOT NULL DEFAULT '',
            new_status      TEXT    NOT NULL DEFAULT '',
            comment         TEXT    NOT NULL DEFAULT '',
            created_at      TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        )
    """,
    # Cost Management responses, kept because re-asking is the expensive part.
    #
    # The Query API is the most aggressively throttled thing this app touches,
    # and until now it was also the only expensive read with no durable store:
    # the estate lands in scan_resources, list prices land in price_snapshots,
    # but a bill was held in memory and mirrored to a JSON file in the system
    # temp directory. App Service empties that on restart and does not share it
    # between instances, so in the one environment that matters the cache was
    # effectively per-process and per-deploy.
    #
    # `settled` is the column that earns this table. A closed month cannot
    # change, so once Azure has stopped amending a window there is no such
    # thing as a stale answer for it and the row can be kept for as long as
    # there is room. Re-fetching immutable history every ten minutes is what
    # was spending the rate limit.
    "cost_cache": """
        CREATE TABLE IF NOT EXISTS cost_cache (
            cache_key  TEXT    NOT NULL PRIMARY KEY,
            scope      TEXT    NOT NULL DEFAULT '',
            period_to  TEXT    NOT NULL DEFAULT '',
            payload    TEXT    NOT NULL DEFAULT '[]',
            settled    INTEGER NOT NULL DEFAULT 0,
            stored_at  REAL    NOT NULL DEFAULT 0,
            expires_at REAL    NOT NULL DEFAULT 0
        )
    """,
}

# Search runs against name_lower across every scan the user owns, so without
# these it degrades to a full table scan once a few scans have accumulated.
# Kept out of `_INDEXES` because the table they belong to is created in the
# users block at the top of `init_db`, before that list is applied.
_INDEXES_USER_SESSIONS = [
    # Every read is "this person's sessions, newest first".
    "CREATE INDEX IF NOT EXISTS idx_user_sessions_person "
    "ON user_sessions (user_id, id DESC)",
    # The retention sweep scans by age across everyone.
    "CREATE INDEX IF NOT EXISTS idx_user_sessions_age "
    "ON user_sessions (started_at)",
]

_INDEXES = [
    # Status is always read for one tenant's worth of anomalies at a time, and
    # the history for one anomaly newest-first.
    "CREATE INDEX IF NOT EXISTS idx_anomaly_tracking_owner "
    "ON anomaly_tracking (tenant_id, user_id)",
    "CREATE INDEX IF NOT EXISTS idx_anomaly_events_key "
    "ON anomaly_events (tenant_id, user_id, anomaly_key, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_scans_owner ON scans (user_id, tenant_id, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_scan_resources_scan ON scan_resources (scan_id)",
    "CREATE INDEX IF NOT EXISTS idx_scan_resources_name ON scan_resources (name_lower)",
    "CREATE INDEX IF NOT EXISTS idx_scan_resources_rid ON scan_resources (resource_id)",
    "CREATE INDEX IF NOT EXISTS idx_change_ignores_owner "
    "ON change_ignores (user_id, tenant_id)",
    "CREATE INDEX IF NOT EXISTS idx_access_ignores_owner "
    "ON access_ignores (user_id, tenant_id)",
    # Price lookups are always "this meter, this currency, most recent first":
    # either the latest reading to diff against, or the series to chart.
    "CREATE INDEX IF NOT EXISTS idx_price_snapshots_meter "
    "ON price_snapshots (meter_id, currency, price_type, observed_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_price_snapshots_sku "
    "ON price_snapshots (arm_sku_name, arm_region, currency)",
    "CREATE INDEX IF NOT EXISTS idx_price_changes_meter "
    "ON price_changes (meter_id, currency, changed_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_price_changes_recent ON price_changes (changed_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_fx_rates_day ON fx_rates (base, quote, rate_day)",
    # Posture reads are always "the latest two snapshots of this kind, for this
    # tenant, that I own" — the pair a diff needs.
    "CREATE INDEX IF NOT EXISTS idx_posture_owner "
    "ON posture_snapshots (user_id, tenant_id, kind, id DESC)",
    # Resize reads are either "my history for this tenant" or "is anything
    # already running against this exact VM" — the duplicate-click guard, which
    # deliberately ignores who started it.
    "CREATE INDEX IF NOT EXISTS idx_resize_owner "
    "ON vm_resize_operations (user_id, tenant_id, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_resize_resource "
    "ON vm_resize_operations (resource_id, id DESC)",
    # Audit reads are always "my history for this tenant, newest first". The
    # ownership columns lead the index because they lead the WHERE clause.
    "CREATE INDEX IF NOT EXISTS idx_security_audit_owner "
    "ON security_audit (user_id, tenant_id, id DESC)",
    # Actions are read three ways: "what has this workspace changed", "is
    # anything already running against this exact resource" (the duplicate
    # guard, which deliberately ignores who started it), and "have I seen this
    # idempotency key before". The last is UNIQUE rather than a plain index:
    # two concurrent retries must collide in the database, not in a check that
    # one of them can win a race against.
    "CREATE INDEX IF NOT EXISTS idx_resource_actions_owner "
    "ON resource_actions (user_id, tenant_id, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_resource_actions_resource "
    "ON resource_actions (resource_id, id DESC)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_actions_idempotency "
    "ON resource_actions (user_id, idempotency_key)",
    # Invitations are read two ways: "who is on my team" and, on every first
    # sign-in, "is there anything pending for this email".
    "CREATE INDEX IF NOT EXISTS idx_invitations_owner "
    "ON team_invitations (owner_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_invitations_email "
    "ON team_invitations (email, status)",
    "CREATE INDEX IF NOT EXISTS idx_users_owner ON users (owner_id)",
    "CREATE INDEX IF NOT EXISTS idx_provision_account ON provision_deployments (account_id, created_at DESC)",
    # Pruning walks the cache oldest-first and evicts unsettled rows before
    # settled ones, because a settled row is the one that saved a real call.
    "CREATE INDEX IF NOT EXISTS idx_cost_cache_evict ON cost_cache (settled, stored_at)",
]


async def _columns(db: aiosqlite.Connection, table: str) -> set[str]:
    async with db.execute(f"PRAGMA table_info({table})") as cursor:
        return {row[1] for row in await cursor.fetchall()}


async def _table_exists(db: aiosqlite.Connection, table: str) -> bool:
    async with db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ) as cursor:
        return await cursor.fetchone() is not None


async def _add_owner_column(db: aiosqlite.Connection, table: str, carried: list[str]):
    """
    Give a credential table a user_id owner and scope its uniqueness to that owner.

    The original schema had UNIQUE(tenant_id), which is wrong the moment more
    than one person uses the app: two customers could not both connect the same
    Azure tenant, and one would silently overwrite the other's credentials.
    SQLite cannot alter a constraint in place, so the table is rebuilt.

    Rows that predate this migration have no owner. They stay NULL and are
    adopted by the first account to sign in, so a single-user installation keeps
    working after the upgrade instead of losing its connected tenants.
    """
    if not await _table_exists(db, table):
        return
    if "user_id" in await _columns(db, table):
        return

    cols = ", ".join(carried)
    await db.execute(f"ALTER TABLE {table} RENAME TO {table}_old")
    await db.execute(_SCHEMAS[table])
    await db.execute(f"INSERT INTO {table} ({cols}) SELECT {cols} FROM {table}_old")
    await db.execute(f"DROP TABLE {table}_old")


async def _add_missing_columns(db: aiosqlite.Connection, table: str, columns: dict[str, str]):
    """
    Add columns to a table that already exists in a deployed database.

    `CREATE TABLE IF NOT EXISTS` silently does nothing when the table is
    already there, so a new column in `_SCHEMAS` never reaches an existing
    install. Every definition here must carry a default, because SQLite cannot
    add a NOT NULL column without one.
    """
    if not await _table_exists(db, table):
        return
    existing = await _columns(db, table)
    for name, definition in columns.items():
        if name not in existing:
            await db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


async def _init_postgres():
    """
    Create the schema on Postgres.

    Notably shorter than the SQLite path, and that is not an oversight. Every
    `_add_missing_columns` and `_add_owner_column` call below exists to repair
    a database file that has been in service since before those columns were
    thought of. A Postgres database starts empty, so there is nothing to
    repair -- carrying those migrations across would be re-enacting the
    history of a file that never existed here.
    """
    import asyncpg  # noqa: F401  (imported so a missing driver fails here, clearly)
    from core import pg, pg_auth

    conn = await pg_auth.connect(settings.DATABASE_URL)
    try:
        for name, ddl in _SCHEMAS.items():
            await conn.execute(pg.translate_schema(ddl))
        for statement in _INDEXES_USER_SESSIONS + _INDEXES:
            await conn.execute(statement)
    finally:
        await conn.close()


async def init_db():
    if settings.DB_BACKEND == "postgres":
        await _init_postgres()
        return

    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await _add_missing_columns(db, "users", {
            "owner_id": "INTEGER REFERENCES users(id)",
            "phone": "TEXT NOT NULL DEFAULT ''",
            "login_count": "INTEGER NOT NULL DEFAULT 0",
            "workspace_role": "TEXT NOT NULL DEFAULT 'user'",
            "company": "TEXT NOT NULL DEFAULT ''",
            "profile_consent_at": "TEXT",
        })
        await db.execute(_SCHEMAS["users"])
        await db.execute(_SCHEMAS["user_sessions"])
        for statement in _INDEXES_USER_SESSIONS:
            await db.execute(statement)
        await db.execute(_SCHEMAS["team_invitations"])
        await _add_missing_columns(
            db, "team_invitations", {"role": "TEXT NOT NULL DEFAULT 'user'"}
        )

        await _add_owner_column(
            db,
            "service_principals",
            ["id", "tenant_id", "tenant_name", "client_id", "client_secret", "created_at"],
        )
        await _add_owner_column(
            db,
            "session_tokens",
            ["id", "tenant_id", "tenant_name", "access_token",
             "expires_at", "account", "created_at"],
        )

        await db.execute(_SCHEMAS["service_principals"])
        await db.execute(_SCHEMAS["session_tokens"])
        await _add_missing_columns(
            db,
            "user_integrations",
            {"rate_limit_per_day": "INTEGER NOT NULL DEFAULT 0"},
        )
        await db.execute(_SCHEMAS["user_integrations"])
        await db.execute(_SCHEMAS["integration_usage"])
        await db.execute(_SCHEMAS["provision_deployments"])
        await db.execute(_SCHEMAS["scans"])
        await db.execute(_SCHEMAS["scan_resources"])
        # Snapshots taken before this column existed have no configuration bag.
        # They stay comparable for the fields they did capture; the deep diff
        # treats a missing bag as "not captured" rather than as "emptied".
        await _add_missing_columns(
            db, "scan_resources", {"properties": "TEXT NOT NULL DEFAULT ''"}
        )
        await db.execute(_SCHEMAS["change_ignores"])
        await db.execute(_SCHEMAS["access_ignores"])
        await db.execute(_SCHEMAS["price_snapshots"])
        await db.execute(_SCHEMAS["price_changes"])
        await db.execute(_SCHEMAS["fx_rates"])
        await db.execute(_SCHEMAS["posture_snapshots"])
        await db.execute(_SCHEMAS["vm_resize_operations"])
        await db.execute(_SCHEMAS["security_audit"])
        await db.execute(_SCHEMAS["resource_actions"])
        await db.execute(_SCHEMAS["anomaly_tracking"])
        await db.execute(_SCHEMAS["anomaly_events"])
        await db.execute(_SCHEMAS["cost_cache"])
        for statement in _INDEXES:
            await db.execute(statement)
        await db.commit()


async def get_db():
    """
    A connection for one request.

    The two backends are deliberately opened and closed per request rather
    than pooled. That is what the SQLite code always did, and changing the
    connection lifetime in the same step as changing the database would mean
    two variables moving at once when something goes wrong.
    """
    if settings.DB_BACKEND == "postgres":
        from core import pg, pg_auth

        raw = await pg_auth.connect(settings.DATABASE_URL)
        try:
            yield pg.Connection(raw)
        finally:
            await raw.close()
        return

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA foreign_keys = ON")
        yield db

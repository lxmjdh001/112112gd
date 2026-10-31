-- Per-company opt-in. No existing client starts uploading content by default.
CREATE TABLE team_supervision_settings (
 tenant_id uuid PRIMARY KEY REFERENCES tenants, enabled boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE team_chat_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, account_id uuid NOT NULL,
 message_id text NOT NULL, customer_id text NOT NULL, customer_name text NOT NULL DEFAULT '',
 direction text NOT NULL CHECK(direction IN ('in','out')), kind text NOT NULL,
 body_cipher text NOT NULL, truncated boolean NOT NULL DEFAULT false,
 occurred_at timestamptz NOT NULL, observed_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,message_id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES platform_accounts(tenant_id,id)
);
CREATE INDEX team_chat_history ON team_chat_messages(tenant_id,account_id,customer_id,occurred_at DESC,id DESC);
CREATE TABLE team_archive_sync (
 tenant_id uuid NOT NULL, account_id uuid PRIMARY KEY, collector_ready boolean NOT NULL DEFAULT false,
 history_scope text NOT NULL CHECK(history_scope IN ('loaded_only','unavailable')),
 limited boolean NOT NULL DEFAULT false, first_sync_at timestamptz NOT NULL DEFAULT now(),last_sync_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,account_id) REFERENCES platform_accounts(tenant_id,id)
);
-- Existing customer notes use 123@lid; client observations use lid:123.
CREATE FUNCTION team_customer_key(platform text,identifier text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN platform='whatsapp' AND identifier ~ '^[0-9]{5,25}@lid$'
 THEN 'lid:'||split_part(identifier,'@',1) ELSE identifier END
$$;
CREATE VIEW team_message_index AS
 SELECT m.id::text AS id,m.tenant_id,m.account_id,COALESCE(alias.customer_id,m.customer_id) AS customer_id,
 m.direction,m.kind,m.body_cipher,''::text AS body,m.customer_name,m.truncated,m.occurred_at AS at,m.observed_at,'client'::text AS source
 FROM team_chat_messages m LEFT JOIN account_customer_aliases alias ON alias.account_id=m.account_id AND alias.tenant_id=m.tenant_id AND alias.alias=m.customer_id
 UNION ALL
 SELECT m.id::text,m.tenant_id,m.number_id,c.customer_id,m.direction,m.kind,''::text,m.body,c.name,false,m.occurred_at,m.created_at,'cloud'::text
 FROM wa_cloud_messages m JOIN wa_cloud_chats c ON c.id=m.chat_id AND c.tenant_id=m.tenant_id AND c.number_id=m.number_id
 WHERE m.direction='in' OR m.status IN ('accepted','sent','delivered','read');
CREATE VIEW team_customer_rollup AS
 WITH inbound AS NOT MATERIALIZED (
  SELECT tenant_id,account_id,customer_id,min(at) AS first_inbound,max(at) AS last_inbound FROM (
   SELECT e.tenant_id,e.account_id,COALESCE(x.customer_id,e.customer_id) AS customer_id,e.occurred_at AS at
   FROM account_inbound_events e LEFT JOIN account_customer_aliases x ON x.tenant_id=e.tenant_id AND x.account_id=e.account_id AND x.alias=e.customer_id
   UNION ALL SELECT tenant_id,account_id,customer_id,at FROM team_message_index WHERE direction='in'
  ) x GROUP BY tenant_id,account_id,customer_id
 ), messages AS NOT MATERIALIZED (
  SELECT tenant_id,account_id,customer_id,min(at) AS first_at,max(at) AS last_at,
  count(*) FILTER(WHERE direction='in') AS inbound,count(*) FILTER(WHERE direction='out') AS outbound,max(NULLIF(customer_name,'')) AS customer_name
  FROM team_message_index GROUP BY tenant_id,account_id,customer_id
 ), keys AS NOT MATERIALIZED (
  SELECT tenant_id,account_id,customer_id FROM inbound
  UNION SELECT tenant_id,account_id,customer_id FROM messages
  UNION SELECT v.tenant_id,v.account_id,COALESCE(x.customer_id,team_customer_key(v.platform,v.identifier)) FROM customer_conversations v LEFT JOIN account_customer_aliases x ON x.tenant_id=v.tenant_id AND x.account_id=v.account_id AND x.alias=team_customer_key(v.platform,v.identifier) WHERE v.identifier<>''
 ), linked AS NOT MATERIALIZED (
  SELECT k.tenant_id,k.account_id,k.customer_id,a.platform,a.label AS account_label,
  CASE WHEN a.connection_type='cloud' THEN COALESCE((SELECT CASE WHEN count(*)=1 THEN min(code_id::text) ELSE '' END FROM wa_cloud_assignments WHERE tenant_id=a.tenant_id AND number_id=a.id),'') ELSE COALESCE(a.code_id::text,'') END AS code_id,
  CASE WHEN a.connection_type='cloud' THEN COALESCE((SELECT string_agg(l.label,' / ' ORDER BY l.label) FROM wa_cloud_assignments x JOIN login_codes l ON l.id=x.code_id AND l.tenant_id=x.tenant_id WHERE x.tenant_id=a.tenant_id AND x.number_id=a.id),'API 未分配') ELSE COALESCE(l.label,'未关联') END AS code_label,
  COALESCE(NULLIF(p.details->>'name',''),names.customer_name,'') AS name,
  LEAST(i.first_inbound,m.first_at) AS first_at,GREATEST(i.last_inbound,m.last_at) AS last_at,i.first_inbound,
  COALESCE(m.inbound,0) AS inbound,COALESCE(m.outbound,0) AS outbound,s.last_sync_at,s.collector_ready,s.limited,a.connection_type
  FROM keys k JOIN platform_accounts a ON a.id=k.account_id AND a.tenant_id=k.tenant_id
  LEFT JOIN login_codes l ON l.id=a.code_id AND l.tenant_id=a.tenant_id
  LEFT JOIN LATERAL (SELECT cp.details FROM customer_profiles cp WHERE cp.tenant_id=k.tenant_id AND cp.platform=a.platform AND (team_customer_key(cp.platform,cp.identifier)=k.customer_id OR EXISTS(SELECT 1 FROM account_customer_aliases x WHERE x.tenant_id=k.tenant_id AND x.account_id=k.account_id AND x.alias=team_customer_key(cp.platform,cp.identifier) AND x.customer_id=k.customer_id)) ORDER BY (team_customer_key(cp.platform,cp.identifier)=k.customer_id) DESC,cp.updated_at DESC LIMIT 1) p ON true
  LEFT JOIN LATERAL (SELECT mi.customer_name FROM team_message_index mi WHERE mi.tenant_id=k.tenant_id AND mi.account_id=k.account_id AND mi.customer_id=k.customer_id AND mi.customer_name<>'' ORDER BY mi.observed_at DESC,mi.id DESC LIMIT 1) names ON true
  LEFT JOIN inbound i ON i.tenant_id=k.tenant_id AND i.account_id=k.account_id AND i.customer_id=k.customer_id
  LEFT JOIN messages m ON m.tenant_id=k.tenant_id AND m.account_id=k.account_id AND m.customer_id=k.customer_id
  LEFT JOIN team_archive_sync s ON s.tenant_id=k.tenant_id AND s.account_id=k.account_id
 ) SELECT * FROM linked
 UNION ALL
 SELECT p.tenant_id,NULL::uuid,team_customer_key(p.platform,p.identifier),p.platform,''::text,''::text,'未关联'::text,COALESCE(p.details->>'name',''),NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,0::bigint,0::bigint,NULL::timestamptz,NULL::boolean,NULL::boolean,'unassigned'::text
 FROM customer_profiles p WHERE NOT EXISTS(SELECT 1 FROM linked l WHERE l.tenant_id=p.tenant_id AND l.platform=p.platform AND (l.customer_id=team_customer_key(p.platform,p.identifier) OR EXISTS(SELECT 1 FROM account_customer_aliases x WHERE x.tenant_id=p.tenant_id AND x.account_id=l.account_id AND x.alias=team_customer_key(p.platform,p.identifier) AND x.customer_id=l.customer_id)));
